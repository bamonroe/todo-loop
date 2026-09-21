/**
 * Verification for a planning round, answered entirely by tooling.
 *
 * An act is judged by a model because "does this diff do what the task asked"
 * has no mechanical answer. A planning round is different: everything that can
 * go wrong with one is a fact about the store and the diff. No model is asked,
 * nothing leaves the machine, and the check costs nothing.
 *
 * Note the symmetry with src/evidence.ts. An act with an empty diff is a hard
 * failure; a planning round with a *non-empty* diff is the same failure
 * inverted. "A plan writes queue entries, not code" is enforced, not requested.
 */

import type { Config } from "./config.ts";
import {
	allowedChildLevels,
	childrenOf,
	depthOf,
	kindOf,
	levelOf,
	parentOf,
	researchBudgetOf,
	type Store,
	type Task,
	unfinishedChildren,
} from "./store.ts";
import type { Verdict } from "./verify.ts";

/** Titles below this read as placeholders rather than work a weak model can act on. */
export const MIN_TITLE_LENGTH = 12;

export interface PlanVerdict extends Verdict {
	/**
	 * The round added nothing and the branch had already delivered something, so
	 * the planner is saying there is no next step. The only way a plan closes.
	 */
	finished?: boolean;
	/**
	 * Every act in this round was research, so the branch's allowance pays for it.
	 * Read by the caller, which is what actually decrements it.
	 */
	spentResearch?: boolean;
}

/**
 * Check a planning round against the store and the diff.
 *
 * `changedFiles` is the round's diff with the queue excluded, so a round that
 * only rewrote todo.toml arrives here as an empty list.
 */
export function checkPlanRound(store: Store, task: Task, changedFiles: string[], config: Config): PlanVerdict {
	const added = unfinishedChildren(task.id, store.tasks);
	const alreadyDone = childrenOf(task.id, store.tasks).length - added.length;
	const problems: string[] = [];

	if (changedFiles.length) {
		const shown = changedFiles.slice(0, 5).join(", ");
		const more = changedFiles.length > 5 ? ` and ${changedFiles.length - 5} more` : "";
		problems.push(
			`a plan produces queue entries, not code, but ${changedFiles.length} file(s) changed: ${shown}${more}`,
		);
	}

	// An empty round is how a branch ends: the planner looked at what is done and
	// had nothing to add. Legal only once the branch has actually delivered
	// something — on the very first round it means the planner declined the job,
	// and accepting that would close the whole project having built nothing.
	if (!added.length && !problems.length) {
		if (alreadyDone > 0) {
			return {
				pass: true,
				mechanical: true,
				finished: true,
				reason: `${task.id} is finished: the round added no further steps after ${alreadyDone} completed item(s).`,
			};
		}
		problems.push(`no items were added under ${task.id}, and its first round has to produce work`);
	}

	if (added.length > config.plan.max_children) {
		problems.push(
			`${added.length} items were added under ${task.id}, but a round may add at most ${config.plan.max_children} — this round is "what is next", not the whole project`,
		);
	}

	const allowed = allowedChildLevels(levelOf(task));
	for (const child of added) {
		const childLevel = levelOf(child);
		if (!allowed.includes(childLevel)) {
			problems.push(`child ${child.id} is a ${childLevel}, but a ${levelOf(task)} may only spawn ${allowed.join(" or ")}`);
		}
		if (child.title.trim().length < MIN_TITLE_LENGTH) {
			problems.push(`child ${child.id} has a title too short to stand on its own: "${child.title}"`);
		}
		if (child.id === task.id) problems.push(`child ${child.id} is its own parent`);
		// The backstop against a plan that only ever spawns plans. Acts are always
		// allowed at any depth: it is recursion without work that has to stop.
		if (childLevel === "plan" && depthOf(child, store.tasks) >= config.plan.max_depth) {
			problems.push(
				`child ${child.id} is a plan at depth ${depthOf(child, store.tasks)}, past the ${config.plan.max_depth} cap — at this depth a round may only add acts`,
			);
		}
	}

	// A round that re-parents an ancestor under itself would make nextReady loop
	// forever, so it is caught here rather than at selection time.
	for (const child of added) {
		const seen = new Set<string>([child.id]);
		let cursor = parentOf(child, store.tasks);
		while (cursor) {
			if (seen.has(cursor)) {
				problems.push(`child ${child.id} sits in a parent cycle`);
				break;
			}
			seen.add(cursor);
			const next = store.tasks.find((t) => t.id === cursor);
			cursor = next ? parentOf(next, store.tasks) : undefined;
		}
	}

	// The progress rule. Planning that spawns only more planning is the failure
	// mode this design trades for the old one, and it is comfortable enough that
	// it has to be a gate rather than a request: reading and re-planning always
	// feels productive and never risks a failing build.
	const acts = added.filter((child) => levelOf(child) !== "plan");
	let spentResearch = false;
	if (added.length && !acts.length) {
		problems.push(
			`every item added under ${task.id} is another plan — a round must land at least one act, so that something actually gets written down`,
		);
	} else if (acts.length && acts.every((act) => kindOf(act) === "research")) {
		// Research is the honest answer when there is genuinely nothing to build
		// yet, so it counts — but from an allowance, not for free. An escape valve
		// that never closes is not an escape valve, it is a bypass.
		const budget = researchBudgetOf(task, config.plan.research_budget);
		if (budget <= 0) {
			problems.push(
				`every act added under ${task.id} is research, and this branch has used its research allowance — this round needs an act that writes to the repository`,
			);
		} else {
			spentResearch = true;
		}
	}

	if (problems.length) {
		return { pass: false, reason: `Planning round rejected: ${problems.join("; ")}.`, mechanical: true };
	}

	return {
		pass: true,
		mechanical: true,
		spentResearch,
		reason: `${task.id} planned ${added.length} next step(s): ${added.map((c) => `${c.id} [${levelOf(c) === "plan" ? "plan" : kindOf(c)}]`).join(", ")}.`,
	};
}

/**
 * How alike two task titles read, 0 to 1, by Dice coefficient over character
 * bigrams of their normalised words.
 *
 * Character bigrams rather than shared words, for the same reason pi-android
 * settled on them: titles differing only in a suffix ("… for the debug build"
 * / "… for the release build") share every word that matters and none of the
 * ones that distinguish them, while titles saying the same thing in different
 * grammar ("Add a TOTP factor" / "Adding TOTP second factor") share almost no
 * whole words at all.
 */
export function titleSimilarity(a: string, b: string): number {
	const norm = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	const bigrams = (text: string): Set<string> => {
		const out = new Set<string>();
		for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2));
		return out;
	};
	const left = bigrams(norm(a));
	const right = bigrams(norm(b));
	if (!left.size || !right.size) return norm(a) === norm(b) ? 1 : 0;
	let shared = 0;
	for (const gram of left) if (right.has(gram)) shared++;
	return (2 * shared) / (left.size + right.size);
}

/** Above this, two titles are close enough that a human would ask which was meant. */
export const DUPLICATE_TITLE_SIMILARITY = 0.75;

/**
 * The sibling a new title most resembles, if any is close enough to matter.
 *
 * This exists because of run 13: iterations 25, 26 and 27 spent four and a
 * half hours on the same dead end, because a retry has no memory of the last
 * one and the queue happily held three near-identical rows. todo_add cannot
 * refuse — sometimes two similar steps really are two steps — but a round that
 * is about to queue its own previous attempt for the third time should at
 * least be told so while it can still act on it.
 */
export function nearDuplicate(title: string, siblings: Task[]): { task: Task; score: number } | undefined {
	let best: { task: Task; score: number } | undefined;
	for (const task of siblings) {
		const score = titleSimilarity(title, task.title);
		if (score >= DUPLICATE_TITLE_SIMILARITY && (!best || score > best.score)) best = { task, score };
	}
	return best;
}

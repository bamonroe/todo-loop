/**
 * Verification for a breakdown, answered entirely by tooling.
 *
 * An implementation task is judged by a model because "does this diff do what
 * the task asked" has no mechanical answer. A breakdown is different: it
 * succeeds when well-formed children exist and no code was touched, and both of
 * those are facts about the store and the diff. No model is asked, nothing
 * leaves the machine, and the check costs nothing.
 *
 * Note the symmetry with src/evidence.ts. An implementation task with an empty
 * diff is a hard failure; a breakdown with a *non-empty* diff is the same
 * failure inverted. "A scope spawns todos, not code" is enforced, not requested.
 */

import type { Config } from "./config.ts";
import {
	allowedChildLevels,
	childrenOf,
	levelOf,
	parentOf,
	type Store,
	type Task,
	type TaskLevel,
} from "./store.ts";
import type { Verdict } from "./verify.ts";

/** Titles below this read as placeholders rather than work a weak model can act on. */
export const MIN_TITLE_LENGTH = 12;

function describe(level: TaskLevel): string {
	return level;
}

/** "a scope" but "an epic". */
function article(level: TaskLevel): string {
	return `${level === "epic" ? "an" : "a"} ${level}`;
}

/**
 * Check a breakdown against the store and the diff.
 *
 * `changedFiles` is the task's diff with the queue excluded, so a breakdown that
 * only rewrote todo.toml arrives here as an empty list.
 */
export function checkDecomposition(
	store: Store,
	task: Task,
	changedFiles: string[],
	config: Config,
): Verdict {
	const level = levelOf(task);
	const children = childrenOf(task.id, store.tasks);
	const problems: string[] = [];

	if (changedFiles.length) {
		const shown = changedFiles.slice(0, 5).join(", ");
		const more = changedFiles.length > 5 ? ` and ${changedFiles.length - 5} more` : "";
		problems.push(
			`${article(level)} produces queue entries, not code, but ${changedFiles.length} file(s) changed: ${shown}${more}`,
		);
	}

	// An epic is several things by definition. A scope is an open question, and
	// the honest answer is sometimes "one task" — refusing that would leave a
	// scope with no way to close, since blocking halts the whole queue.
	const min = level === "epic" ? config.decompose.min_children : 1;
	if (children.length < min) {
		problems.push(
			children.length === 0
				? `no child tasks were added under ${task.id}`
				: `only ${children.length} child task(s) were added under ${task.id}, and breaking down an epic needs at least ${min}`,
		);
	}

	const allowed = allowedChildLevels(level);
	for (const child of children) {
		const childLevel = levelOf(child);
		if (!allowed.includes(childLevel)) {
			problems.push(
				`child ${child.id} is ${article(childLevel)}, but ${article(level)} may only spawn ${allowed.map(describe).join(" or ")}`,
			);
		}
		if (child.title.trim().length < MIN_TITLE_LENGTH) {
			problems.push(`child ${child.id} has a title too short to stand on its own: "${child.title}"`);
		}
		if (child.id === task.id) {
			problems.push(`child ${child.id} is its own parent`);
		}
	}

	// A breakdown that re-parents an ancestor under itself would make nextLeaf
	// loop forever, so it is caught here rather than at selection time.
	for (const child of children) {
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

	if (problems.length) {
		return { pass: false, reason: `Breakdown rejected: ${problems.join("; ")}.`, mechanical: true };
	}

	return {
		pass: true,
		reason: `${task.id} broken down into ${children.length} child task(s): ${children.map((c) => c.id).join(", ")}.`,
		mechanical: true,
	};
}

/**
 * Notes-file maintenance: the tripwire, its judgment, and its graduation.
 *
 * The memory file is append-only across a run that may reach fifty iterations,
 * so growth is guaranteed even when rot is not. The wrong design is a fixed
 * size threshold: a large project's correctly-compacted knowledge eventually
 * exceeds any fixed number, at which point the trigger stops meaning "tidy
 * this" and starts meaning "delete true facts until the number is satisfied".
 *
 * So the currency is window share — the file is read by every session, and
 * what matters is the fraction of the worker's window it eats. And compaction
 * is judged by outcome, with the loop's own idiom: a compaction that shrinks
 * the file made progress; one that cannot has *proven the file compact*, the
 * same way a planning round that adds nothing proves the branch done. No model
 * is ever asked "is this organized". A proven-compact file graduates to
 * structure: an index every session reads, per-topic files read on demand —
 * the sibling-titles trick one level up.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createTask, findTask, type Store, type Task } from "./store.ts";

export const COMPACT_PREFIX = "notes-compact-";
export const SPLIT_ID = "notes-split";

/** Chars per token, worker-side; deliberately conservative for prose. */
const CHARS_PER_TOKEN = 4;

/** A compaction that shed less than this fraction has proven the file compact. */
const MIN_SHRINK = 0.1;

export type NotesAction = "none" | "wait" | "compact" | "graduate";

export interface NotesFacts {
	/** Current size of the memory file. */
	bytes: number;
	/** The worker's context window, in tokens. */
	windowTokens: number;
	/** Fraction of the window the file may cost before the tripwire fires; 0 disables. */
	maxShare: number;
	/** A maintenance task is already queued or in flight. */
	openMaintenance: boolean;
	/** Size the file had when the most recent finished compaction was queued. */
	lastCompactFromBytes?: number;
	/** The split act has already run; maintenance is done for good. */
	graduated: boolean;
}

export function decideNotesMaintenance(facts: NotesFacts): NotesAction {
	if (facts.maxShare <= 0 || facts.windowTokens <= 0) return "none";
	if (facts.graduated) return "none";
	if (facts.openMaintenance) return "wait";
	const share = facts.bytes / CHARS_PER_TOKEN / facts.windowTokens;
	if (share <= facts.maxShare) return "none";
	// Over budget, and the last finished compaction started from about this
	// size: it ran and the number did not move, which proves the file compact —
	// the threshold is obsolete, not the file. A size well *above* the last
	// attempt means the file has materially regrown since and is worth
	// compacting again; only the stuck case graduates.
	if (facts.lastCompactFromBytes !== undefined && Math.abs(facts.bytes - facts.lastCompactFromBytes) < facts.lastCompactFromBytes * MIN_SHRINK) {
		return "graduate";
	}
	return "compact";
}

/** Read the queue for what maintenance already happened or is still open. */
export function maintenanceHistory(store: Store): {
	openMaintenance: boolean;
	lastCompactFromBytes?: number;
	graduated: boolean;
} {
	let open = false;
	let lastFrom: number | undefined;
	let graduated = false;
	for (const task of store.tasks) {
		const isCompact = task.id.startsWith(COMPACT_PREFIX);
		const isSplit = task.id === SPLIT_ID;
		if (!isCompact && !isSplit) continue;
		if (task.status !== "done") open = true;
		if (isSplit && task.status === "done") graduated = true;
		if (isCompact && task.status === "done") {
			const from = Number(task.id.slice(COMPACT_PREFIX.length));
			if (Number.isFinite(from)) lastFrom = Math.max(lastFrom ?? 0, from);
		}
	}
	return { openMaintenance: open, lastCompactFromBytes: lastFrom, graduated };
}

function shareOf(bytes: number, windowTokens: number): string {
	return `${Math.round((bytes / CHARS_PER_TOKEN / windowTokens) * 100)}%`;
}

/**
 * Queue the decided maintenance act under the project's root plan.
 *
 * The size at queue time is encoded in the compaction task's id, which is what
 * lets the next firing judge the outcome with no state file: if the file is
 * still within a tenth of that number, compaction has proven it compact.
 */
export function queueNotesMaintenance(store: Store, action: "compact" | "graduate", memoryFile: string, bytes: number, windowTokens: number): Task | undefined {
	const root = store.tasks.find((task) => !task.parent && (task.level ?? "act") === "plan");
	const parent = root ? root.id : undefined;

	const task =
		action === "compact"
			? createTask(store, {
					id: `${COMPACT_PREFIX}${bytes}`,
					title: `Compact ${memoryFile} without losing facts`,
					parent,
					level: "act",
					kind: "docs",
					detail:
						`${memoryFile} is ${bytes} bytes — about ${shareOf(bytes, windowTokens)} of the worker window, paid by every session. ` +
						`Rewrite it shorter without losing facts: merge duplicates, drop narration and dead ends, and keep every constraint that names a version, an API, a path or a command — those are the expensive facts. ` +
						`Add nothing new. Everything the file says that still matters must still be said.`,
				})
			: createTask(store, {
					id: SPLIT_ID,
					title: `Split ${memoryFile} into an index and topic files`,
					parent,
					level: "act",
					kind: "docs",
					detail:
						`A compaction act could not shrink ${memoryFile}, so the file is compact and still about ${shareOf(bytes, windowTokens)} of the worker window. The answer is structure, not deletion. ` +
						`Turn ${memoryFile} into an index — one line per topic naming its file — and move each topic's content into notes/<topic>.md beside it. ` +
						`Sessions read the index always and a topic file only when their task touches it. ` +
						`Every version, API, path and command constraint must survive the move, and nothing may be deleted.`,
				});

	if (findTask(store, task.id)) return undefined;
	store.tasks.push(task);
	return task;
}

/**
 * The tripwire, run by the driver each iteration before picking a task.
 * Reads the file, reads the queue, queues at most one act. Returns the queued
 * task so the driver can log it, or undefined when nothing happened.
 */
export function maintainNotes(store: Store, cwd: string, memoryFile: string, maxShare: number, windowTokens: number): Task | undefined {
	if (!memoryFile) return undefined;
	let bytes = 0;
	try {
		bytes = fs.statSync(path.join(cwd, memoryFile)).size;
	} catch {
		return undefined;
	}
	const history = maintenanceHistory(store);
	const action = decideNotesMaintenance({ bytes, windowTokens, maxShare, ...history });
	if (action === "none" || action === "wait") return undefined;
	return queueNotesMaintenance(store, action, memoryFile, bytes, windowTokens);
}

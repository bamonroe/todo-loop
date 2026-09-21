/**
 * Where the loop's own bookkeeping goes when it does not belong on the task.
 *
 * A project's todo CLI owns the shape of its task file: the one this was built
 * against writes a fixed field list and drops anything it does not recognise, so
 * an `attempts` counter written onto a task survives exactly until that CLI next
 * touches the file. Storing it there would be a data race with a second program
 * over a file the second program owns.
 *
 * So under the project schema the loop keeps its state beside the queue instead,
 * in a file only it writes. The task file then only ever changes in ways the
 * project's own CLI would have made — a status, or a task moving to the archive.
 *
 * Under the native schema none of this applies: todo-loop owns that file, and
 * the bookkeeping stays on the task where it is easiest to read.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml, stringifyToml, type TomlTable } from "./toml.ts";

/** Per-task bookkeeping. Every field is the loop's, and none of it is the project's. */
export interface TaskState {
	attempts: number;
	started_at?: string;
	done_at?: string;
	summary?: string;
	reason?: string;
	overflowed?: boolean;
	overflow_reason?: string;
	/** Every rejection this task has collected, oldest first. */
	rejections?: string[];
	/** Reasoning from an attempt that was killed mid-message, for its retry. */
	interrupted_thinking?: string;
}

export interface LoopState {
	running: boolean;
	current: string;
	iterations: number;
	base_commit: string;
	last_failure: string;
	/**
	 * The task whose unfinished work is deliberately still on disk.
	 *
	 * Set when an act runs out of clock. A timeout is not a verdict that the
	 * work is wrong, and reverting it discards code that was compiling — run 13
	 * killed iterations 12 and 13 while BandSliders.kt was written and building,
	 * and `git reset --hard` deleted it, so the retry re-derived it from
	 * nothing. Named rather than a bare flag so the clean-tree gate can let
	 * through exactly this task's mess and nobody else's.
	 */
	carried?: string;
}

export interface Sidecar {
	loop: LoopState;
	tasks: Map<string, TaskState>;
}

export const SIDECAR_SUFFIX = ".todoloop-state.toml";

const HEADER =
	"# todo-loop bookkeeping. Generated — the queue beside it is the source of truth.\n" +
	"#\n" +
	"# Attempts, timings and verdicts live here rather than on the tasks because the\n" +
	"# task file belongs to the project's own todo CLI, which rewrites it from a\n" +
	"# fixed field list. Delete this file to forget every attempt count; nothing\n" +
	"# about the work itself is recorded here.";

export function emptyLoopState(): LoopState {
	return { running: false, current: "", iterations: 0, base_commit: "", last_failure: "", carried: "" };
}

export function emptySidecar(): Sidecar {
	return { loop: emptyLoopState(), tasks: new Map() };
}

/**
 * The sidecar path for a task file: `TODO.toml` → `TODO.todoloop-state.toml`.
 *
 * Named after the queue rather than fixed, so two queues in one directory do not
 * share a state file and quietly overwrite each other's attempt counts.
 */
export function sidecarPathFor(storeFile: string): string {
	const dir = path.dirname(storeFile);
	const base = path.basename(storeFile).replace(/\.toml$/i, "");
	return path.join(dir, `${base}${SIDECAR_SUFFIX}`);
}

function asString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function parseSidecar(text: string): Sidecar {
	const doc = parseToml(text);
	const loopTable = (doc.loop ?? {}) as Record<string, unknown>;
	const rows = Array.isArray(doc.task) ? (doc.task as Record<string, unknown>[]) : [];

	const tasks = new Map<string, TaskState>();
	for (const row of rows) {
		const id = asString(row.id).trim();
		if (!id) continue;
		const state: TaskState = { attempts: asNumber(row.attempts) };
		const started = asString(row.started_at);
		if (started) state.started_at = started;
		const done = asString(row.done_at);
		if (done) state.done_at = done;
		const summary = asString(row.summary);
		if (summary) state.summary = summary;
		const reason = asString(row.reason);
		if (reason) state.reason = reason;
		if (row.overflowed === true) state.overflowed = true;
		const overflowReason = asString(row.overflow_reason);
		if (overflowReason) state.overflow_reason = overflowReason;
		if (Array.isArray(row.rejections)) {
			const kept = row.rejections.map((value) => asString(value)).filter(Boolean);
			if (kept.length) state.rejections = kept;
		}
		const thinking = asString(row.interrupted_thinking);
		if (thinking) state.interrupted_thinking = thinking;
		tasks.set(id, state);
	}

	return {
		loop: {
			running: loopTable.running === true,
			current: asString(loopTable.current),
			iterations: asNumber(loopTable.iterations),
			base_commit: asString(loopTable.base_commit),
			last_failure: asString(loopTable.last_failure),
			carried: asString(loopTable.carried),
		},
		tasks,
	};
}

/** A task with nothing on it is not written out, so the file stays the size of the work in flight. */
function isEmptyState(state: TaskState): boolean {
	return (
		state.attempts === 0 &&
		!state.started_at &&
		!state.done_at &&
		!state.summary &&
		!state.reason &&
		!state.overflowed &&
		!state.overflow_reason &&
		!state.rejections?.length &&
		!state.interrupted_thinking
	);
}

export function serializeSidecar(sidecar: Sidecar): string {
	const rows: TomlTable[] = [];
	for (const [id, state] of sidecar.tasks) {
		if (isEmptyState(state)) continue;
		const row: TomlTable = { id, attempts: state.attempts };
		if (state.started_at) row.started_at = state.started_at;
		if (state.done_at) row.done_at = state.done_at;
		if (state.summary) row.summary = state.summary;
		if (state.reason) row.reason = state.reason;
		if (state.overflowed) row.overflowed = true;
		if (state.overflow_reason) row.overflow_reason = state.overflow_reason;
		if (state.rejections?.length) row.rejections = state.rejections;
		if (state.interrupted_thinking) row.interrupted_thinking = state.interrupted_thinking;
		rows.push(row);
	}

	const doc: TomlTable = { loop: { ...sidecar.loop }, task: rows };
	return `${HEADER}\n\n${stringifyToml(doc)}`;
}

export function loadSidecar(file: string): Sidecar {
	if (!fs.existsSync(file)) return emptySidecar();
	return parseSidecar(fs.readFileSync(file, "utf8"));
}

export function saveSidecar(file: string, sidecar: Sidecar): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, serializeSidecar(sidecar));
	fs.renameSync(tmp, file);
}

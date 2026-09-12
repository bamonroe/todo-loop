/**
 * todo.toml: the queue that outlives any single session.
 *
 * Session-embedded state (the shape Pi's own todo example uses) is the right
 * default for branchable todos, but this loop replaces the session on every
 * task, so the queue has to live on disk.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml, stringifyToml, type TomlTable } from "./toml.ts";

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

/**
 * How big an item is, and therefore what "working" it means.
 *
 * An epic spawns scopes, a scope spawns tasks, a task spawns code. Only the
 * bottom level is ever implemented; the two above it produce queue entries and
 * are forbidden from touching the tree (see src/decompose.ts).
 */
export type TaskLevel = "task" | "scope" | "epic";

/** What the loop should do when it picks this item up. */
export type Assignment = "implement" | "decompose";

export interface Task {
	id: string;
	title: string;
	detail?: string;
	parent?: string;
	/** Defaults to "task" — an item without a level is atomic work. */
	level?: TaskLevel;
	status: TaskStatus;
	attempts: number;
	summary?: string;
	reason?: string;
	started_at?: string;
	done_at?: string;
	/**
	 * Set when a task overran its context budget: compaction fired inside it, or
	 * it touched more files than `atomic.max_files`. Evidence that the task was
	 * never atomic, recorded so it can be acted on rather than just felt.
	 */
	overflowed?: boolean;
	/** Why `overflowed` was set — shown in status and doctor. */
	overflow_reason?: string;
}

export interface LoopState {
	running: boolean;
	current: string;
	iterations: number;
	base_commit: string;
	last_failure: string;
}

export interface Store {
	loop: LoopState;
	tasks: Task[];
}

export const DEFAULT_STORE_FILE = "todo.toml";

const STATUSES: TaskStatus[] = ["todo", "done", "doing", "blocked"];
const LEVELS: TaskLevel[] = ["task", "scope", "epic"];

function asString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStatus(value: unknown): TaskStatus {
	const raw = asString(value, "todo");
	return STATUSES.includes(raw as TaskStatus) ? (raw as TaskStatus) : "todo";
}

function asLevel(value: unknown): TaskLevel {
	const raw = asString(value, "task").trim().toLowerCase();
	return LEVELS.includes(raw as TaskLevel) ? (raw as TaskLevel) : "task";
}

/** An absent level means "task"; callers should never branch on undefined. */
export function levelOf(task: Task): TaskLevel {
	return task.level ?? "task";
}

/**
 * Level, allowing for queues written before levels existed.
 *
 * An item with children is a container whatever it calls itself — that is what a
 * parent has always been here, and treating one as a scope keeps every existing
 * dotted-id queue valid without an edit. Only an *explicit* `level = "task"`
 * with children is a contradiction, because someone wrote it down on purpose.
 */
export function effectiveLevel(task: Task, tasks: Task[]): TaskLevel {
	if (task.level) return task.level;
	return childrenOf(task.id, tasks).length ? "scope" : "task";
}

/**
 * What working this item means. Decided by level alone, deliberately.
 *
 * It cannot also depend on whether the item has children: a breakdown *creates*
 * children, so a predicate that flips once the first one lands would refuse the
 * second. Selection already guarantees this is only asked about leaves, because
 * nextLeaf never returns an item that has children.
 */
export function assignmentFor(task: Task): Assignment {
	return levelOf(task) === "task" ? "implement" : "decompose";
}

/**
 * A scope or epic that nobody has broken down yet. The display and audit
 * question, as opposed to the "what do I do now" question above.
 */
export function needsBreakdown(task: Task, tasks: Task[]): boolean {
	return levelOf(task) !== "task" && isLeaf(task, tasks);
}

/** Which levels a given level is allowed to spawn. An epic never spawns code directly. */
export function allowedChildLevels(level: TaskLevel): TaskLevel[] {
	if (level === "epic") return ["scope", "task"];
	if (level === "scope") return ["task"];
	return [];
}

export function resolveStorePath(cwd: string, file?: string): string {
	const target = file ?? process.env.TODOLOOP_FILE ?? DEFAULT_STORE_FILE;
	return path.isAbsolute(target) ? target : path.join(cwd, target);
}

export function emptyStore(): Store {
	return {
		loop: { running: false, current: "", iterations: 0, base_commit: "", last_failure: "" },
		tasks: [],
	};
}

export function parseStore(text: string): Store {
	const doc = parseToml(text);
	const loopTable = (doc.loop ?? {}) as Record<string, unknown>;
	const rawTasks = Array.isArray(doc.task) ? (doc.task as Record<string, unknown>[]) : [];

	const tasks: Task[] = [];
	for (const raw of rawTasks) {
		const id = asString(raw.id).trim();
		if (!id) continue;
		const task: Task = {
			id,
			title: asString(raw.title, id),
			status: asStatus(raw.status),
			attempts: asNumber(raw.attempts),
		};
		const detail = asString(raw.detail);
		if (detail) task.detail = detail;
		const parent = asString(raw.parent);
		if (parent) task.parent = parent;
		if (raw.level !== undefined) task.level = asLevel(raw.level);
		if (raw.overflowed === true) task.overflowed = true;
		const overflowReason = asString(raw.overflow_reason);
		if (overflowReason) task.overflow_reason = overflowReason;
		const summary = asString(raw.summary);
		if (summary) task.summary = summary;
		const reason = asString(raw.reason);
		if (reason) task.reason = reason;
		const startedAt = asString(raw.started_at);
		if (startedAt) task.started_at = startedAt;
		const doneAt = asString(raw.done_at);
		if (doneAt) task.done_at = doneAt;
		tasks.push(task);
	}

	return {
		loop: {
			running: loopTable.running === true,
			current: asString(loopTable.current),
			iterations: asNumber(loopTable.iterations),
			base_commit: asString(loopTable.base_commit),
			last_failure: asString(loopTable.last_failure),
		},
		tasks,
	};
}

export function serializeStore(store: Store): string {
	const doc: TomlTable = {
		loop: {
			running: store.loop.running,
			current: store.loop.current,
			iterations: store.loop.iterations,
			base_commit: store.loop.base_commit,
			last_failure: store.loop.last_failure,
		},
		task: store.tasks.map((task) => {
			const out: TomlTable = { id: task.id, title: task.title };
			if (task.parent) out.parent = task.parent;
			if (task.level && task.level !== "task") out.level = task.level;
			out.status = task.status;
			out.attempts = task.attempts;
			if (task.detail) out.detail = task.detail;
			if (task.started_at) out.started_at = task.started_at;
			if (task.done_at) out.done_at = task.done_at;
			if (task.summary) out.summary = task.summary;
			if (task.reason) out.reason = task.reason;
			if (task.overflowed) out.overflowed = true;
			if (task.overflow_reason) out.overflow_reason = task.overflow_reason;
			return out;
		}),
	};

	const header =
		"# Managed by todo-loop. Order is priority order; the loop always takes\n" +
		"# the first incomplete leaf. Dotted ids imply hierarchy (a.b is under a).\n\n";
	return header + stringifyToml(doc);
}

export function loadStore(file: string): Store {
	if (!fs.existsSync(file)) return emptyStore();
	return parseStore(fs.readFileSync(file, "utf8"));
}

export function saveStore(file: string, store: Store): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, serializeStore(store));
	fs.renameSync(tmp, file);
}

/** Explicit `parent`, else the dotted-id prefix when a task with that id exists. */
export function parentOf(task: Task, tasks: Task[]): string | undefined {
	if (task.parent) return task.parent;
	const cut = task.id.lastIndexOf(".");
	if (cut < 0) return undefined;
	const candidate = task.id.slice(0, cut);
	return tasks.some((t) => t.id === candidate) ? candidate : undefined;
}

export function childrenOf(id: string, tasks: Task[]): Task[] {
	return tasks.filter((task) => parentOf(task, tasks) === id);
}

export function isLeaf(task: Task, tasks: Task[]): boolean {
	return childrenOf(task.id, tasks).length === 0;
}

export function findTask(store: Store, id: string): Task | undefined {
	return store.tasks.find((task) => task.id === id);
}

/**
 * Leftmost incomplete leaf. Interior nodes are never handed to the model —
 * a parent's work is its children, and prompting with one is how a bounded
 * task turns into a forty-turn run.
 */
export function nextLeaf(store: Store): Task | undefined {
	return store.tasks.find(
		(task) => (task.status === "todo" || task.status === "doing") && isLeaf(task, store.tasks),
	);
}

/**
 * Every descendant of `id`, in queue order.
 *
 * Used to find where a parent's block ends, so a second round of decomposition
 * appends inside that block rather than interleaving with a sibling's children.
 */
export function descendantsOf(id: string, tasks: Task[]): Task[] {
	const out: Task[] = [];
	const frontier = [id];
	const seen = new Set<string>([id]);
	while (frontier.length) {
		const current = frontier.shift() as string;
		for (const child of childrenOf(current, tasks)) {
			if (seen.has(child.id)) continue;
			seen.add(child.id);
			out.push(child);
			frontier.push(child.id);
		}
	}
	return out.sort((a, b) => tasks.indexOf(a) - tasks.indexOf(b));
}

/**
 * Insert children directly after their parent's block rather than at the end of
 * the queue.
 *
 * Order is priority order and `nextLeaf` reads it literally, so appending would
 * push freshly-scoped work behind every unrelated epic — breadth-first sprawl
 * instead of finishing one thing. Inserting in place keeps the loop depth-first.
 */
export function insertChildren(store: Store, parentId: string, children: Task[]): void {
	if (!children.length) return;
	const parent = findTask(store, parentId);
	if (!parent) {
		store.tasks.push(...children);
		return;
	}
	const block = descendantsOf(parentId, store.tasks);
	const last = block.length ? block[block.length - 1] : parent;
	const at = store.tasks.indexOf(last) + 1;
	store.tasks.splice(at, 0, ...children);
}

/** Mark parents done once every child is done; blocked children block the parent. */
export function rollup(store: Store): void {
	for (let pass = 0; pass < 8; pass++) {
		let changed = false;
		for (const task of store.tasks) {
			const kids = childrenOf(task.id, store.tasks);
			if (kids.length === 0) continue;
			if (kids.every((kid) => kid.status === "done") && task.status !== "done") {
				task.status = "done";
				task.done_at = task.done_at ?? new Date().toISOString();
				task.summary = task.summary ?? `All ${kids.length} subtasks complete.`;
				changed = true;
			} else if (kids.some((kid) => kid.status === "blocked") && task.status === "done") {
				task.status = "todo";
				changed = true;
			}
		}
		if (!changed) return;
	}
}

export function counts(store: Store): Record<TaskStatus | "leaves" | "pending_breakdowns", number> {
	const out: Record<string, number> = { todo: 0, doing: 0, done: 0, blocked: 0, leaves: 0, pending_breakdowns: 0 };
	for (const task of store.tasks) {
		out[task.status] += 1;
		if (isLeaf(task, store.tasks)) out.leaves += 1;
		// "How much of this queue is still an open question?" — the number worth
		// knowing before trusting a long run to it.
		if (task.status !== "done" && needsBreakdown(task, store.tasks)) out.pending_breakdowns += 1;
	}
	return out as Record<TaskStatus | "leaves" | "pending_breakdowns", number>;
}

export function markDoing(store: Store, task: Task, baseCommit: string): void {
	task.status = "doing";
	task.started_at = task.started_at ?? new Date().toISOString();
	store.loop.current = task.id;
	store.loop.base_commit = baseCommit;
	// A retry of the same task must keep the reason it was rejected; only a
	// task nobody has attempted yet starts with a clean slate.
	if (task.attempts === 0) store.loop.last_failure = "";
}

export function markDone(store: Store, task: Task, summary: string): void {
	task.status = "done";
	task.summary = summary;
	task.done_at = new Date().toISOString();
	store.loop.current = "";
	store.loop.last_failure = "";
	rollup(store);
}

export function markBlocked(store: Store, task: Task, reason: string): void {
	task.status = "blocked";
	task.reason = reason;
	store.loop.current = "";
	store.loop.running = false;
}

export function recordFailure(store: Store, task: Task, reason: string): number {
	task.attempts += 1;
	store.loop.last_failure = reason;
	return task.attempts;
}

/**
 * Record that a task overran its context budget. Kept separate from failure:
 * a task can overflow and still pass, and that is exactly the case worth
 * knowing about, because nothing else will ever surface it.
 */
export function markOverflow(task: Task, reason: string): void {
	task.overflowed = true;
	task.overflow_reason = reason;
}

/**
 * Turn a task that proved too big into a scope, so the next pass breaks it down
 * instead of retrying the same oversized prompt. Attempts reset — the task was
 * never atomic, so the failed attempts were not the worker's fault.
 */
export function promoteToScope(store: Store, task: Task, reason: string): void {
	task.level = "scope";
	task.status = "todo";
	task.attempts = 0;
	task.reason = reason;
	task.summary = undefined;
	task.done_at = undefined;
	if (store.loop.current === task.id) store.loop.current = "";
	store.loop.last_failure = "";
}

/** Indented one-line-per-task view for `todo status` and the /todo-status command. */
export function renderTree(store: Store): string {
	const marks: Record<TaskStatus, string> = { todo: "○", doing: "◐", done: "✓", blocked: "✗" };
	const lines: string[] = [];

	const depth = (task: Task): number => {
		let level = 0;
		let cursor: Task | undefined = task;
		const seen = new Set<string>();
		while (cursor && !seen.has(cursor.id)) {
			seen.add(cursor.id);
			const parent = parentOf(cursor, store.tasks);
			if (!parent) break;
			level += 1;
			cursor = findTask(store, parent);
		}
		return level;
	};

	for (const task of store.tasks) {
		const indent = "  ".repeat(depth(task));
		const attempts = task.attempts > 0 && task.status !== "done" ? ` (${task.attempts} attempts)` : "";
		const reason = task.status === "blocked" && task.reason ? ` — ${task.reason}` : "";
		const level = levelOf(task) === "task" ? "" : ` [${levelOf(task)}]`;
		const pending = needsBreakdown(task, store.tasks) ? " — needs breaking down" : "";
		const over = task.overflowed ? " ⚠ too coarse" : "";
		lines.push(`${indent}${marks[task.status]} ${task.id}${level}: ${task.title}${attempts}${pending}${reason}${over}`);
	}

	return lines.join("\n");
}

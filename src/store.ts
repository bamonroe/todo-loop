/**
 * The queue that outlives any single session.
 *
 * Session-embedded state (the shape Pi's own todo example uses) is the right
 * default for branchable todos, but this loop replaces the session on every
 * task, so the queue has to live on disk.
 *
 * It does not have to live in a file of *our* design, though, and mostly it
 * should not: a project that already keeps a backlog wants the loop to work
 * that backlog rather than a copy of it. So this module reads whichever of the
 * two schemas it finds (src/schema.ts), keeps everything it does not understand
 * verbatim, and writes the file back in the shape it arrived in. A queue can be
 * handed back and forth between todo-loop and the project's own CLI without
 * either one losing the other's fields.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isRaw, isTable, leadingComments, parseToml, stringifyToml, todayRaw, type TomlTable } from "./toml.ts";
import {
	detectSchema,
	NATIVE_SCHEMA,
	urgencyRank,
	type Schema,
	type TaskStatus,
} from "./schema.ts";
import {
	emptyLoopState,
	emptySidecar,
	loadSidecar,
	saveSidecar,
	sidecarPathFor,
	type LoopState,
	type Sidecar,
	type TaskState,
} from "./sidecar.ts";

export type { TaskStatus } from "./schema.ts";
export type { LoopState } from "./sidecar.ts";

/**
 * What kind of item this is — and therefore what "working" it means.
 *
 * Not a size. The old ladder (epic spawns scopes, scope spawns tasks) encoded
 * *depth*, which forced the first session to scope an entire project before any
 * of it existed. Three real runs spent 80% of their output tokens on that one
 * up-front design and never once used the deferral level they were given.
 *
 * So a level says what a session does, not how big it is:
 *
 * - **`act`** — one session, one diff, one verdict. The only kind that writes.
 * - **`plan`** — one session that decides the next few things and writes them to
 *   the queue. Touches no files; a non-empty diff rejects the round outright.
 *
 * A plan may spawn either kind, so nesting is unbounded. Termination stops
 * coming from a depth cap and starts coming from a planner that runs out of next
 * steps — see `isReady` for the re-entrancy that makes that the live question.
 */
export type TaskLevel = "act" | "plan";

/**
 * What an act produces. The verb is load-bearing rather than decorative: a
 * planning round must contain at least one act, and `research` counts towards
 * that only while the branch still has allowance left (see src/plan.ts).
 * Without the distinction, "go and find out about X" is an infinitely renewable
 * excuse to never write anything.
 */
export type ActKind = "code" | "docs" | "research";

/** What the loop should do when it picks this item up. Identical to its level. */
export type Assignment = TaskLevel;

export interface Task {
	id: string;
	title: string;
	detail?: string;
	parent?: string;
	/** Defaults to "act" — an item without a level is work, not planning. */
	level?: TaskLevel;
	/**
	 * The word the file itself used for this level, when it is not one of ours.
	 *
	 * `epic` and `scope` both read as `plan`, but the project schema states the
	 * level on every row and that file belongs to someone else — rewriting their
	 * vocabulary on a save would edit data the loop was only passing through.
	 * Read as a translation, written back verbatim. Cleared the moment the loop
	 * actually changes the level, because then it is no longer what the file said.
	 */
	level_raw?: string;
	/** For an act, what it produces. Absent means `code`. Meaningless on a plan. */
	kind?: ActKind;
	/**
	 * Rounds this branch may still close using research alone.
	 *
	 * Inherited from the parent plan at creation rather than reset, which is the
	 * whole point: a planner that has spent its allowance cannot refill it by
	 * spawning a sub-planner to keep reading. That is the first move a model
	 * looking for more research would find.
	 */
	research_budget?: number;
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
	/**
	 * Every verdict this task has been rejected with, oldest first.
	 *
	 * Kept in full rather than as the latest one. Three attempts against the same
	 * prompt plus a single line of "why not" is three re-rolls; a worker that can
	 * see it already tried and failed a particular way has something to work with.
	 */
	rejections?: string[];
	/**
	 * Every field on the task that this loop has no opinion about — category,
	 * tags, created, a project's own per-task flags — kept verbatim so a write
	 * cannot drop them. Deliberately holds *only* the unmodelled fields: a second
	 * copy of `status` here would go stale the moment the task moved.
	 */
	extra?: TomlTable;
	/**
	 * True when this task lives in the archive file rather than the active one.
	 * Not a field on disk: it is which file the task is written back to.
	 */
	archived?: boolean;
}

export interface Store {
	/** Which on-disk shape this queue is written in. Every write goes back out in it. */
	schema: Schema;
	/** Everything in the active file that is not a task, in its original order. */
	doc: TomlTable;
	/** The active file's own leading comment block, preserved across writes. */
	header: string;
	loop: LoopState;
	/** Active and archived tasks together; `archived` says which file each came from. */
	tasks: Task[];
	/** The second file, when the schema archives finished work rather than marking it in place. */
	archive?: { doc: TomlTable; header: string; file: string };
	/** Where the loop's own bookkeeping lives, when it may not live on the tasks. */
	sidecarFile?: string;
}

export const DEFAULT_STORE_FILE = "todo.toml";

/** Task files the loop will adopt without being told, most specific first. */
export const STORE_CANDIDATES = ["TODO.toml", "todo.toml"];

const LEVELS: TaskLevel[] = ["act", "plan"];

const ACT_KINDS: ActKind[] = ["code", "docs", "research"];

/** Keys the loop owns. Under a schema with a sidecar, none of them may touch the task file. */
const BOOKKEEPING = [
	"attempts",
	"started_at",
	"done_at",
	"summary",
	"reason",
	"overflowed",
	"overflow_reason",
	"rejections",
];

/** Keys `Task` models directly, and which therefore never belong in `extra`. */
const MODELLED = ["id", "title", "status", "level", "kind", "research_budget", "parent", ...BOOKKEEPING];

/** Level words the loop understands as its own and therefore never preserves verbatim. */
const OWN_LEVELS = new Set<string>(LEVELS);

/** Dropped when a task is archived — they rank active work and mean nothing once it has shipped. */
const RANKING_KEYS = ["order", "urgency"];

const NATIVE_HEADER =
	"# Managed by todo-loop. Order is priority order; the loop always takes\n" +
	"# the first incomplete leaf. Dotted ids imply hierarchy (a.b is under a).";

function asString(value: unknown, fallback = ""): string {
	if (typeof value === "string") return value;
	if (isRaw(value)) return value.token;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asLevel(value: unknown): TaskLevel {
	const raw = asString(value, "act").trim().toLowerCase();
	// Queues written against the old ladder still parse: the two container levels
	// become plans, and anything else is work.
	if (raw === "epic" || raw === "scope") return "plan";
	if (raw === "task") return "act";
	return LEVELS.includes(raw as TaskLevel) ? (raw as TaskLevel) : "act";
}

function asActKind(value: unknown): ActKind {
	const raw = asString(value, "code").trim().toLowerCase();
	return ACT_KINDS.includes(raw as ActKind) ? (raw as ActKind) : "code";
}

/** An absent level means "act"; callers should never branch on undefined. */
export function levelOf(task: Task): TaskLevel {
	return task.level ?? "act";
}

/** An absent kind means "code". Only meaningful on an act. */
export function kindOf(task: Task): ActKind {
	return task.kind ?? "code";
}

/**
 * Level, allowing for queues written before levels existed.
 *
 * An item with children is a container whatever it calls itself — that is what a
 * parent has always been here, and treating one as a plan keeps every existing
 * dotted-id queue valid without an edit. Only an *explicit* `level = "act"`
 * with children is a contradiction, because someone wrote it down on purpose.
 */
export function effectiveLevel(task: Task, tasks: Task[]): TaskLevel {
	if (task.level) return task.level;
	return childrenOf(task.id, tasks).length ? "plan" : "act";
}

/**
 * What working this item means. Decided by level alone, deliberately.
 *
 * It cannot also depend on whether the item has children: a planning round
 * *creates* children, so a predicate that flips once the first one lands would
 * refuse the second — and under re-entrancy a plan is handed back repeatedly
 * with its previous rounds still hanging off it.
 */
export function assignmentFor(task: Task): Assignment {
	return levelOf(task);
}

/** A plan nobody has run a round on yet. The display and audit question. */
export function needsPlanning(task: Task, tasks: Task[]): boolean {
	return levelOf(task) === "plan" && isLeaf(task, tasks);
}

/** Which levels a given level is allowed to spawn. An act never spawns anything. */
export function allowedChildLevels(level: TaskLevel): TaskLevel[] {
	return level === "plan" ? ["act", "plan"] : [];
}

/** How deep this task sits. The root is 0. Cycles stop the walk rather than hang it. */
export function depthOf(task: Task, tasks: Task[]): number {
	let depth = 0;
	const seen = new Set<string>([task.id]);
	let cursor = parentOf(task, tasks);
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		depth += 1;
		const parent = tasks.find((row) => row.id === cursor);
		cursor = parent ? parentOf(parent, tasks) : undefined;
	}
	return depth;
}

/**
 * Which file to work on.
 *
 * An explicit path always wins. With none given, an existing queue is adopted
 * rather than a second one created beside it — the common mistake otherwise is
 * a project with a `TODO.toml` quietly getting an empty `todo.toml` on the
 * first write, and a loop that reports the queue is empty while the real one
 * sits next to it.
 */
export function resolveStorePath(cwd: string, file?: string): string {
	const target = file ?? process.env.TODOLOOP_FILE;
	if (target) return path.isAbsolute(target) ? target : path.join(cwd, target);
	for (const candidate of STORE_CANDIDATES) {
		const full = path.join(cwd, candidate);
		if (fs.existsSync(full)) return full;
	}
	return path.join(cwd, DEFAULT_STORE_FILE);
}

export function emptyStore(): Store {
	return {
		schema: NATIVE_SCHEMA,
		doc: {},
		header: NATIVE_HEADER,
		loop: emptyLoopState(),
		tasks: [],
	};
}

/** The document minus its tasks, which are modelled rather than passed through. */
function preamble(doc: TomlTable): TomlTable {
	const out: TomlTable = {};
	for (const [key, value] of Object.entries(doc)) {
		if (key === "task") continue;
		out[key] = value;
	}
	return out;
}

function readTask(raw: TomlTable, schema: Schema, archived: boolean): Task | undefined {
	const id = asString(raw.id).trim();
	if (!id) return undefined;

	const status = schema.statusIn[asString(raw.status, "todo")] ?? (archived ? "done" : "todo");
	const extra: TomlTable = {};
	for (const [key, value] of Object.entries(raw)) {
		if (key === schema.detailKey || MODELLED.includes(key)) continue;
		extra[key] = value;
	}

	const task: Task = {
		id,
		title: asString(raw.title, id),
		status: archived ? "done" : status,
		attempts: asNumber(raw.attempts),
		extra,
	};
	if (archived) task.archived = true;

	const detail = asString(raw[schema.detailKey]);
	if (detail) task.detail = detail;
	const parent = asString(raw.parent);
	if (parent) task.parent = parent;
	if (raw.level !== undefined) {
		task.level = asLevel(raw.level);
		const word = asString(raw.level).trim();
		if (word && !OWN_LEVELS.has(word.toLowerCase())) task.level_raw = word;
	}
	if (raw.kind !== undefined) task.kind = asActKind(raw.kind);
	if (typeof raw.research_budget === "number") task.research_budget = Math.max(0, Math.trunc(raw.research_budget));
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
	if (Array.isArray(raw.rejections)) {
		const kept = raw.rejections.map((value) => asString(value)).filter(Boolean);
		if (kept.length) task.rejections = kept;
	}
	return task;
}

function tasksIn(doc: TomlTable, schema: Schema, archived: boolean): Task[] {
	const rows = Array.isArray(doc.task) ? (doc.task as TomlTable[]) : [];
	const out: Task[] = [];
	for (const row of rows) {
		const task = readTask(row, schema, archived);
		if (task) out.push(task);
	}
	return out;
}

/** Overlay the sidecar's per-task bookkeeping onto the tasks it names. */
function applySidecar(tasks: Task[], sidecar: Sidecar): void {
	for (const task of tasks) {
		const state = sidecar.tasks.get(task.id);
		if (!state) continue;
		task.attempts = state.attempts;
		if (state.started_at) task.started_at = state.started_at;
		if (state.done_at) task.done_at = state.done_at;
		if (state.summary) task.summary = state.summary;
		if (state.reason) task.reason = state.reason;
		if (state.overflowed) task.overflowed = true;
		if (state.overflow_reason) task.overflow_reason = state.overflow_reason;
		if (state.rejections?.length) task.rejections = [...state.rejections];
	}
}

export interface ParseOptions {
	/** Contents of the archive file, when the schema keeps finished work in one. */
	archiveText?: string;
	archiveFile?: string;
	sidecar?: Sidecar;
	sidecarFile?: string;
	/** Overrides detection. Only for a caller that genuinely knows better. */
	schema?: Schema;
}

export function parseStore(text: string, options: ParseOptions = {}): Store {
	const doc = parseToml(text);
	const schema = options.schema ?? detectSchema(doc);
	const tasks = tasksIn(doc, schema, false);

	const store: Store = {
		schema,
		doc: preamble(doc),
		header: leadingComments(text) || (schema === NATIVE_SCHEMA ? NATIVE_HEADER : ""),
		loop: emptyLoopState(),
		tasks,
	};

	if (schema.archives && options.archiveText !== undefined) {
		const archiveDoc = parseToml(options.archiveText);
		store.archive = {
			doc: preamble(archiveDoc),
			header: leadingComments(options.archiveText),
			file: options.archiveFile ?? "",
		};
		// Archived tasks join the same array. They are `done`, so selection skips
		// them, but every question about the *tree* — has this plan had a round
		// down, is this parent finished — is wrong without them.
		store.tasks.push(...tasksIn(archiveDoc, schema, true));
	}

	if (schema.sidecar) {
		store.sidecarFile = options.sidecarFile;
		const sidecar = options.sidecar ?? emptySidecar();
		store.loop = sidecar.loop;
		applySidecar(store.tasks, sidecar);
	} else {
		const loopTable = isTable(doc.loop) ? (doc.loop as Record<string, unknown>) : {};
		store.loop = {
			running: loopTable.running === true,
			current: asString(loopTable.current),
			iterations: asNumber(loopTable.iterations),
			base_commit: asString(loopTable.base_commit),
			last_failure: asString(loopTable.last_failure),
		};
		delete store.doc.loop;
	}

	return store;
}

function setOrDelete(table: TomlTable, key: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") delete table[key];
	else table[key] = value;
}

/**
 * Lay a task's fields out in the file's own order.
 *
 * Known fields first, in the order that schema writes them, so a row the loop
 * added is indistinguishable from one the project's CLI added. Anything else —
 * a project's per-task flags, a field added since — keeps its relative position
 * at the end rather than being dropped, which is the whole point.
 */
function ordered(values: TomlTable, order: string[]): TomlTable {
	const out: TomlTable = {};
	for (const key of order) if (values[key] !== undefined) out[key] = values[key];
	for (const [key, value] of Object.entries(values)) {
		if (out[key] === undefined && value !== undefined) out[key] = value;
	}
	return out;
}

function taskTable(task: Task, schema: Schema): TomlTable {
	const values: TomlTable = { ...(task.extra ?? {}) };
	values.id = task.id;
	values.title = task.title;
	values.status = schema.statusOut[task.status];
	setOrDelete(values, schema.detailKey, task.detail);
	setOrDelete(values, "parent", task.parent);

	// The project schema states the level on every task; the native one leaves
	// the default unwritten. Either way an explicit level is never dropped.
	const levelWord = task.level_raw ?? levelOf(task);
	if (schema.name === "project") values.level = levelWord;
	else setOrDelete(values, "level", task.level_raw ?? (task.level && task.level !== "act" ? task.level : undefined));
	// Only ever written when it is not the default, so an ordinary code act stays
	// a three-line row.
	setOrDelete(values, "kind", task.kind && task.kind !== "code" ? task.kind : undefined);
	setOrDelete(values, "research_budget", levelOf(task) === "plan" ? task.research_budget : undefined);

	if (schema.sidecar) {
		for (const key of BOOKKEEPING) {
			if (!schema.sharedFields.includes(key)) delete values[key];
		}
		// A shared key is the file's own field, so it is written from the typed
		// value like any other rather than left to whatever `extra` remembered.
		// Only while the status it explains is actually set, though: `reason` is
		// the project's word for "why is this blocked", and a rejection note on a
		// task the loop is still retrying is the loop's business, not the queue's.
		if (schema.sharedFields.includes("reason")) {
			setOrDelete(values, "reason", task.status === "blocked" ? task.reason : undefined);
		}
	} else {
		values.attempts = task.attempts;
		setOrDelete(values, "started_at", task.started_at);
		setOrDelete(values, "done_at", task.done_at);
		setOrDelete(values, "summary", task.summary);
		setOrDelete(values, "reason", task.reason);
		setOrDelete(values, "overflowed", task.overflowed ? true : undefined);
		setOrDelete(values, "overflow_reason", task.overflow_reason);
		if (task.rejections?.length) values.rejections = [...task.rejections];
		else delete values.rejections;
	}

	return ordered(values, schema.fieldOrder);
}

function render(header: string, doc: TomlTable, tasks: Task[], schema: Schema): string {
	const body: TomlTable = { ...doc, task: tasks.map((task) => taskTable(task, schema)) };
	const text = stringifyToml(body);
	return header ? `${header.replace(/\n+$/, "")}\n\n${text}` : text;
}

/** The active file: the preamble it came with, then every task not yet archived. */
export function serializeStore(store: Store): string {
	const doc: TomlTable = { ...store.doc };
	if (!store.schema.sidecar) doc.loop = { ...store.loop };
	return render(store.header, doc, store.tasks.filter((task) => !task.archived), store.schema);
}

/** The archive file, or undefined when this schema keeps finished work in place. */
export function serializeArchive(store: Store): string | undefined {
	if (!store.archive) return undefined;
	return render(
		store.archive.header,
		store.archive.doc,
		store.tasks.filter((task) => task.archived),
		store.schema,
	);
}

export function sidecarOf(store: Store): Sidecar {
	const sidecar = emptySidecar();
	const shared = store.schema.sharedFields;
	sidecar.loop = { ...store.loop };
	for (const task of store.tasks) {
		// A field the queue itself stores is not duplicated here; one copy of a
		// fact is the whole point of putting it in the file that owns it.
		const state: TaskState = { attempts: task.attempts };
		if (task.reason && !(shared.includes("reason") && task.status === "blocked")) state.reason = task.reason;
		if (task.started_at) state.started_at = task.started_at;
		if (task.done_at) state.done_at = task.done_at;
		if (task.summary) state.summary = task.summary;
		if (task.overflowed) state.overflowed = true;
		if (task.overflow_reason) state.overflow_reason = task.overflow_reason;
		if (task.rejections?.length) state.rejections = [...task.rejections];
		sidecar.tasks.set(task.id, state);
	}
	return sidecar;
}

/**
 * The archive file named by the queue itself.
 *
 * The project schema records it in the header — `archive = "FINISHED.toml"` —
 * which is exactly the right place for it: the queue knows where its own
 * finished work goes, and nobody has to configure the answer twice.
 */
export function archivePathFor(storeFile: string, doc: TomlTable, override?: string): string {
	const named = isTable(doc.meta) ? asString((doc.meta as TomlTable).archive) : "";
	const target = override || named || "FINISHED.toml";
	return path.isAbsolute(target) ? target : path.join(path.dirname(storeFile), target);
}

export interface LoadOptions {
	/** Overrides the archive path the queue names for itself. */
	archiveFile?: string;
}

export function loadStore(file: string, options: LoadOptions = {}): Store {
	if (!fs.existsSync(file)) return emptyStore();
	const text = fs.readFileSync(file, "utf8");
	const doc = parseToml(text);
	const schema = detectSchema(doc);

	const parseOptions: ParseOptions = { schema };
	if (schema.archives) {
		const archiveFile = archivePathFor(file, doc, options.archiveFile);
		parseOptions.archiveFile = archiveFile;
		parseOptions.archiveText = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, "utf8") : "";
	}
	if (schema.sidecar) {
		const sidecarFile = sidecarPathFor(file);
		parseOptions.sidecarFile = sidecarFile;
		parseOptions.sidecar = loadSidecar(sidecarFile);
	}
	return parseStore(text, parseOptions);
}

function writeAtomic(file: string, contents: string): void {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, contents);
	fs.renameSync(tmp, file);
}

export function saveStore(file: string, store: Store): void {
	writeAtomic(file, serializeStore(store));
	const archive = serializeArchive(store);
	if (archive !== undefined && store.archive?.file) writeAtomic(store.archive.file, archive);
	if (store.schema.sidecar && store.sidecarFile) saveSidecar(store.sidecarFile, sidecarOf(store));
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

/** Tasks still in the active file — what "the queue" means to anyone reading it. */
export function activeTasks(store: Store): Task[] {
	return store.tasks.filter((task) => !task.archived);
}

/**
 * Priority order, most urgent first.
 *
 * Mirrors the project CLI exactly — urgency descending, then `order` ascending,
 * then id — because the two tools have to agree about what is next or the
 * ranking in the file is a lie. A task with no `order` sorts after every task
 * that has one, which is what an unranked addition should do.
 */
function rankOf(task: Task): [number, number, string] {
	const extra = task.extra ?? {};
	const order = typeof extra.order === "number" ? extra.order : Number.POSITIVE_INFINITY;
	return [-urgencyRank(extra.urgency), order, task.id];
}

function byRank(a: Task, b: Task): number {
	const [au, ao, ai] = rankOf(a);
	const [bu, bo, bi] = rankOf(b);
	return au - bu || ao - bo || ai.localeCompare(bi);
}

/**
 * Every task in the order the loop should work them.
 *
 * A ranked schema states its priority in fields, and states it *flat* — parents
 * and children sit wherever they were appended — so the tree has to be rebuilt
 * and walked depth-first, ranking siblings at each level. Finishing one branch
 * beats starting nine.
 *
 * An unranked schema already keeps the array in priority order and inserts
 * children beside their parents, so the array *is* the answer and is returned
 * untouched. Reordering it would silently change which task a long-standing
 * queue hands out next.
 */
export function workingOrder(store: Store): Task[] {
	if (!store.schema.ranked) return store.tasks;

	const byParent = new Map<string, Task[]>();
	for (const task of store.tasks) {
		const key = parentOf(task, store.tasks) ?? "";
		const siblings = byParent.get(key);
		if (siblings) siblings.push(task);
		else byParent.set(key, [task]);
	}

	const out: Task[] = [];
	const seen = new Set<string>();
	const walk = (parent: string): void => {
		for (const task of (byParent.get(parent) ?? []).slice().sort(byRank)) {
			if (seen.has(task.id)) continue;
			seen.add(task.id);
			out.push(task);
			walk(task.id);
		}
	};
	walk("");
	// A task whose parent is missing, or part of a cycle, is still work. Append it
	// rather than letting it vanish from the queue.
	for (const task of store.tasks) if (!seen.has(task.id)) out.push(task);
	return out;
}

/**
 * Ids this task declared it is waiting on. Always a list; absent means none.
 *
 * Not a modelled field, because the loop does not create dependencies — it only
 * refuses to ignore them. A schema without the field simply never has any.
 */
export function blockersOf(task: Task): string[] {
	const declared = task.extra?.blocked_by;
	if (!Array.isArray(declared)) return [];
	return declared.map((value) => String(value)).filter(Boolean);
}

/**
 * The blockers that have not shipped, in the order they were declared.
 *
 * A blocker that is not in the queue at all counts as unmet. Treating an
 * unknown id as "nothing is in the way" would turn one typo into a silently
 * disabled guard, and a guard nobody can see fail is not a guard.
 */
export function unmetBlockers(task: Task, tasks: Task[]): string[] {
	return blockersOf(task).filter((id) => {
		const blocker = tasks.find((other) => other.id === id);
		return !blocker || blocker.status !== "done";
	});
}

/**
 * True when an item can be started now.
 *
 * An act is startable while it is a childless leaf, as before. A **plan is
 * re-entrant**: it becomes startable again every time its whole batch has
 * landed, and is handed back the record of what just got done so the next round
 * is decided against a repository that now contains it. That is the entire
 * mechanism — a planner never designs against work that does not exist yet,
 * because it is only ever asked about the step immediately in front of it.
 *
 * A plan therefore does not close by having children. It closes when a round
 * adds nothing, which is a planner saying the branch is finished; `rollup`
 * deliberately refuses to complete one on its behalf.
 */
export function isReady(task: Task, tasks: Task[]): boolean {
	if (task.status !== "todo" && task.status !== "doing") return false;
	if (unmetBlockers(task, tasks).length) return false;
	const kids = childrenOf(task.id, tasks);
	if (!kids.length) return true;
	return levelOf(task) === "plan" && kids.every((kid) => kid.status === "done");
}

/**
 * Leftmost startable item — the leftmost open act, or a plan whose batch has
 * finished and which is therefore due another round.
 *
 * An item whose `blocked_by` is not satisfied is skipped rather than blocking
 * the queue behind it, so declaring a dependency reorders work instead of
 * stopping it. The loop is otherwise perfectly willing to build something
 * correct for a state the program cannot reach: the verifier is asked whether
 * the diff does what the task said, which it will, and nobody is asked whether
 * the task was worth doing yet.
 */
export function nextReady(store: Store): Task | undefined {
	return workingOrder(store).find((task) => isReady(task, store.tasks));
}

/**
 * Open leaves that are waiting on something, with what they are waiting on.
 *
 * The counterpart to nextLeaf: between them they account for every leaf, so a
 * queue that reports nothing runnable can always say whether that is because it
 * is finished or because it is stuck.
 */
export function blockedLeaves(store: Store): { task: Task; waitingOn: string[] }[] {
	const out: { task: Task; waitingOn: string[] }[] = [];
	for (const task of workingOrder(store)) {
		if (task.status !== "todo" && task.status !== "doing") continue;
		if (childrenOf(task.id, store.tasks).length && levelOf(task) !== "plan") continue;
		const waitingOn = unmetBlockers(task, store.tasks);
		if (waitingOn.length) out.push({ task, waitingOn });
	}
	return out;
}

/**
 * The children a planning round just added.
 *
 * Not tracked with a snapshot, because it does not need to be: a plan only
 * becomes ready again once every existing child is done, so anything under it
 * that is *not* done was written by the round being judged. The invariant lives
 * in `isReady`, and this reads it back out.
 */
export function unfinishedChildren(id: string, tasks: Task[]): Task[] {
	return childrenOf(id, tasks).filter((child) => child.status !== "done");
}

/**
 * What this branch has already finished, oldest first, most recent last.
 *
 * The context a re-entered plan is handed instead of the whole design. A
 * planner that can see the last few things that landed is deciding the next
 * step against work that exists; one that cannot is guessing, which is the
 * failure the old up-front breakdown made unavoidable.
 */
export function recentlyCompleted(store: Store, id: string, limit = 5): Task[] {
	const done = childrenOf(id, store.tasks).filter((child) => child.status === "done");
	return done.slice(Math.max(0, done.length - limit));
}

/**
 * Rounds this plan may still close with research alone.
 *
 * Absent means the configured default has not been stamped on yet, which is the
 * case for the root and for any queue written by hand.
 */
export function researchBudgetOf(task: Task, fallback: number): number {
	return task.research_budget ?? fallback;
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
 * Throw away everything a breakdown attempt added, so a plan that was cut off
 * partway cannot be worked as though it were complete.
 *
 * This is the failure the loop had no defence against. A breakdown killed at the
 * 30-minute mark had written 2 of roughly 8 children; the working tree reverted
 * cleanly, but `todo add` writes land in the queue, and the queue is persisted
 * from memory *after* the revert so the failure record survives — which meant
 * the children survived too. The loop then took the first of them and started
 * building. Every task in a truncated plan passes verification on its own
 * merits; nothing anywhere notices that six are missing. It does not halt, it
 * quietly builds the wrong thing, which is worse than stopping.
 *
 * Returns the ids removed. Descendants go too: a child that was itself broken
 * down before the cut cannot outlive its parent's rejection.
 */
export function discardChildren(store: Store, parentId: string): string[] {
	const doomed = descendantsOf(parentId, store.tasks);
	if (!doomed.length) return [];
	const ids = new Set(doomed.map((task) => task.id));
	store.tasks = store.tasks.filter((task) => !ids.has(task.id));
	return [...ids];
}

/**
 * Insert children directly after their parent's block rather than at the end of
 * the queue.
 *
 * Order is priority order under the native schema and `nextLeaf` reads it
 * literally, so appending would push freshly-scoped work behind every unrelated
 * epic — breadth-first sprawl instead of finishing one thing. Inserting in place
 * keeps the loop depth-first. Under a ranked schema position is only cosmetic,
 * but a child beside its parent still reads better in a diff.
 */
export function insertChildren(store: Store, parentId: string, children: Task[]): void {
	if (!children.length) return;
	// Acts first, plans after, each group in the order it was written.
	//
	// The "every round must land at least one act" rule is a property of the
	// *data* until this runs. Left in emission order, a round of [plan, plan,
	// act] dives into the first plan, which emits its own batch, and so on — the
	// act sits at the bottom of a subtree and might not run for hours. Ordering
	// it ahead of its plan siblings is what turns the rule into a heartbeat:
	// every planning round is followed immediately by something landing on disk.
	children = [
		...children.filter((child) => levelOf(child) !== "plan"),
		...children.filter((child) => levelOf(child) === "plan"),
	];
	const parent = findTask(store, parentId);
	if (!parent) {
		store.tasks.push(...children);
		return;
	}
	const block = descendantsOf(parentId, store.tasks).filter((task) => !task.archived);
	const last = block.length ? block[block.length - 1] : parent;
	const at = store.tasks.indexOf(last) + 1;
	store.tasks.splice(at, 0, ...children);
}

/** Mark parents done once every child is done; blocked children block the parent. */
export function rollup(store: Store): void {
	for (let pass = 0; pass < 8; pass++) {
		let changed = false;
		// Snapshot: archiving a parent moves it within the array, and mutating the
		// list being iterated skips its neighbour.
		for (const task of [...store.tasks]) {
			const kids = childrenOf(task.id, store.tasks);
			if (kids.length === 0) continue;
			// A plan is never finished on its children's behalf. Its batch being
			// done is what makes it *ready* again, not what makes it complete —
			// closing it here would end the branch at round one and delete the
			// revisit step the whole design turns on.
			if (levelOf(task) === "plan") continue;
			if (kids.every((kid) => kid.status === "done") && task.status !== "done") {
				markDone(store, task, task.summary ?? `All ${kids.length} subtasks complete.`, false);
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
		if (task.status !== "done" && needsPlanning(task, store.tasks)) out.pending_breakdowns += 1;
	}
	return out as Record<TaskStatus | "leaves" | "pending_breakdowns", number>;
}

export interface NewTask {
	id: string;
	title: string;
	detail?: string;
	parent?: string;
	level?: TaskLevel;
	kind?: ActKind;
	/** Rounds this branch may still close with research alone. Plans only. */
	research_budget?: number;
	/** Project-schema metadata. Ignored by a schema that has no field for it. */
	category?: string;
	urgency?: string;
}

/** Next `order`, ten past the highest in use — the project CLI's own 10, 20, 30. */
function nextOrder(store: Store): number {
	let highest = 0;
	for (const task of store.tasks) {
		if (task.archived) continue;
		const order = task.extra?.order;
		if (typeof order === "number" && order > highest) highest = order;
	}
	return highest + 10;
}

/**
 * A task in the shape the file already uses.
 *
 * Every writer of the queue goes through here, so a row the loop adds during a
 * breakdown is indistinguishable from one added by hand or by the project's own
 * CLI — same fields, same defaults, same order. A task that is missing the
 * metadata its siblings all carry is the tell that a foreign tool has been in
 * the file, and it makes the project's own `validate` the thing that catches it.
 */
export function createTask(store: Store, fields: NewTask): Task {
	const task: Task = { id: fields.id, title: fields.title, status: "todo", attempts: 0 };
	if (fields.detail) task.detail = fields.detail;
	if (fields.parent) task.parent = fields.parent;
	if (fields.level) task.level = fields.level;
	if (fields.level !== "plan" && fields.kind) task.kind = fields.kind;
	if (fields.level === "plan" && fields.research_budget !== undefined) {
		task.research_budget = Math.max(0, Math.trunc(fields.research_budget));
	}

	if (store.schema.name === "project") {
		task.extra = {
			category: fields.category ?? "feature",
			urgency: fields.urgency ?? "normal",
			order: nextOrder(store),
			created: todayRaw(),
			tags: [],
		};
	}
	return task;
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

/**
 * Move a finished task into the archive file.
 *
 * Follows the project CLI to the letter, because the two write the same file:
 * stamped `completed`, inserted newest-first, and stripped of the fields that
 * only rank *active* work. `parent` survives — what a scope actually delivered
 * is the question the archive exists to answer.
 */
function archiveTask(store: Store, task: Task): void {
	if (!store.archive || task.archived) return;
	const extra: TomlTable = { ...(task.extra ?? {}) };
	for (const key of RANKING_KEYS) delete extra[key];
	extra.completed = todayRaw();
	task.extra = extra;
	task.archived = true;

	const at = store.tasks.indexOf(task);
	if (at >= 0) store.tasks.splice(at, 1);
	const firstArchived = store.tasks.findIndex((other) => other.archived);
	store.tasks.splice(firstArchived < 0 ? store.tasks.length : firstArchived, 0, task);
}

export function markDone(store: Store, task: Task, summary: string, cascade = true): void {
	task.status = "done";
	task.summary = summary;
	task.done_at = new Date().toISOString();
	archiveTask(store, task);
	if (store.loop.current === task.id) store.loop.current = "";
	store.loop.last_failure = "";
	if (cascade) rollup(store);
}

export function markBlocked(store: Store, task: Task, reason: string): void {
	task.status = "blocked";
	task.reason = reason;
	store.loop.current = "";
	store.loop.running = false;
}

export function recordFailure(store: Store, task: Task, reason: string): number {
	task.attempts += 1;
	// Appended, not replaced: the next attempt should see the whole history, so
	// it can stop repeating an approach that has already been rejected once.
	const trimmed = reason.trim();
	if (trimmed) task.rejections = [...(task.rejections ?? []), trimmed];
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
 * Turn an act that proved too big into a plan, so the next pass decides what its
 * next few steps actually are instead of retrying the same oversized prompt.
 * Attempts reset — the act was never atomic, so the failures were not the
 * worker's fault.
 */
export function promoteToPlan(store: Store, task: Task, reason: string): void {
	task.level = "plan";
	task.level_raw = undefined;
	task.kind = undefined;
	task.status = "todo";
	task.attempts = 0;
	task.reason = reason;
	task.summary = undefined;
	task.done_at = undefined;
	// The rejections were about implementing it, and it is not going to be
	// implemented now. Carrying them into a breakdown prompt is noise.
	task.rejections = undefined;
	if (store.loop.current === task.id) store.loop.current = "";
	store.loop.last_failure = "";
}

export interface TreeOptions {
	/** Include tasks that have already been archived. Off by default: the archive can be long. */
	all?: boolean;
}

/** Indented one-line-per-task view for `todo status` and the /todo-status command. */
export function renderTree(store: Store, options: TreeOptions = {}): string {
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

	for (const task of workingOrder(store)) {
		if (task.archived && !options.all) continue;
		const indent = "  ".repeat(depth(task));
		const attempts = task.attempts > 0 && task.status !== "done" ? ` (${task.attempts} attempts)` : "";
		const reason = task.status === "blocked" && task.reason ? ` — ${task.reason}` : "";
		const level = levelOf(task) === "plan" ? " [plan]" : kindOf(task) === "code" ? "" : ` [${kindOf(task)}]`;
		const pending = task.status !== "done" && needsPlanning(task, store.tasks) ? " — not yet planned" : "";
		const over = task.overflowed ? " ⚠ too coarse" : "";
		const shipped = task.archived ? " (archived)" : "";
		const waiting = task.archived ? [] : unmetBlockers(task, store.tasks);
		const gated = waiting.length ? ` — waiting on ${waiting.join(", ")}` : "";
		lines.push(
			`${indent}${marks[task.status]} ${task.id}${level}: ${task.title}${attempts}${pending}${gated}${reason}${over}${shipped}`,
		);
	}

	return lines.join("\n");
}

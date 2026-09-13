/**
 * The two on-disk shapes a task file can have, and how to read either one.
 *
 * todo-loop grew its own `todo.toml`, but it is far more often pointed at a
 * queue a project already keeps — and the whole value of the loop is that it
 * works the *real* backlog rather than a copy of it. So the schema is detected
 * from the file rather than declared, and every write goes back out in the shape
 * it came in.
 *
 * Two schemas are recognised:
 *
 * - **native** — todo-loop's own. `detail`, `todo/doing/done/blocked`, priority
 *   is the order of the array, and everything the loop records lives on the task.
 * - **project** — the shape produced by a project's own todo CLI (see
 *   `docs/project-schema.md`). `description`, `active/in-progress/blocked` with
 *   finished work archived to a second file, priority from `urgency` then
 *   `order`, and a `[meta]` header the loop must not disturb.
 *
 * The project schema's own writer emits a fixed field list and silently drops
 * anything else, so the loop's bookkeeping cannot live on the task there. It
 * goes to a sidecar instead — see src/sidecar.ts. That is the single fact that
 * makes todo-loop a guest in someone else's file rather than a squatter in it.
 */

import { isTable, type TomlTable } from "./toml.ts";

export type SchemaName = "native" | "project";

/** Internal status vocabulary; the file's own words are mapped onto it. */
export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export interface Schema {
	name: SchemaName;
	/** Key holding the task's prose — the only context a worker ever gets. */
	detailKey: string;
	/** Internal status to the word this file uses for it. */
	statusOut: Record<TaskStatus, string>;
	/** Every word this file might use, mapped back to the internal status. */
	statusIn: Record<string, TaskStatus>;
	/** True when priority comes from `urgency`/`order` rather than file position. */
	ranked: boolean;
	/** True when finished tasks move to a second file rather than staying put. */
	archives: boolean;
	/** True when the loop's bookkeeping must be kept out of the task tables. */
	sidecar: boolean;
	/**
	 * Bookkeeping keys this schema has a home for, and which therefore stay on
	 * the task even when everything else moves to the sidecar.
	 *
	 * `reason` is the case this exists for: the loop's "why I blocked it" and the
	 * project's "why it is blocked" are the same fact, and the project's own
	 * validator requires it alongside a blocked status. Writing the status
	 * without the reason would leave a file its owner rejects.
	 */
	sharedFields: string[];
	/** Field write-order for tasks the loop creates, so new rows match old ones. */
	fieldOrder: string[];
}

export const NATIVE_SCHEMA: Schema = {
	name: "native",
	detailKey: "detail",
	statusOut: { todo: "todo", doing: "doing", done: "done", blocked: "blocked" },
	statusIn: { todo: "todo", doing: "doing", done: "done", blocked: "blocked" },
	ranked: false,
	archives: false,
	sidecar: false,
	sharedFields: [],
	fieldOrder: [
		"id",
		"title",
		"parent",
		"level",
		"status",
		"attempts",
		"detail",
		"started_at",
		"done_at",
		"summary",
		"reason",
		"overflowed",
		"overflow_reason",
	],
};

export const PROJECT_SCHEMA: Schema = {
	name: "project",
	detailKey: "description",
	// "doing" has a hyphen here and "done" is spelled "finished", and only ever
	// appears in the archive file.
	statusOut: { todo: "active", doing: "in-progress", done: "finished", blocked: "blocked" },
	statusIn: {
		active: "todo",
		"in-progress": "doing",
		finished: "done",
		blocked: "blocked",
		// A native word in a project file is still legible; read it rather than
		// quietly resetting the task to "todo".
		todo: "todo",
		doing: "doing",
		done: "done",
	},
	ranked: true,
	archives: true,
	sidecar: true,
	sharedFields: ["reason"],
	fieldOrder: [
		"id",
		"title",
		"description",
		"status",
		"reason",
		"level",
		"parent",
		"blocked_by",
		"category",
		"urgency",
		"order",
		"created",
		"completed",
		"tags",
	],
};

/** Urgency names, least urgent first — the project schema's own ladder. */
export const URGENCIES = ["low", "normal", "high", "critical"];

/**
 * Higher is more urgent. An urgency the ladder does not name sorts below `low`,
 * matching the project CLI, so a typo demotes a task rather than promoting it.
 */
export function urgencyRank(urgency: unknown): number {
	const at = URGENCIES.indexOf(typeof urgency === "string" ? urgency : "");
	return at < 0 ? -1 : at;
}

const PROJECT_MARKERS = ["description", "urgency", "order", "category", "completed"];

/**
 * Which schema a parsed document is written in.
 *
 * Deliberately generous: any one project-schema marker is enough, because the
 * cost of the two mistakes is wildly asymmetric. Reading a project file as
 * native loses every description and rewrites the file into a shape its own CLI
 * will not accept; reading a native file as project only means a couple of
 * fields are looked for and not found.
 */
export function detectSchema(doc: TomlTable): Schema {
	if (doc.schema_version !== undefined) return PROJECT_SCHEMA;
	if (isTable(doc.meta)) return PROJECT_SCHEMA;

	const tasks = Array.isArray(doc.task) ? (doc.task as TomlTable[]) : [];
	for (const task of tasks) {
		if (PROJECT_MARKERS.some((key) => task[key] !== undefined)) return PROJECT_SCHEMA;
		if (typeof task.status === "string" && task.status in PROJECT_SCHEMA.statusIn && !(task.status in NATIVE_SCHEMA.statusIn)) {
			return PROJECT_SCHEMA;
		}
	}
	return NATIVE_SCHEMA;
}

export function schemaNamed(name: string): Schema | undefined {
	if (name === "native") return NATIVE_SCHEMA;
	if (name === "project") return PROJECT_SCHEMA;
	return undefined;
}

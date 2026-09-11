/**
 * What the worker is told. Deliberately short: on a 27B, every token spent
 * restating the harness is a token not spent on the task.
 */

import { findTask, parentOf, type Store, type Task } from "./store.ts";

/** Parent titles, root first. A leaf without its ancestors reads as a non sequitur. */
export function ancestryOf(store: Store, task: Task): string[] {
	const chain: string[] = [];
	const seen = new Set<string>([task.id]);
	let parentId = parentOf(task, store.tasks);
	while (parentId && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = findTask(store, parentId);
		if (!parent) break;
		chain.unshift(`${parent.id}: ${parent.title}`);
		parentId = parentOf(parent, store.tasks);
	}
	return chain;
}

export interface PromptOptions {
	/** "tool" expects the worker to call todo_complete; "standalone" is the one-shot shell driver. */
	mode: "tool" | "standalone";
	lastFailure?: string;
	attempts?: number;
	maxAttempts?: number;
}

export function renderTaskPrompt(store: Store, task: Task, options: PromptOptions): string {
	const parts: string[] = [];
	const chain = ancestryOf(store, task);

	if (chain.length) parts.push(`Working within: ${chain.join(" › ")}`);
	parts.push(`# Task ${task.id}\n\n${task.title}`);
	if (task.detail) parts.push(task.detail.trim());

	parts.push(
		[
			"## Scope",
			"Do exactly this task. Do not start the next one, refactor beyond it, or fix unrelated problems you notice — note those instead and move on.",
		].join("\n"),
	);

	if (options.lastFailure) {
		const attempt = options.attempts ?? 0;
		const cap = options.maxAttempts ?? 3;
		parts.push(
			[
				`## Previous attempt was rejected (attempt ${attempt} of ${cap})`,
				options.lastFailure.trim(),
				"Address exactly what is missing. Do not redesign work that was already accepted.",
			].join("\n"),
		);
	}

	parts.push(
		options.mode === "tool"
			? [
					"## Finishing",
					"When the task is genuinely done, call `todo_complete` with a one-line summary. That call is the only way to finish — stopping without it halts the loop.",
					"If the task cannot be done as written, call `todo_block` with the reason instead of guessing.",
				].join("\n")
			: [
					"## Finishing",
					"When the task is genuinely done, stop. Your final message must be a one-line summary of what changed.",
					"If the task cannot be done as written, say `BLOCKED:` followed by the reason.",
				].join("\n"),
	);

	return parts.join("\n\n");
}

/**
 * Pinned into the system prompt, where no amount of context surgery can reach
 * it. The worker can lose its exploration; it must never lose the task.
 */
export function renderPinnedTask(store: Store, task: Task, lastFailure: string): string {
	const chain = ancestryOf(store, task);
	const lines = [
		"# Assigned task (do not lose track of this)",
		chain.length ? `Context: ${chain.join(" › ")}` : "",
		`${task.id}: ${task.title}`,
		task.detail ? task.detail.trim() : "",
		lastFailure ? `\nMost recent verification failure:\n${lastFailure.trim()}` : "",
		"",
		"Finish by calling todo_complete. Stopping without it halts the loop.",
	];
	return lines.filter(Boolean).join("\n");
}

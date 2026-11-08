/**
 * A verifier reached through pi itself, for providers this driver has no
 * endpoint for — a subscription login such as openai-codex, which has no API
 * key to put in a request. pi already holds the login and refreshes it, so the
 * driver asks pi to answer once: `pi -p --mode json`, no tools, no session, the
 * verifier's system prompt and the task in a file.
 *
 * Slower than a direct call (pi starts up for every verdict, a second or two),
 * and in exchange any model pi can use can judge the work.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Completer } from "./verify.ts";

export interface PiCallOptions {
	signal?: AbortSignal;
	/** How long one verdict may take. */
	timeoutMs?: number;
	/** For tests: the program run in pi's place. */
	command?: string;
}

/** The pi arguments for one answer from `provider/model`, the prompt in `promptFile`. */
export function piCallArgs(provider: string, model: string, system: string, promptFile: string): string[] {
	return [
		"-p",
		"--mode",
		"json",
		"--no-session",
		"--no-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--system-prompt",
		system,
		"--provider",
		provider,
		"--model",
		model,
		// A file, not argv: a large diff is past what one argument may hold.
		`@${promptFile}`,
	];
}

interface Message {
	role?: string;
	content?: string | { type?: string; text?: string }[];
	stopReason?: string;
	errorMessage?: string;
}

/** The last assistant text in pi's JSON event stream. Throws when there is none. */
export function lastReply(jsonl: string): string {
	let last: Message | undefined;
	for (const line of jsonl.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: { type?: string; messages?: Message[] };
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type !== "agent_end" || !Array.isArray(event.messages)) continue;
		last = [...event.messages].reverse().find((m) => m.role === "assistant");
	}
	if (!last) throw new Error("pi produced no reply");
	if (last.stopReason === "error" || last.stopReason === "aborted") {
		throw new Error(`model call ${last.stopReason}: ${last.errorMessage ?? "no message"}`);
	}
	const text =
		typeof last.content === "string"
			? last.content
			: (last.content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
	if (!text.trim()) throw new Error("the model replied with no text");
	return text;
}

export function piCompleter(provider: string, model: string, options: PiCallOptions = {}): Completer {
	const timeoutMs = options.timeoutMs ?? 300_000;
	return ({ system, user }) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "todo-verify-"));
		const promptFile = path.join(dir, "prompt.md");
		fs.writeFileSync(promptFile, user);
		const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
		return new Promise<string>((resolve, reject) => {
			const child = spawn(options.command ?? "pi", piCallArgs(provider, model, system, promptFile), {
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			const stop = () => child.kill("SIGTERM");
			options.signal?.addEventListener("abort", stop, { once: true });
			const timer = setTimeout(() => {
				stop();
				reject(new Error(`${provider}/${model} gave no verdict within ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			const done = () => {
				clearTimeout(timer);
				options.signal?.removeEventListener("abort", stop);
				cleanup();
			};
			child.on("error", (error) => {
				done();
				reject(new Error(`could not run pi: ${error.message}`));
			});
			child.on("close", (code) => {
				done();
				try {
					resolve(lastReply(stdout));
				} catch (error) {
					const tail = stderr.trim().split("\n").slice(-3).join(" | ");
					reject(new Error(`${(error as Error).message}${code ? ` (pi exited ${code})` : ""}${tail ? `: ${tail}` : ""}`));
				}
			});
		});
	};
}

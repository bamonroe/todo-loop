/**
 * Evidence, not testimony.
 *
 * The verifier sees the task text, the diff, and command output. It never sees
 * the worker's conversation or the worker's own claim that the task is done —
 * a model shown another model's confident self-report agrees with it at a rate
 * unrelated to whether the work is correct.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface CommandRun {
	command: string;
	ok: boolean;
	code: number;
	output: string;
}

export interface Evidence {
	diff: string;
	files: string[];
	dirty: boolean;
	commands: CommandRun[];
	/** Mechanical failure that short-circuits the model call entirely. */
	hardFailure?: string;
}

/** Keep the tail: for logs and command output the end is where the verdict is. */
export function truncateTail(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const slice = Buffer.from(text, "utf8").subarray(-maxBytes).toString("utf8");
	const cut = slice.indexOf("\n");
	const body = cut >= 0 ? slice.slice(cut + 1) : slice;
	return `[... truncated to last ${maxBytes} bytes ...]\n${body}`;
}

export function truncateHead(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const slice = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
	return `${slice}\n[... truncated after ${maxBytes} bytes ...]`;
}

async function git(cwd: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
	try {
		const { stdout } = await run("git", args, { cwd, maxBuffer });
		return stdout;
	} catch {
		return "";
	}
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
}

export async function headCommit(cwd: string): Promise<string> {
	return (await git(cwd, ["rev-parse", "HEAD"])).trim();
}

export async function isTreeClean(cwd: string): Promise<boolean> {
	return (await git(cwd, ["status", "--porcelain"])).trim() === "";
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
	await git(cwd, ["add", "-A"]);
	if (await isTreeClean(cwd)) return false;
	await git(cwd, ["commit", "-m", message, "--no-verify"]);
	return true;
}

/** Everything that changed since the task started: committed, staged, unstaged and untracked. */
export async function collectDiff(cwd: string, baseCommit: string, maxBytes: number): Promise<{ diff: string; files: string[]; dirty: boolean }> {
	if (!(await isGitRepo(cwd))) {
		return { diff: "(not a git repository — no diff available)", files: [], dirty: false };
	}

	const range = baseCommit ? [`${baseCommit}..HEAD`] : [];
	const parts: string[] = [];
	const files = new Set<string>();

	if (baseCommit) {
		const committed = await git(cwd, ["diff", ...range]);
		if (committed.trim()) parts.push(`# committed since task start\n${committed}`);
		for (const file of (await git(cwd, ["diff", "--name-only", ...range])).split("\n")) {
			if (file.trim()) files.add(file.trim());
		}
	}

	const working = await git(cwd, ["diff", "HEAD"]);
	if (working.trim()) parts.push(`# uncommitted working tree\n${working}`);
	for (const file of (await git(cwd, ["diff", "--name-only", "HEAD"])).split("\n")) {
		if (file.trim()) files.add(file.trim());
	}

	const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard"]))
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (const file of untracked) files.add(file);
	if (untracked.length) {
		const shown: string[] = [];
		for (const file of untracked.slice(0, 20)) {
			const body = await git(cwd, ["diff", "--no-index", "--", "/dev/null", file]);
			shown.push(body || `# new file ${file} (binary or unreadable)`);
		}
		parts.push(`# new untracked files\n${shown.join("\n")}`);
	}

	const dirty = !(await isTreeClean(cwd));
	const diff = parts.join("\n\n").trim() || "(no changes)";
	return { diff: truncateHead(diff, maxBytes), files: [...files], dirty };
}

/** Just the names — for compaction summaries, where the diff itself is too big. */
export async function changedFiles(cwd: string, baseCommit: string): Promise<string[]> {
	if (!(await isGitRepo(cwd))) return [];
	const names = new Set<string>();
	const sources = [
		baseCommit ? ["diff", "--name-only", `${baseCommit}..HEAD`] : undefined,
		["diff", "--name-only", "HEAD"],
		["ls-files", "--others", "--exclude-standard"],
	];
	for (const args of sources) {
		if (!args) continue;
		for (const line of (await git(cwd, args)).split("\n")) {
			if (line.trim()) names.add(line.trim());
		}
	}
	return [...names];
}

export async function runCommand(cwd: string, command: string, timeoutMs: number, maxBytes: number): Promise<CommandRun> {
	if (!command.trim()) return { command, ok: true, code: 0, output: "(not configured)" };
	try {
		const { stdout, stderr } = await run("bash", ["-lc", command], {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		});
		return { command, ok: true, code: 0, output: truncateTail(`${stdout}${stderr}`.trim() || "(no output)", maxBytes) };
	} catch (error) {
		const err = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
		const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "(no output)";
		return {
			command,
			ok: false,
			code: typeof err.code === "number" ? err.code : 1,
			output: truncateTail(output, maxBytes),
		};
	}
}

export interface EvidenceOptions {
	cwd: string;
	baseCommit: string;
	testCommand: string;
	buildCommand: string;
	requireTestsPass: boolean;
	timeoutMs: number;
	maxBytes: number;
}

/**
 * Let tools answer the mechanical questions. If the build or tests fail there
 * is nothing for a model to judge, so we short-circuit before spending a call.
 */
export async function gatherEvidence(options: EvidenceOptions): Promise<Evidence> {
	const perPart = Math.max(1000, Math.floor(options.maxBytes / 3));
	const { diff, files, dirty } = await collectDiff(options.cwd, options.baseCommit, perPart);

	const commands: CommandRun[] = [];
	for (const command of [options.buildCommand, options.testCommand]) {
		if (!command.trim()) continue;
		commands.push(await runCommand(options.cwd, command, options.timeoutMs, perPart));
	}

	const failed = commands.find((entry) => !entry.ok);
	const hardFailure =
		options.requireTestsPass && failed
			? `Command failed (exit ${failed.code}): ${failed.command}\n${failed.output}`
			: diff === "(no changes)"
				? "No file changes were made for this task."
				: undefined;

	return { diff, files, dirty, commands, hardFailure };
}

export function formatEvidence(task: { id: string; title: string; detail?: string }, evidence: Evidence): string {
	const sections = [
		`## Task\n${task.id}: ${task.title}${task.detail ? `\n\n${task.detail}` : ""}`,
		`## Files changed\n${evidence.files.length ? evidence.files.join("\n") : "(none)"}`,
		`## Diff\n${evidence.diff}`,
	];
	for (const command of evidence.commands) {
		sections.push(`## Command: ${command.command}\nexit ${command.code}\n${command.output}`);
	}
	return sections.join("\n\n");
}

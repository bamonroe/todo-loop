/**
 * Evidence, not testimony.
 *
 * The verifier sees the task text, the diff, and command output. It never sees
 * the worker's conversation or the worker's own claim that the task is done —
 * a model shown another model's confident self-report agrees with it at a rate
 * unrelated to whether the work is correct.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	/**
	 * Results from the worker's own tools, captured as they ran. Present only
	 * when `verify.evidence_tools` names something the session actually called.
	 */
	toolEvidence?: string;
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

const MAX_NEW_FILES = 20;

/**
 * A synthetic diff for a file git has never seen.
 *
 * `git diff --no-index` exits non-zero whenever the files differ, which is
 * always the case here, so routing it through the helper below silently
 * produced empty output — and new files are the single most common result of a
 * task. Reading the file directly avoids the whole question.
 */
async function newFileDiff(cwd: string, file: string, maxBytes: number): Promise<string> {
	let contents: Buffer;
	try {
		contents = await fs.readFile(path.join(cwd, file));
	} catch {
		return `# new file ${file} (unreadable)`;
	}
	if (contents.includes(0)) return `# new file ${file} (binary, ${contents.length} bytes)`;

	const body = contents
		.toString("utf8")
		.split("\n")
		.map((line) => `+${line}`)
		.join("\n");
	return `--- /dev/null\n+++ b/${file}\n${truncateHead(body, maxBytes)}`;
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

/**
 * Clean enough to start a task in. `ignore` drops the files the loop itself
 * owns, and it is not a nicety: `todo run` writes its own state file before the
 * first iteration, so without this the loop dirties the tree and then refuses
 * to start because the tree is dirty — on every repo where that file is not
 * committed yet, which is every first run.
 *
 * Callers that want the strict question — did `git add -A` actually stage
 * anything — pass nothing.
 */
export async function isTreeClean(cwd: string, ignore: string[] = []): Promise<boolean> {
	// Split before trimming, never after. A porcelain line is "XY path", and an
	// unstaged edit leaves X blank — so trimming the whole output eats the first
	// line's leading space, shifts its path two characters left, and the entry
	// matches nothing in `ignore`. With one modified file, which is the usual
	// case, that silently defeats every exclusion the caller passed.
	const lines = (await git(cwd, ["status", "--porcelain"])).split("\n").filter((line) => line.trim());
	if (!lines.length) return true;
	if (!ignore.length) return false;
	const ignored = new Set(ignore);
	return lines.every((line) => ignored.has(statusPath(line)));
}

/** The path a --porcelain line refers to; a rename reports "old -> new". */
function statusPath(line: string): string {
	const body = line.slice(3).trim();
	const arrow = body.indexOf(" -> ");
	const file = arrow === -1 ? body : body.slice(arrow + 4);
	return file.replace(/^"(.*)"$/, "$1");
}

export async function commitAll(cwd: string, message: string): Promise<boolean> {
	await git(cwd, ["add", "-A"]);
	if (await isTreeClean(cwd)) return false;
	await git(cwd, ["commit", "-m", message, "--no-verify"]);
	return true;
}

/**
 * Paths kept out of the evidence by default. The queue and its config change on
 * every task; showing the verifier that churn is pure noise, and worse, it makes
 * a task that touched nothing else look like it did something.
 */
export const DEFAULT_EXCLUDES = ["todo.toml", "todoloop.toml"];

/**
 * The queue files the loop writes, relative to `cwd` and deduplicated. Which
 * ones those are depends on the schema — a project queue is three files, not
 * one — so the list is built from the store rather than fixed.
 */
export function loopOwnedPaths(cwd: string, files: Array<string | undefined>): string[] {
	const relative = (file?: string): string | undefined => {
		if (!file) return undefined;
		const rel = path.relative(cwd, file);
		return rel && !rel.startsWith("..") ? rel : undefined;
	};
	const paths = [...files.map(relative), ...DEFAULT_EXCLUDES];
	return [...new Set(paths.filter((value): value is string => Boolean(value)))];
}

function excludeSpecs(exclude: string[]): string[] {
	return exclude.length ? ["--", ...exclude.map((path) => `:(exclude)${path}`)] : [];
}

/** Everything that changed since the task started: committed, staged, unstaged and untracked. */
export async function collectDiff(
	cwd: string,
	baseCommit: string,
	maxBytes: number,
	exclude: string[] = DEFAULT_EXCLUDES,
): Promise<{ diff: string; files: string[]; dirty: boolean }> {
	if (!(await isGitRepo(cwd))) {
		return { diff: "(not a git repository — no diff available)", files: [], dirty: false };
	}

	const range = baseCommit ? [`${baseCommit}..HEAD`] : [];
	const specs = excludeSpecs(exclude);
	const parts: string[] = [];
	const files = new Set<string>();

	if (baseCommit) {
		const committed = await git(cwd, ["diff", ...range, ...specs]);
		if (committed.trim()) parts.push(`# committed since task start\n${committed}`);
		for (const file of (await git(cwd, ["diff", "--name-only", ...range, ...specs])).split("\n")) {
			if (file.trim()) files.add(file.trim());
		}
	}

	const working = await git(cwd, ["diff", "HEAD", ...specs]);
	if (working.trim()) parts.push(`# uncommitted working tree\n${working}`);
	for (const file of (await git(cwd, ["diff", "--name-only", "HEAD", ...specs])).split("\n")) {
		if (file.trim()) files.add(file.trim());
	}

	const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", ...specs]))
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (const file of untracked) files.add(file);
	if (untracked.length) {
		const shown: string[] = [];
		for (const file of untracked.slice(0, MAX_NEW_FILES)) {
			shown.push(await newFileDiff(cwd, file, maxBytes));
		}
		if (untracked.length > MAX_NEW_FILES) {
			shown.push(`# ${untracked.length - MAX_NEW_FILES} further new files not shown`);
		}
		parts.push(`# new untracked files\n${shown.join("\n\n")}`);
	}

	// Dirtiness is about the task's own work, so it ignores the excluded paths too.
	const dirty = files.size > 0;
	const diff = parts.join("\n\n").trim() || "(no changes)";
	return { diff: truncateHead(diff, maxBytes), files: [...files], dirty };
}

/** Just the names — for compaction summaries, where the diff itself is too big. */
export async function changedFiles(
	cwd: string,
	baseCommit: string,
	exclude: string[] = DEFAULT_EXCLUDES,
): Promise<string[]> {
	if (!(await isGitRepo(cwd))) return [];
	const names = new Set<string>();
	const specs = excludeSpecs(exclude);
	const sources = [
		baseCommit ? ["diff", "--name-only", `${baseCommit}..HEAD`, ...specs] : undefined,
		["diff", "--name-only", "HEAD", ...specs],
		["ls-files", "--others", "--exclude-standard", ...specs],
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

/**
 * Where a project's worker records tool results for the verifier.
 *
 * Keyed on the project path rather than a pid so the driver and anything else
 * that needs to find it — a test, a person debugging a rejection — agree on one
 * name without passing it around. Outside the repository, always: the
 * checkpoint commit is `git add -A`, and evidence about a task has no business
 * being committed as part of it.
 */
export function evidenceFilePath(cwd: string): string {
	const tag = createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 8);
	return path.join(os.tmpdir(), `todo-loop-evidence-${path.basename(cwd)}-${tag}.md`);
}

export interface EvidenceOptions {
	cwd: string;
	baseCommit: string;
	testCommand: string;
	buildCommand: string;
	requireTestsPass: boolean;
	timeoutMs: number;
	maxBytes: number;
	/** Paths kept out of the diff; defaults to the queue and its config. */
	exclude?: string[];
	/**
	 * Where the session recorded results from `verify.evidence_tools`. Read if
	 * it exists; a missing file means the worker called none of them, which is
	 * not an error — most tasks need none.
	 */
	evidenceFile?: string;
}

/**
 * Files a build cannot be broken by, and cannot be fixed by either.
 *
 * Conservative on purpose: an extension that is not on this list counts as
 * code, so an unfamiliar file makes the build run. The failure this guards
 * against is skipping a check that mattered; running one that did not is only
 * slow.
 */
const DOC_EXTENSIONS = [".md", ".markdown", ".rst", ".txt", ".adoc"];

/**
 * Whether a task's whole diff is documentation.
 *
 * Earned by run 11, which halted on this in twenty minutes. A planning round
 * put a documentation act first — write the acceptance criteria into NOTES.md,
 * change nothing else — and the act did exactly that. Verification then ran the
 * build, as it does for every task, and the project had no Gradle scaffold yet
 * because that was the *next* item. Exit 2, rejected, for a failure the task
 * could not have caused and could not have prevented. The retry drew the only
 * conclusion available to it and scaffolded the entire project inside the
 * documentation task, which the verifier then rejected for touching twelve
 * files — and failed-and-oversized is exactly the precondition for promote, so
 * a one-file note became a plan waiting to be broken down.
 *
 * Judged on the diff rather than on the act's declared `kind`: a docs act that
 * did touch code still gets built, which is the loophole a kind-based test
 * would have opened, and it costs nothing to be right about a code act that
 * happened to change only a README.
 *
 * An empty diff is not documentation. Nothing changed is its own failure and
 * belongs to the caller, not here.
 */
export function documentationOnly(files: string[]): boolean {
	if (!files.length) return false;
	return files.every((file) => DOC_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext)));
}

/**
 * Let tools answer the mechanical questions. If the build or tests fail there
 * is nothing for a model to judge, so we short-circuit before spending a call.
 */
export async function gatherEvidence(options: EvidenceOptions): Promise<Evidence> {
	const perPart = Math.max(1000, Math.floor(options.maxBytes / 3));
	const { diff, files, dirty } = await collectDiff(
		options.cwd,
		options.baseCommit,
		perPart,
		options.exclude ?? DEFAULT_EXCLUDES,
	);

	// Reported as not run rather than quietly omitted: the verifier is told what
	// was checked, and "documentation only" is a fact about the task it should
	// weigh, not a gap it has to infer from a missing section.
	const skip = documentationOnly(files);
	const commands: CommandRun[] = [];
	for (const command of [options.buildCommand, options.testCommand]) {
		if (!command.trim()) continue;
		commands.push(
			skip
				? { command, ok: true, code: 0, output: "(not run: every changed file is documentation)" }
				: await runCommand(options.cwd, command, options.timeoutMs, perPart),
		);
	}

	// Read, never run: by the time this executes the session is over. The file is
	// the only channel from inside the worker's session to the verifier, and it
	// carries what the tools returned rather than what the worker said they did.
	const toolEvidence = await readToolEvidence(options.evidenceFile, perPart);

	const failed = commands.find((entry) => !entry.ok);
	const hardFailure =
		options.requireTestsPass && failed
			? `Command failed (exit ${failed.code}): ${failed.command}\n${failed.output}`
			: diff === "(no changes)"
				? "No file changes were made for this task."
				: undefined;

	return { diff, files, dirty, commands, toolEvidence, hardFailure };
}

/**
 * A tool's own output is not a hard failure even when it failed. The build and
 * test commands are the gate; this is context for the model's judgement, and a
 * failed install the worker then fixed should not reject a task that is right
 * by the end of it.
 */
async function readToolEvidence(file: string | undefined, maxBytes: number): Promise<string | undefined> {
	if (!file) return undefined;
	try {
		const text = (await fs.readFile(file, "utf8")).trim();
		return text ? truncateTail(text, maxBytes) : undefined;
	} catch {
		return undefined;
	}
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
	if (evidence.toolEvidence) {
		sections.push(
			"## Tool evidence recorded during the session\n" +
				"Captured from the worker's tool calls as they ran — this is the tools' own output, not the worker's account of it.\n\n" +
				evidence.toolEvidence,
		);
	}
	return sections.join("\n\n");
}

/**
 * Throw away a failed attempt's edits so the next attempt starts from the same
 * tree the first one did.
 *
 * Without this the retry path is dead code. `todo run` gates every iteration on
 * a clean tree when `checkpoint = "require-clean"` — the default — but a
 * rejected task's files are still on disk, so iteration N+1 sees the wreckage of
 * iteration N and refuses to start. The loop then stops on the *first* failed
 * verification, however many attempts `max_attempts` promised. Observed on a
 * real run: one unresolved Kotlin reference ended a fourteen-iteration night at
 * iteration two.
 *
 * Refuses to move HEAD. `base` is the commit the task started from, and at
 * rejection time nothing has been committed, so it should already be HEAD; if it
 * is not, something committed behind the loop's back and discarding it is not
 * this function's call to make.
 */
export async function revertTo(cwd: string, base: string): Promise<boolean> {
	if (!base) return false;
	if ((await headCommit(cwd)) !== base) return false;
	await git(cwd, ["reset", "--hard", base]);
	// No -x: ignored files stay. The loop's own state file is gitignored in a
	// well-set-up project, and deleting it mid-run would lose the attempt count
	// this revert exists to make useful.
	await git(cwd, ["clean", "-fd"]);
	return true;
}

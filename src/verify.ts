/**
 * A second opinion before a todo closes.
 *
 * Constraints that make this useful rather than decorative:
 *   - evidence only, never the worker's self-report
 *   - a different model from the worker
 *   - a forced schema and a hard attempt cap
 *   - report gaps, never fixes; two models negotiating a design is how the
 *     work drifts away from what the todo actually said
 */

import { formatEvidence, type Evidence } from "./evidence.ts";

export interface Verdict {
	pass: boolean;
	reason: string;
	/** True when the verdict came from tooling rather than the model. */
	mechanical?: boolean;
}

export interface VerifyTask {
	id: string;
	title: string;
	detail?: string;
}

/** Any "send these messages, get text back" backend. */
export type Completer = (input: { system: string; user: string }) => Promise<string>;

export const VERIFIER_SYSTEM_PROMPT = [
	"You are a verification agent. You decide one narrow question: does this diff do what the task text asked?",
	"",
	"You are given the task text, the list of changed files, the diff, and the output of any build or test commands.",
	"You are NOT given the implementer's account of what it did. Judge the evidence only.",
	"",
	"Rules:",
	"- Pass if the diff plausibly accomplishes what the task asked, even if the style is not what you would choose.",
	"- Fail if the diff does something adjacent to the task instead of the task, is obviously incomplete, or is empty.",
	"- Do not review for general code quality, naming, or architecture. That is not your job here.",
	"- When you fail something, state what is missing. Never state how to fix it.",
	"",
	'Reply with JSON only, no prose and no code fence: {"pass": true|false, "reason": "one or two sentences"}',
].join("\n");

export function buildVerifierPrompt(task: VerifyTask, evidence: Evidence): string {
	return `${formatEvidence(task, evidence)}\n\n## Question\nDoes the evidence above show that the task was done? Reply with JSON only.`;
}

/**
 * Local models wrap JSON in prose, code fences, or <think> blocks often enough
 * that a bare JSON.parse throws away good verdicts.
 */
export function parseVerdict(raw: string): Verdict | undefined {
	const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

	const candidates: string[] = [];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) candidates.push(fenced[1]);
	const braced = text.match(/\{[\s\S]*\}/);
	if (braced) candidates.push(braced[0]);
	candidates.push(text);

	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate.trim()) as { pass?: unknown; reason?: unknown };
			if (typeof parsed.pass === "boolean") {
				return { pass: parsed.pass, reason: String(parsed.reason ?? "").trim() || "(no reason given)" };
			}
		} catch {
			// try the next candidate
		}
	}

	// Last resort: an unambiguous verbal verdict.
	if (/^\s*(pass|passed|yes)\b/i.test(text)) return { pass: true, reason: text.slice(0, 300) };
	if (/^\s*(fail|failed|no)\b/i.test(text)) return { pass: false, reason: text.slice(0, 300) };
	return undefined;
}

export async function verify(task: VerifyTask, evidence: Evidence, complete: Completer): Promise<Verdict> {
	if (evidence.hardFailure) {
		return { pass: false, reason: evidence.hardFailure, mechanical: true };
	}

	let raw: string;
	try {
		raw = await complete({ system: VERIFIER_SYSTEM_PROMPT, user: buildVerifierPrompt(task, evidence) });
	} catch (error) {
		// An unreachable verifier must not silently pass work.
		return { pass: false, reason: `Verifier call failed: ${(error as Error).message}`, mechanical: true };
	}

	const verdict = parseVerdict(raw);
	if (!verdict) {
		return { pass: false, reason: `Verifier returned no usable verdict: ${raw.slice(0, 200)}`, mechanical: true };
	}
	return verdict;
}

/** Completer backed by an OpenAI-compatible endpoint — Ollama by default. */
export function ollamaCompleter(baseUrl: string, model: string, signal?: AbortSignal): Completer {
	return async ({ system, user }) => {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer ollama" },
			body: JSON.stringify({
				model,
				temperature: 0,
				stream: false,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
			}),
			signal,
		});
		if (!response.ok) {
			throw new Error(`${response.status} ${response.statusText} from ${baseUrl}`);
		}
		const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
		return body.choices?.[0]?.message?.content ?? "";
	};
}

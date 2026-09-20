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

/** Everything needed to reach one OpenAI-compatible chat endpoint. */
export interface ChatEndpoint {
	baseUrl: string;
	model: string;
	apiKey: string;
	/** Provider-specific extras, e.g. opencode-go's required session header. */
	headers?: Record<string, string>;
	/**
	 * Left unset for local servers, where an unbounded reply costs nothing but
	 * time. Set it for metered endpoints, and set it generously: on a reasoning
	 * model the thinking tokens come out of the same budget as the verdict.
	 */
	maxTokens?: number;
	/**
	 * Extra top-level request fields — sampling, and `reasoning_effort` where the
	 * server honours it. Merged over the defaults below, so a caller that sets
	 * nothing still gets the deterministic judging temperature that suits a
	 * hosted model.
	 */
	params?: Record<string, unknown>;
	signal?: AbortSignal;
}

/** Completer backed by an OpenAI-compatible chat endpoint. */
export function chatCompleter(endpoint: ChatEndpoint): Completer {
	return async ({ system, user }) => {
		const body: Record<string, unknown> = {
			model: endpoint.model,
			// Right for a hosted judge, and overridden for a local one: on a local
			// reasoning model temperature 0 is what sends thinking mode into a
			// loop. See the ollama section of src/config.ts.
			temperature: 0,
			stream: false,
			...endpoint.params,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		};
		if (endpoint.maxTokens) body.max_tokens = endpoint.maxTokens;

		const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${endpoint.apiKey}`,
				...endpoint.headers,
			},
			body: JSON.stringify(body),
			signal: endpoint.signal,
		});
		if (!response.ok) {
			// The body carries the useful part — "model is unavailable" beats "400".
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			throw new Error(`${response.status} ${response.statusText} from ${endpoint.baseUrl}${detail ? `: ${detail}` : ""}`);
		}
		const payload = (await response.json()) as {
			choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[];
		};
		const choice = payload.choices?.[0];
		const message = choice?.message;

		// A reasoning model that spends its whole budget thinking returns an empty
		// content *and* an empty reasoning_content — ollama drops the partial
		// thinking rather than handing it back. Undiagnosed, that arrives as
		// "returned no usable verdict: " with nothing after the colon, which looks
		// like a broken model rather than a cap that is set too low.
		if (choice?.finish_reason === "length" && !message?.content?.trim() && !message?.reasoning_content?.trim()) {
			throw new Error(
				`the verifier used its entire ${endpoint.maxTokens ?? "output"}-token budget on thinking and returned no verdict — ` +
					"raise ollama.max_tokens, or lower ollama.reasoning_effort",
			);
		}
		// Reasoning models that hit the token cap mid-thought leave content empty
		// but the verdict visible in reasoning_content. Rescue it rather than
		// failing closed on a task that may well be fine.
		return message?.content?.trim() ? message.content : (message?.reasoning_content ?? "");
	};
}

/** Completer backed by a local Ollama server. */
export function ollamaCompleter(baseUrl: string, model: string, signal?: AbortSignal): Completer {
	return chatCompleter({ baseUrl, model, apiKey: "ollama", signal });
}

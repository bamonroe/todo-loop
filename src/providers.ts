/**
 * Where a model reference actually points, and what it costs to get there.
 *
 * The verifier does not have to live on the same machine as the worker. On a
 * single GPU it usually should not: a local verifier evicts the worker on every
 * task, and the reload dominates the run. A small hosted model removes that
 * contention entirely and is genuinely independent of the worker, which is the
 * property the whole check rests on.
 *
 * The trade is real and worth stating plainly: a hosted verifier sends the task
 * text, the changed file list and the diff to a third party, and it is metered.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Config } from "./config.ts";
import { splitModelRef } from "./config.ts";
import { chatCompleter, type Completer } from "./verify.ts";

export interface Endpoint {
	provider: string;
	model: string;
	baseUrl: string;
	apiKey: string;
	headers?: Record<string, string>;
	maxTokens?: number;
	/** True when the request leaves this machine. */
	remote: boolean;
	/** Set when the endpoint cannot be used as configured; the reason is user-facing. */
	problem?: string;
}

interface RemoteProvider {
	baseUrl: string;
	/** Environment variables to check, in order, before falling back to pi's auth file. */
	envVars: string[];
	/** pi stores credentials per provider id in ~/.pi/agent/auth.json. */
	authKey: string;
	label: string;
	/** Extra headers the endpoint requires. */
	headers?: () => Record<string, string>;
}

/**
 * opencode-go refuses requests without a session id, so it can route them to a
 * warm shard. One id per process is the right granularity: a loop's verify
 * calls are the same conversation as far as routing cares.
 */
let goSessionId: string | undefined;
function opencodeGoSession(): string {
	goSessionId ??= `todoloop-${crypto.randomUUID()}`;
	return goSessionId;
}

export const REMOTE_PROVIDERS: Record<string, RemoteProvider> = {
	opencode: {
		baseUrl: "https://opencode.ai/zen/v1",
		envVars: ["OPENCODE_API_KEY"],
		authKey: "opencode",
		label: "OpenCode Zen",
	},
	"opencode-go": {
		baseUrl: "https://opencode.ai/zen/go/v1",
		envVars: ["OPENCODE_API_KEY"],
		authKey: "opencode-go",
		label: "OpenCode Go",
		headers: () => ({ "x-opencode-session": opencodeGoSession() }),
	},
};

/** pi's credential store, so a key set up once with pi is not set up again here. */
export function piAuthKey(provider: string): string | undefined {
	const home = process.env.HOME;
	if (!home) return undefined;
	const file = path.join(process.env.PI_CONFIG_DIR ?? path.join(home, ".pi", "agent"), "auth.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		const entry = parsed[provider];
		if (typeof entry === "string") return entry.trim() || undefined;
		if (entry && typeof entry === "object") {
			const key = (entry as { key?: unknown }).key;
			if (typeof key === "string" && key.trim()) return key;
		}
	} catch {
		// No auth file, or not readable. Environment variables are still an option.
	}
	return undefined;
}

export function resolveApiKey(provider: string): string | undefined {
	const remote = REMOTE_PROVIDERS[provider];
	if (!remote) return undefined;
	for (const name of remote.envVars) {
		const value = process.env[name];
		if (value?.trim()) return value.trim();
	}
	return piAuthKey(remote.authKey);
}

/**
 * Resolve a "provider/model" reference into something callable. Never throws:
 * an unusable reference comes back with `problem` set so `todo doctor` can
 * report it as a check rather than a stack trace.
 */
export function endpointFor(ref: string, config: Config): Endpoint {
	const { provider, model } = splitModelRef(ref);

	if (provider === "ollama") {
		return {
			provider,
			model,
			baseUrl: config.ollama.base_url,
			apiKey: "ollama",
			remote: false,
		};
	}

	const remote = REMOTE_PROVIDERS[provider];
	if (!remote) {
		return {
			provider,
			model,
			baseUrl: "",
			apiKey: "",
			remote: true,
			problem:
				`unknown provider "${provider}" — this driver speaks ollama, ${Object.keys(REMOTE_PROVIDERS).join(" and ")}. ` +
				"Any other provider still works in-session, where pi's own model registry resolves it.",
		};
	}

	const apiKey = resolveApiKey(provider);
	return {
		provider,
		model,
		baseUrl: remote.baseUrl,
		apiKey: apiKey ?? "",
		headers: remote.headers?.(),
		// Generous on purpose: thinking tokens and the verdict share this budget.
		maxTokens: 4096,
		remote: true,
		problem: apiKey
			? undefined
			: `no API key for ${remote.label} — set ${remote.envVars[0]} or run: pi auth check --provider ${remote.authKey}`,
	};
}

/**
 * A completer for the given reference. A broken reference yields a completer
 * that rejects, so the failure lands inside `verify`'s own error handling and
 * fails the task closed instead of escaping as an unhandled throw.
 */
export function completerFor(ref: string, config: Config, signal?: AbortSignal): Completer {
	const endpoint = endpointFor(ref, config);
	if (endpoint.problem) {
		const reason = endpoint.problem;
		return async () => {
			throw new Error(reason);
		};
	}
	return chatCompleter({
		baseUrl: endpoint.baseUrl,
		model: endpoint.model,
		apiKey: endpoint.apiKey,
		headers: endpoint.headers,
		maxTokens: endpoint.maxTokens,
		signal,
	});
}

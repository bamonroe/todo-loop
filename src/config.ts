/**
 * todoloop.toml — every model choice and threshold in one file.
 * Missing file is fine; the defaults below are the whole contract.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseToml } from "./toml.ts";

export interface Config {
	models: {
		/**
		 * Worker model, as "provider/model". Both loop shapes honour it: the shell
		 * driver passes it to `pi -p`, and in-session the extension sets it on each
		 * fresh session. "inherit" leaves whatever pi is already configured to use.
		 *
		 * `todo --provider` and `todo --model` override it for a single run, so the
		 * default here is a starting point rather than a commitment.
		 *
		 * Note that pi's `--model` flag reads a trailing `:suffix` as a thinking
		 * level, so an ollama tag like `qwen3.8-27b:52k` cannot be passed through
		 * it. "inherit" sidesteps that entirely.
		 */
		worker: string;
		/**
		 * Verifier model. Should differ from the worker — a model judging itself is
		 * the weakest version of this check.
		 *
		 * A hosted model is usually the right answer on a single GPU: a local
		 * verifier evicts the worker on every task. See src/providers.ts.
		 */
		verifier: string;
	};
	verify: {
		enabled: boolean;
		max_attempts: number;
		test_command: string;
		build_command: string;
		require_tests_pass: boolean;
		max_evidence_bytes: number;
		timeout_ms: number;
	};
	loop: {
		max_iterations: number;
		/**
		 * A ladder of strictness, each rung doing what the one below it does:
		 * "off" ignores git, "commit" auto-commits each verified task, and
		 * "require-clean" commits *and* refuses to start a task with a dirty tree.
		 *
		 * "require-clean" is the default because the commit is `git add -A`: work
		 * already in the tree when the loop starts gets swept into a commit named
		 * after a task that did not do it, and the task's own diff is then wrong
		 * for the verifier too. Refusing to start is the cheap end of that.
		 */
		checkpoint: "commit" | "require-clean" | "off";
		commit_prefix: string;
		/** What to do when a run ends without the worker calling todo_complete. */
		on_silent_stop: "halt" | "retry";
	};
	decompose: {
		/**
		 * Smallest breakdown accepted. One child is a rename, not a breakdown; a
		 * scope that really is a single atomic task should be blocked instead, and
		 * the prompt says so.
		 */
		min_children: number;
	};
	atomic: {
		/**
		 * A leaf task whose diff touches more files than this was almost certainly
		 * not atomic. Recorded as an overflow, not failed — the work may well be
		 * correct, and the diff is still judged on its merits.
		 */
		max_files: number;
		/**
		 * What to do when a leaf task overruns its context budget.
		 *
		 * warn: record it on the task and surface it in status and doctor.
		 * promote: turn it into a scope so the next pass breaks it down.
		 * off: ignore.
		 */
		on_overflow: "warn" | "promote" | "off";
	};
	context: {
		/** Start eliding old tool results once context passes this fraction of the window. */
		prune_at_fraction: number;
		/** Assistant turns kept verbatim at the tail. */
		keep_full_turns: number;
		/** Only tool results at least this large get stubbed. */
		stub_min_bytes: number;
		/** Cap on bash/grep output entering context at all. */
		tool_output_max_bytes: number;
	};
	ollama: {
		base_url: string;
	};
}

export const DEFAULT_CONFIG: Config = {
	models: {
		worker: "openai-codex/gpt-5.6-terra",
		verifier: "opencode/qwen3.6-plus",
	},
	verify: {
		enabled: true,
		max_attempts: 3,
		test_command: "",
		build_command: "",
		require_tests_pass: true,
		max_evidence_bytes: 12000,
		timeout_ms: 300000,
	},
	loop: {
		max_iterations: 50,
		checkpoint: "require-clean",
		commit_prefix: "todo",
		on_silent_stop: "halt",
	},
	decompose: {
		min_children: 2,
	},
	atomic: {
		max_files: 5,
		on_overflow: "warn",
	},
	context: {
		prune_at_fraction: 0.6,
		keep_full_turns: 3,
		stub_min_bytes: 2000,
		tool_output_max_bytes: 2048,
	},
	ollama: {
		base_url: "http://localhost:11434/v1",
	},
};

export const DEFAULT_CONFIG_FILE = "todoloop.toml";

type Plain = Record<string, unknown>;

function pickString(table: Plain, key: string, fallback: string): string {
	const value = table[key];
	return typeof value === "string" && value.trim() ? value : fallback;
}

function pickNumber(table: Plain, key: string, fallback: number): number {
	const value = table[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pickBool(table: Plain, key: string, fallback: boolean): boolean {
	const value = table[key];
	return typeof value === "boolean" ? value : fallback;
}

function section(doc: Plain, name: string): Plain {
	const value = doc[name];
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Plain) : {};
}

export function parseConfig(text: string): Config {
	const doc = parseToml(text) as Plain;
	const models = section(doc, "models");
	const verify = section(doc, "verify");
	const loop = section(doc, "loop");
	const decompose = section(doc, "decompose");
	const atomic = section(doc, "atomic");
	const context = section(doc, "context");
	const ollama = section(doc, "ollama");

	const checkpointRaw = pickString(loop, "checkpoint", DEFAULT_CONFIG.loop.checkpoint);
	const checkpoint =
		checkpointRaw === "commit" || checkpointRaw === "require-clean" || checkpointRaw === "off"
			? checkpointRaw
			: DEFAULT_CONFIG.loop.checkpoint;
	const silentRaw = pickString(loop, "on_silent_stop", DEFAULT_CONFIG.loop.on_silent_stop);
	const on_silent_stop = silentRaw === "retry" ? "retry" : "halt";
	const overflowRaw = pickString(atomic, "on_overflow", DEFAULT_CONFIG.atomic.on_overflow);
	const on_overflow =
		overflowRaw === "promote" || overflowRaw === "off" || overflowRaw === "warn"
			? overflowRaw
			: DEFAULT_CONFIG.atomic.on_overflow;

	return {
		models: {
			worker: pickString(models, "worker", DEFAULT_CONFIG.models.worker),
			verifier: pickString(models, "verifier", DEFAULT_CONFIG.models.verifier),
		},
		verify: {
			enabled: pickBool(verify, "enabled", DEFAULT_CONFIG.verify.enabled),
			max_attempts: Math.max(1, pickNumber(verify, "max_attempts", DEFAULT_CONFIG.verify.max_attempts)),
			test_command: pickString(verify, "test_command", DEFAULT_CONFIG.verify.test_command),
			build_command: pickString(verify, "build_command", DEFAULT_CONFIG.verify.build_command),
			require_tests_pass: pickBool(verify, "require_tests_pass", DEFAULT_CONFIG.verify.require_tests_pass),
			max_evidence_bytes: pickNumber(verify, "max_evidence_bytes", DEFAULT_CONFIG.verify.max_evidence_bytes),
			timeout_ms: pickNumber(verify, "timeout_ms", DEFAULT_CONFIG.verify.timeout_ms),
		},
		loop: {
			max_iterations: pickNumber(loop, "max_iterations", DEFAULT_CONFIG.loop.max_iterations),
			checkpoint,
			commit_prefix: pickString(loop, "commit_prefix", DEFAULT_CONFIG.loop.commit_prefix),
			on_silent_stop,
		},
		decompose: {
			min_children: Math.max(1, pickNumber(decompose, "min_children", DEFAULT_CONFIG.decompose.min_children)),
		},
		atomic: {
			max_files: Math.max(1, pickNumber(atomic, "max_files", DEFAULT_CONFIG.atomic.max_files)),
			on_overflow,
		},
		context: {
			prune_at_fraction: pickNumber(context, "prune_at_fraction", DEFAULT_CONFIG.context.prune_at_fraction),
			keep_full_turns: pickNumber(context, "keep_full_turns", DEFAULT_CONFIG.context.keep_full_turns),
			stub_min_bytes: pickNumber(context, "stub_min_bytes", DEFAULT_CONFIG.context.stub_min_bytes),
			tool_output_max_bytes: pickNumber(
				context,
				"tool_output_max_bytes",
				DEFAULT_CONFIG.context.tool_output_max_bytes,
			),
		},
		ollama: {
			base_url: pickString(ollama, "base_url", DEFAULT_CONFIG.ollama.base_url),
		},
	};
}

export function loadConfig(cwd: string, file?: string): Config {
	const target = file ?? process.env.TODOLOOP_CONFIG ?? DEFAULT_CONFIG_FILE;
	const resolved = path.isAbsolute(target) ? target : path.join(cwd, target);
	if (!fs.existsSync(resolved)) return DEFAULT_CONFIG;
	return parseConfig(fs.readFileSync(resolved, "utf8"));
}

/** True when a model reference defers to pi's own configuration. */
export function isInheritRef(ref: string): boolean {
	const trimmed = ref.trim();
	return trimmed === "" || trimmed === "inherit";
}

/** True when the worker model should be left to pi's own configuration. */
export function inheritsWorker(config: Config): boolean {
	return isInheritRef(config.models.worker);
}

/**
 * pi's configured default, as a "provider/model" reference.
 *
 * Both halves matter: `defaultModel` is a bare id, so reading it alone makes
 * every inherited worker look like an ollama tag. Used only for diagnostics.
 */
export function piDefaultRef(): string | undefined {
	const home = process.env.HOME;
	if (!home) return undefined;
	const file = path.join(process.env.PI_CONFIG_DIR ?? path.join(home, ".pi", "agent"), "settings.json");
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { defaultModel?: string; defaultProvider?: string };
		const model = typeof parsed.defaultModel === "string" ? parsed.defaultModel.trim() : "";
		if (!model) return undefined;
		if (model.includes("/")) return model;
		const provider = typeof parsed.defaultProvider === "string" ? parsed.defaultProvider.trim() : "";
		return provider ? `${provider}/${model}` : model;
	} catch {
		return undefined;
	}
}

/** Split "provider/model:variant" into provider and model id. */
export function splitModelRef(ref: string): { provider: string; model: string } {
	const cut = ref.indexOf("/");
	if (cut < 0) return { provider: "ollama", model: ref };
	return { provider: ref.slice(0, cut), model: ref.slice(cut + 1) };
}

/** True when a reference is served by a local ollama rather than over the network. */
export function isLocalRef(ref: string): boolean {
	return splitModelRef(ref).provider === "ollama";
}

/**
 * Merge `--provider` and `--model` onto a configured worker reference.
 *
 * Either flag alone is enough. `--model` may carry its own "provider/" prefix,
 * in which case it decides both halves; otherwise the missing half comes from
 * the configured worker, or from the built-in default when that is "inherit"
 * — there is nothing to merge a half-override into.
 */
export function applyWorkerOverride(worker: string, provider?: string, model?: string): string {
	const wantProvider = provider?.trim();
	const wantModel = model?.trim();
	if (!wantProvider && !wantModel) return worker;
	if (wantModel?.includes("/")) return wantModel;
	const base = splitModelRef(isInheritRef(worker) ? DEFAULT_CONFIG.models.worker : worker);
	return `${wantProvider ?? base.provider}/${wantModel ?? base.model}`;
}

/** A copy of the config with the worker reference overridden, or the original when nothing changed. */
export function withWorkerOverride(config: Config, provider?: string, model?: string): Config {
	const worker = applyWorkerOverride(config.models.worker, provider, model);
	if (worker === config.models.worker) return config;
	return { ...config, models: { ...config.models, worker } };
}

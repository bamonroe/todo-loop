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
		 * Wall-clock cap on a single worker session, 0 for none.
		 *
		 * Nothing bounded that session before: `verify.timeout_ms` covers the
		 * verifier and the build commands, `max_attempts` and `max_iterations`
		 * bound the work *between* tasks. One observed run spent two hours on a
		 * single pure-function task and finished with code that did not compile,
		 * and the whole night's budget went with it.
		 *
		 * Overrun correlates with the model being lost rather than being nearly
		 * done, so cutting it is cheap. It costs nothing to be wrong about, either:
		 * a killed worker is treated as an ordinary rejection, which reverts the
		 * tree and retries with the overrun recorded.
		 */
		worker_timeout_ms: number;
		/**
		 * Wall-clock cap on a planning round specifically, 0 for none.
		 *
		 * Separate from worker_timeout_ms because the two fail differently. An
		 * implementation task that overruns is usually lost, and killing it is
		 * cheap — the tree reverts and nothing is left behind. A round that
		 * overruns has written part of a plan into the queue, and a partial plan
		 * is worse than no plan: every task in it passes verification while the
		 * missing ones are never noticed.
		 */
		plan_timeout_ms: number;
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
	plan: {
		/**
		 * Most items one planning round may add. The question a planner is asked is
		 * "what are the next few things", and a cap is what keeps it that question
		 * rather than "design the project".
		 */
		max_children: number;
		/**
		 * How many rounds a branch may close using research alone before it has to
		 * produce something that writes to the repository.
		 *
		 * Spent per branch, and *inherited* by child plans rather than reset, so a
		 * planner cannot refill its allowance by spawning a sub-planner to keep
		 * reading. Two is a guess; the run is what tells us whether it is wrong.
		 */
		research_budget: number;
		/**
		 * Backstop only. Nesting is meant to terminate because planners run out of
		 * next steps, not because they hit a wall — but a plan that only ever
		 * spawns plans would otherwise recurse forever, so at this depth a plan may
		 * spawn acts and nothing else.
		 */
		max_depth: number;
		/**
		 * Where research acts write what they find.
		 *
		 * Every session re-explores the same environment otherwise — what the build
		 * script wants, where the toolchain lives, which incantation actually
		 * worked. One real run's discovery survived only because the model happened
		 * to paste it into a task detail by hand. This is the file that makes
		 * "research" a deliverable rather than a session that ends.
		 */
		memory_file: string;
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
		 * promote: turn it into a plan so the next pass decides its next steps.
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
		/**
		 * Sampling for the local verifier, sent on the wire.
		 *
		 * This is here because a local verifier does *not* go through pi: in a
		 * session the extension calls it through pi's model registry, which
		 * applies `~/.pi/agent/models.json`, but `todo complete` from the command
		 * line has no session and no registry, so it talks to the server itself.
		 * Whatever tuning models.json carries is invisible on that path, and the
		 * two paths would otherwise disagree about the same model.
		 *
		 * The defaults are Qwen's own thinking-mode recommendation. Temperature 0
		 * is the trap worth naming: it looks right for a judge and is what makes
		 * Qwen's thinking mode loop. Hosted verifiers keep temperature 0, where
		 * determinism is free and no local template is involved.
		 */
		temperature: number;
		top_p: number;
		/** The one repetition control ollama's OpenAI layer actually forwards. */
		presence_penalty: number;
		/**
		 * Thinking budget for the local verifier.
		 *
		 * Qwen's chat template falls back to `xhigh` when nothing is supplied,
		 * which prepends an instruction to second-guess itself — measured at 38
		 * extra prompt tokens and roughly four times the completion tokens, for
		 * the same verdicts, on a decision this narrow. "Does this diff match
		 * this task" does not need a deliberation budget.
		 *
		 * Accepted: high | medium | low | none. `max` and `xhigh` make the
		 * template raise (HTTP 500) and must never be sent; "" omits the field.
		 */
		reasoning_effort: string;
		/**
		 * Cap on the local reply.
		 *
		 * Unbounded is not free on a reasoning model: a verdict that never stops
		 * thinking blocks the loop rather than costing money, which is the worse
		 * failure of the two. But set it too low and the model spends the whole
		 * budget thinking and returns nothing at all — measured on qwen3.5:9b
		 * against a real scaffold diff, 2048 was not enough and 8192 answered in
		 * 1164. The cap is a backstop against a runaway, not a budget to aim at.
		 */
		max_tokens: number;
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
		worker_timeout_ms: 0,
		plan_timeout_ms: 0,
		checkpoint: "require-clean",
		commit_prefix: "todo",
		on_silent_stop: "halt",
	},
	plan: {
		max_children: 5,
		research_budget: 2,
		max_depth: 8,
		memory_file: "NOTES.md",
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
		temperature: 0.6,
		top_p: 0.95,
		presence_penalty: 0.5,
		reasoning_effort: "low",
		max_tokens: 8192,
	},
};

export const DEFAULT_CONFIG_FILE = "todoloop.toml";

type Plain = Record<string, unknown>;

/**
 * Thinking levels Qwen's chat template raises on rather than clamping. Sending
 * either returns HTTP 500, which would fail every verification closed — a
 * blocked queue caused by a config typo, with the real reason buried in a
 * provider error string.
 */
const REFUSED_EFFORTS = new Set(["max", "xhigh"]);

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
	const plan = section(doc, "plan");
	const atomic = section(doc, "atomic");
	const context = section(doc, "context");
	const ollama = section(doc, "ollama");

	const workerTimeout = Math.max(0, pickNumber(loop, "worker_timeout_ms", DEFAULT_CONFIG.loop.worker_timeout_ms));
	// `decompose_timeout_ms` was this key's name while the levels were a ladder.
	// Still read, so an existing todoloop.toml does not silently lose its budget.
	const planTimeout = Math.max(
		0,
		pickNumber(loop, "plan_timeout_ms", pickNumber(loop, "decompose_timeout_ms", DEFAULT_CONFIG.loop.plan_timeout_ms)),
	);
	const checkpointRaw = pickString(loop, "checkpoint", DEFAULT_CONFIG.loop.checkpoint);
	const checkpoint =
		checkpointRaw === "commit" || checkpointRaw === "require-clean" || checkpointRaw === "off"
			? checkpointRaw
			: DEFAULT_CONFIG.loop.checkpoint;
	const silentRaw = pickString(loop, "on_silent_stop", DEFAULT_CONFIG.loop.on_silent_stop);
	const on_silent_stop = silentRaw === "retry" ? "retry" : "halt";
	const effortRaw = pickString(ollama, "reasoning_effort", DEFAULT_CONFIG.ollama.reasoning_effort).trim();
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
			worker_timeout_ms: workerTimeout,
			plan_timeout_ms: planTimeout,
			checkpoint,
			commit_prefix: pickString(loop, "commit_prefix", DEFAULT_CONFIG.loop.commit_prefix),
			on_silent_stop,
		},
		plan: {
			max_children: Math.max(1, pickNumber(plan, "max_children", DEFAULT_CONFIG.plan.max_children)),
			research_budget: Math.max(0, pickNumber(plan, "research_budget", DEFAULT_CONFIG.plan.research_budget)),
			max_depth: Math.max(1, pickNumber(plan, "max_depth", DEFAULT_CONFIG.plan.max_depth)),
			memory_file: pickString(plan, "memory_file", DEFAULT_CONFIG.plan.memory_file),
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
			temperature: pickNumber(ollama, "temperature", DEFAULT_CONFIG.ollama.temperature),
			top_p: pickNumber(ollama, "top_p", DEFAULT_CONFIG.ollama.top_p),
			presence_penalty: pickNumber(ollama, "presence_penalty", DEFAULT_CONFIG.ollama.presence_penalty),
			// Two values the template raises on. Silently dropping them beats a
			// 500 on every verify call from a typo in a config file.
			reasoning_effort: REFUSED_EFFORTS.has(effortRaw) ? "" : effortRaw,
			max_tokens: pickNumber(ollama, "max_tokens", DEFAULT_CONFIG.ollama.max_tokens),
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

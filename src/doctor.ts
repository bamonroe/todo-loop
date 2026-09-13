/**
 * `todo doctor` — the checks that are cheaper to run than to discover halfway
 * through an overnight loop.
 *
 * The one that matters most on a single GPU: if the worker and the verifier
 * cannot be resident at the same time, every verification evicts the worker and
 * every following task reloads it. That is two model loads per task, and on a
 * 16GB card with a 27B worker it dominates everything else. A hosted verifier
 * sidesteps it, at the cost of sending the diff off the machine.
 *
 * Neither role is local by assumption. A hosted worker has no ollama tag to
 * pull and no VRAM to contend for, so the local checks have to be conditioned
 * on where each model actually runs rather than run unconditionally.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { inheritsWorker, isLocalRef, piDefaultRef, splitModelRef } from "./config.ts";
import { isGitRepo, isTreeClean } from "./evidence.ts";
import { endpointFor, piAuthProviders, REMOTE_PROVIDERS, type Endpoint } from "./providers.ts";
import {
	activeTasks,
	allowedChildLevels,
	counts,
	effectiveLevel,
	findTask,
	isLeaf,
	levelOf,
	needsBreakdown,
	nextLeaf,
	parentOf,
	type Store,
} from "./store.ts";
import { MIN_TITLE_LENGTH } from "./decompose.ts";

const run = promisify(execFile);

export type Level = "ok" | "warn" | "fail";

export interface Check {
	level: Level;
	label: string;
	detail: string;
}

interface OllamaModel {
	name: string;
	size: number;
}

function nativeBase(baseUrl: string): string {
	return baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

async function listOllamaModels(baseUrl: string): Promise<OllamaModel[] | undefined> {
	try {
		const response = await fetch(`${nativeBase(baseUrl)}/api/tags`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return undefined;
		const body = (await response.json()) as { models?: OllamaModel[] };
		return body.models ?? [];
	} catch {
		return undefined;
	}
}

async function totalVramBytes(): Promise<number | undefined> {
	try {
		const { stdout } = await run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
		const mib = Number.parseInt(stdout.trim().split("\n")[0], 10);
		return Number.isFinite(mib) ? mib * 1024 * 1024 : undefined;
	} catch {
		return undefined;
	}
}

function gb(bytes: number): string {
	return `${(bytes / 1e9).toFixed(1)}GB`;
}

/** Measure a real round trip, so "the verifier is slow" is a number and not a feeling. */
export async function probeLatency(endpoint: Endpoint): Promise<{ ms: number; error?: string }> {
	if (endpoint.problem) return { ms: 0, error: endpoint.problem };
	const started = Date.now();
	try {
		const response = await fetch(`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${endpoint.apiKey}`,
				...endpoint.headers,
			},
			body: JSON.stringify({
				model: endpoint.model,
				temperature: 0,
				stream: false,
				max_tokens: endpoint.maxTokens ?? 16,
				messages: [{ role: "user", content: 'Reply with exactly: {"pass": true, "reason": "probe"}' }],
			}),
			signal: AbortSignal.timeout(600000),
		});
		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 200);
			return { ms: Date.now() - started, error: `${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}` };
		}
		await response.json();
		return { ms: Date.now() - started };
	} catch (error) {
		return { ms: Date.now() - started, error: (error as Error).message };
	}
}

/**
 * Queue shape problems that only show up as strange model behaviour later.
 *
 * Every check is about work still to be done, so archived tasks are not the
 * *subject* of one — a shipped task with a long description is not a warning
 * about dead prompt text. They stay in `store.tasks` throughout, because the
 * tree questions each check asks (is this a leaf, who is its parent) are wrong
 * without them.
 */
export function auditQueue(store: Store): Check[] {
	const checks: Check[] = [];
	const active = activeTasks(store);
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const task of store.tasks) {
		if (seen.has(task.id)) duplicates.add(task.id);
		seen.add(task.id);
	}
	if (duplicates.size) {
		checks.push({
			level: "fail",
			label: "duplicate ids",
			detail: `${[...duplicates].join(", ")} — leaf selection becomes ambiguous`,
		});
	}

	const orphans = active.filter((task) => task.parent && !findTask(store, task.parent));
	if (orphans.length) {
		checks.push({
			level: "fail",
			label: "missing parents",
			detail: `${orphans.map((task) => task.id).join(", ")} name a parent that does not exist`,
		});
	}

	const cyclic = active.filter((task) => {
		const seenIds = new Set<string>([task.id]);
		let parent = parentOf(task, store.tasks);
		while (parent) {
			if (seenIds.has(parent)) return true;
			seenIds.add(parent);
			const next = findTask(store, parent);
			if (!next) return false;
			parent = parentOf(next, store.tasks);
		}
		return false;
	});
	if (cyclic.length) {
		checks.push({ level: "fail", label: "cyclic parents", detail: cyclic.map((task) => task.id).join(", ") });
	}

	// "A task spawns code" — a task owning children is a contradiction. The CLI
	// refuses to create one, so this catches hand-edited queues.
	const codeParents = active.filter((task) => task.level === "task" && !isLeaf(task, store.tasks));
	if (codeParents.length) {
		checks.push({
			level: "fail",
			label: "tasks with children",
			detail: `${codeParents.map((task) => task.id).join(", ")} — only a scope or an epic may own children; raise their level`,
		});
	}

	const badLevels = active.filter((task) => {
		const parentId = parentOf(task, store.tasks);
		const parent = parentId ? findTask(store, parentId) : undefined;
		return parent ? !allowedChildLevels(effectiveLevel(parent, store.tasks)).includes(levelOf(task)) : false;
	});
	if (badLevels.length) {
		checks.push({
			level: "fail",
			label: "level violations",
			detail: `${badLevels.map((task) => `${task.id} [${levelOf(task)}]`).join(", ")} — an epic spawns scopes or tasks, a scope spawns tasks`,
		});
	}

	const pending = active.filter((task) => task.status !== "done" && needsBreakdown(task, store.tasks));
	if (pending.length) {
		checks.push({
			level: "ok",
			label: "pending breakdowns",
			detail: `${pending.map((task) => `${task.id} [${levelOf(task)}]`).join(", ")} — the loop will break these down before implementing anything under them`,
		});
	}

	const coarse = active.filter((task) => task.overflowed);
	if (coarse.length) {
		checks.push({
			level: "warn",
			label: "tasks that ran over budget",
			detail:
				`${coarse.map((task) => `${task.id} (${task.overflow_reason})`).join(", ")} — these were not atomic. ` +
				"Split them, or set atomic.on_overflow = \"promote\" to have the loop break them down itself.",
		});
	}

	// Still every non-leaf, level or not: a scope's detail *is* shown by the
	// breakdown prompt, but only while it is childless — and then it is a leaf.
	// Once it has children nothing prompts it again, so the text is dead.
	const detailedParents = active.filter((task) => !isLeaf(task, store.tasks) && task.detail);
	if (detailedParents.length) {
		checks.push({
			level: "warn",
			label: "detail on non-leaf tasks",
			detail: `${detailedParents.map((task) => task.id).join(", ")} — only leaves are ever prompted, so this text is never shown`,
		});
	}

	const thin = active.filter(
		(task) => isLeaf(task, store.tasks) && task.status === "todo" && task.title.length < MIN_TITLE_LENGTH,
	);
	if (thin.length) {
		checks.push({
			level: "warn",
			label: "very short task titles",
			detail: `${thin.map((task) => task.id).join(", ")} — a weak model needs the task text to stand on its own`,
		});
	}

	const stats = counts(store);
	const archived = store.tasks.length - active.length;
	const activeLeaves = active.filter((task) => isLeaf(task, store.tasks)).length;
	checks.push({
		level: nextLeaf(store) ? "ok" : "warn",
		label: "queue",
		detail:
			`${store.schema.name} schema, ${active.length} active task${active.length === 1 ? "" : "s"}` +
			(archived ? `, ${archived} archived` : "") +
			`, ${activeLeaves} leaves, ${stats.todo} todo, ${stats.blocked} blocked` +
			(stats.pending_breakdowns ? `, ${stats.pending_breakdowns} awaiting breakdown` : "") +
			(nextLeaf(store) ? `, next is ${nextLeaf(store)?.id}` : ", nothing runnable"),
	});

	return checks;
}

export interface DoctorOptions {
	cwd: string;
	config: Config;
	store: Store;
	probe: boolean;
}

/** What the model checks need to know about this machine, gathered once. */
export interface ModelEnvironment {
	/** Local ollama tags, or undefined when ollama did not answer. */
	local?: OllamaModel[];
	/** Total VRAM in bytes, when it could be read. */
	vram?: number;
	/** Providers pi holds credentials for. */
	piProviders: string[];
}

/**
 * Everything doctor can say about the two models, without doing the I/O itself.
 * Pure, so the combinations that are awkward to reproduce — hosted worker with
 * a local verifier, both hosted, ollama down but nothing local configured — are
 * testable without an ollama or a GPU.
 */
export function modelChecks(config: Config, env: ModelEnvironment): Check[] {
	const checks: Check[] = [];
	const findLocal = (name: string) =>
		env.local?.find((entry) => entry.name === name || entry.name === `${name}:latest`);

	const inherited = inheritsWorker(config);
	const workerRef = inherited ? piDefaultRef() : config.models.worker;
	const worker = workerRef ? splitModelRef(workerRef) : undefined;
	const workerLocal = workerRef ? isLocalRef(workerRef) : false;
	const verifier = endpointFor(config.models.verifier, config);
	const verifierLabel = REMOTE_PROVIDERS[verifier.provider]?.label ?? verifier.provider;
	const origin = inherited ? ", inherited from pi settings" : "";

	// ollama only has to be up for the roles that actually run on it. Demanding it
	// for a pair of hosted models is a failure the user cannot act on.
	if (workerLocal || !verifier.remote) {
		checks.push(
			env.local
				? { level: "ok", label: "ollama", detail: `${env.local.length} models at ${config.ollama.base_url}` }
				: {
						level: "fail",
						label: "ollama",
						detail: `no response from ${config.ollama.base_url} — start ollama or fix ollama.base_url`,
					},
		);
	}

	if (!worker) {
		checks.push({
			level: "warn",
			label: "worker model",
			detail: inherited ? "set to inherit, but pi has no defaultModel configured" : "no worker model configured",
		});
	} else if (workerLocal) {
		if (env.local) {
			const found = findLocal(worker.model);
			checks.push(
				found
					? { level: "ok", label: "worker model", detail: `${worker.model} (${gb(found.size)})${origin}` }
					: {
							level: "fail",
							label: "worker model",
							detail: `${worker.model} is not pulled — run: ollama pull ${worker.model}`,
						},
			);
		}

		if (!inherited && /:[^:]+$/.test(worker.model) && !findLocal(worker.model)) {
			checks.push({
				level: "warn",
				label: "worker model reference",
				detail: `pi reads the ":" suffix in ${config.models.worker} as a thinking level, so --model will not resolve it; use "inherit" instead`,
			});
		}
	} else {
		// A hosted worker always runs inside pi — the driver spawns `pi -p` and the
		// extension sets the session model — so pi's own credentials are the ones
		// that have to be there. This driver never calls the worker's endpoint.
		checks.push(
			env.piProviders.includes(worker.provider)
				? {
						level: "ok",
						label: "worker model",
						detail: `${worker.model} via ${worker.provider} — hosted, so nothing to pull and no VRAM to share${origin}`,
					}
				: {
						level: "fail",
						label: "worker model",
						detail: `pi has no credentials for ${worker.provider} — run /login in pi, or point models.worker at an ollama model`,
					},
		);
	}

	if (worker && worker.provider === verifier.provider && worker.model === verifier.model) {
		checks.push({
			level: "warn",
			label: "verifier independence",
			detail: "worker and verifier are the same model; a model judging its own output is the weakest version of this check",
		});
	}

	if (verifier.remote) {
		checks.push(
			verifier.problem
				? { level: "fail", label: "verifier model", detail: verifier.problem }
				: {
						level: "ok",
						label: "verifier model",
						detail: `${verifier.model} via ${verifierLabel} — hosted, so it never competes with the worker for VRAM`,
					},
		);
	} else if (env.local) {
		const verifierEntry = findLocal(verifier.model);
		checks.push(
			verifierEntry
				? { level: "ok", label: "verifier model", detail: `${verifier.model} (${gb(verifierEntry.size)})` }
				: {
						level: "fail",
						label: "verifier model",
						detail: `${verifier.model} is not pulled — run: ollama pull ${verifier.model}`,
					},
		);

		// Contention is only possible when both models want the same card.
		const workerEntry = workerLocal && worker ? findLocal(worker.model) : undefined;
		if (workerEntry && verifierEntry && env.vram) {
			const combined = workerEntry.size + verifierEntry.size;
			checks.push(
				combined < env.vram * 0.92
					? {
							level: "ok",
							label: "vram",
							detail: `${gb(combined)} of ${gb(env.vram)} — worker and verifier can stay resident together`,
						}
					: {
							level: "warn",
							label: "vram",
							detail:
								`${gb(combined)} needed but only ${gb(env.vram)} available — every verification evicts the worker, ` +
								"so expect two model loads per task. Either accept the cost, pick a verifier small enough to co-reside, " +
								"drop the worker to a smaller context variant to free KV cache, or move the verifier off the box " +
								'(models.verifier = "opencode/qwen3.6-plus").',
						},
			);
		}
	}

	// One disclosure rather than one per role: what matters is which of your code
	// leaves the machine, and that reads badly split across two near-identical
	// warnings when both models are hosted.
	const leaving: string[] = [];
	if (worker && !workerLocal) leaving.push(`the worker's prompts and the files it reads go to ${worker.provider}`);
	if (verifier.remote) {
		leaving.push(`the task text, changed file list and diff go to ${verifierLabel} on every verification`);
	}
	if (leaving.length) {
		checks.push({
			level: "warn",
			label: "work leaves this machine",
			detail: `${leaving.join("; ")}, and the calls are metered. Point ${
				leaving.length > 1 ? "models.worker and models.verifier" : "it"
			} at ollama models to keep everything local.`,
		});
	}

	return checks;
}

export async function diagnose(options: DoctorOptions): Promise<Check[]> {
	const { cwd, config, store } = options;
	const checks: Check[] = [];

	const verifierEndpoint = endpointFor(config.models.verifier, config);
	checks.push(
		...modelChecks(config, {
			local: await listOllamaModels(config.ollama.base_url),
			vram: await totalVramBytes(),
			piProviders: piAuthProviders(),
		}),
	);

	if (await isGitRepo(cwd)) {
		const clean = await isTreeClean(cwd);
		checks.push({
			level: clean || config.loop.checkpoint !== "require-clean" ? "ok" : "fail",
			label: "git",
			detail: clean ? "repository is clean" : `working tree is dirty (checkpoint = ${config.loop.checkpoint})`,
		});
	} else {
		checks.push({
			level: config.loop.checkpoint === "off" ? "ok" : "warn",
			label: "git",
			detail: "not a git repository — the diff shown to the verifier will be empty, so verification cannot work",
		});
	}

	checks.push(
		config.verify.test_command || config.verify.build_command
			? {
					level: "ok",
					label: "mechanical checks",
					detail: [config.verify.build_command, config.verify.test_command].filter(Boolean).join(" · "),
				}
			: {
					level: "warn",
					label: "mechanical checks",
					detail: "no test_command or build_command — the verifier has to judge everything on the diff alone",
				},
	);

	checks.push(...auditQueue(store));

	if (options.probe) {
		const result = await probeLatency(verifierEndpoint);
		checks.push(
			result.error
				? { level: "fail", label: "verifier probe", detail: `${result.error} after ${result.ms}ms` }
				: {
						level: result.ms > 30000 ? "warn" : "ok",
						label: "verifier probe",
						detail:
							`${(result.ms / 1000).toFixed(1)}s round trip to ${verifierEndpoint.model}` +
							(result.ms > 30000 ? " — most of this is model load, and you pay it once per task" : ""),
					},
		);
	}

	return checks;
}

export function formatChecks(checks: Check[]): string {
	const marks: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };
	return checks.map((check) => `${marks[check.level]} ${check.label}: ${check.detail}`).join("\n");
}

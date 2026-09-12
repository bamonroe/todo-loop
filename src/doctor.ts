/**
 * `todo doctor` — the checks that are cheaper to run than to discover halfway
 * through an overnight loop.
 *
 * The one that matters most on a single GPU: if the worker and the verifier
 * cannot be resident at the same time, every verification evicts the worker and
 * every following task reloads it. That is two model loads per task, and on a
 * 16GB card with a 27B worker it dominates everything else.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.ts";
import { inheritsWorker, piDefaultModel, splitModelRef } from "./config.ts";
import { isGitRepo, isTreeClean } from "./evidence.ts";
import { counts, findTask, isLeaf, nextLeaf, parentOf, type Store } from "./store.ts";

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
export async function probeLatency(baseUrl: string, model: string): Promise<{ ms: number; error?: string }> {
	const started = Date.now();
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer ollama" },
			body: JSON.stringify({
				model,
				temperature: 0,
				stream: false,
				max_tokens: 16,
				messages: [{ role: "user", content: 'Reply with exactly: {"pass": true, "reason": "probe"}' }],
			}),
			signal: AbortSignal.timeout(600000),
		});
		if (!response.ok) return { ms: Date.now() - started, error: `${response.status} ${response.statusText}` };
		await response.json();
		return { ms: Date.now() - started };
	} catch (error) {
		return { ms: Date.now() - started, error: (error as Error).message };
	}
}

/** Queue shape problems that only show up as strange model behaviour later. */
export function auditQueue(store: Store): Check[] {
	const checks: Check[] = [];
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

	const orphans = store.tasks.filter((task) => task.parent && !findTask(store, task.parent));
	if (orphans.length) {
		checks.push({
			level: "fail",
			label: "missing parents",
			detail: `${orphans.map((task) => task.id).join(", ")} name a parent that does not exist`,
		});
	}

	const cyclic = store.tasks.filter((task) => {
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

	const detailedParents = store.tasks.filter((task) => !isLeaf(task, store.tasks) && task.detail);
	if (detailedParents.length) {
		checks.push({
			level: "warn",
			label: "detail on non-leaf tasks",
			detail: `${detailedParents.map((task) => task.id).join(", ")} — only leaves are ever prompted, so this text is never shown`,
		});
	}

	const thin = store.tasks.filter((task) => isLeaf(task, store.tasks) && task.status === "todo" && task.title.length < 12);
	if (thin.length) {
		checks.push({
			level: "warn",
			label: "very short task titles",
			detail: `${thin.map((task) => task.id).join(", ")} — a weak model needs the task text to stand on its own`,
		});
	}

	const stats = counts(store);
	checks.push({
		level: nextLeaf(store) ? "ok" : "warn",
		label: "queue",
		detail: `${store.tasks.length} task${store.tasks.length === 1 ? "" : "s"}, ${stats.leaves} leaves, ${stats.todo} todo, ${stats.blocked} blocked` +
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

export async function diagnose(options: DoctorOptions): Promise<Check[]> {
	const { cwd, config, store } = options;
	const checks: Check[] = [];

	const models = await listOllamaModels(config.ollama.base_url);
	if (!models) {
		checks.push({
			level: "fail",
			label: "ollama",
			detail: `no response from ${config.ollama.base_url} — start ollama or fix ollama.base_url`,
		});
	} else {
		checks.push({ level: "ok", label: "ollama", detail: `${models.length} models at ${config.ollama.base_url}` });

		const inherited = inheritsWorker(config);
		const workerRef = inherited ? piDefaultModel() : config.models.worker;
		if (inherited) {
			checks.push({
				level: workerRef ? "ok" : "warn",
				label: "worker model",
				detail: workerRef
					? `inherited from pi settings: ${workerRef}`
					: "set to inherit, but pi has no defaultModel configured",
			});
		}
		const worker = workerRef ? splitModelRef(workerRef).model : "";
		const verifier = splitModelRef(config.models.verifier).model;
		const find = (name: string) => models.find((entry) => entry.name === name || entry.name === `${name}:latest`);

		const roles: [string, string][] = inherited ? [["verifier", verifier]] : [["worker", worker], ["verifier", verifier]];
		for (const [role, name] of roles) {
			if (!name) continue;
			const found = find(name);
			checks.push(
				found
					? { level: "ok", label: `${role} model`, detail: `${name} (${gb(found.size)})` }
					: { level: "fail", label: `${role} model`, detail: `${name} is not pulled — run: ollama pull ${name}` },
			);
		}

		if (!inherited && /:[^:]+$/.test(config.models.worker) && !find(worker)) {
			checks.push({
				level: "warn",
				label: "worker model reference",
				detail: `pi reads the ":" suffix in ${config.models.worker} as a thinking level, so --model will not resolve it; use "inherit" instead`,
			});
		}

		if (worker && worker === verifier) {
			checks.push({
				level: "warn",
				label: "verifier independence",
				detail: "worker and verifier are the same model; a model judging its own output is the weakest version of this check",
			});
		}

		const workerEntry = find(worker);
		const verifierEntry = find(verifier);
		const vram = await totalVramBytes();
		if (workerEntry && verifierEntry && vram) {
			const combined = workerEntry.size + verifierEntry.size;
			checks.push(
				combined < vram * 0.92
					? {
							level: "ok",
							label: "vram",
							detail: `${gb(combined)} of ${gb(vram)} — worker and verifier can stay resident together`,
						}
					: {
							level: "warn",
							label: "vram",
							detail:
								`${gb(combined)} needed but only ${gb(vram)} available — every verification evicts the worker, ` +
								"so expect two model loads per task. Either accept the cost, pick a verifier small enough to co-reside, " +
								"or drop the worker to a smaller context variant to free KV cache.",
						},
			);
		}
	}

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

	if (options.probe && models) {
		const verifier = splitModelRef(config.models.verifier).model;
		const result = await probeLatency(config.ollama.base_url, verifier);
		checks.push(
			result.error
				? { level: "fail", label: "verifier probe", detail: `${result.error} after ${result.ms}ms` }
				: {
						level: result.ms > 30000 ? "warn" : "ok",
						label: "verifier probe",
						detail:
							`${(result.ms / 1000).toFixed(1)}s round trip` +
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

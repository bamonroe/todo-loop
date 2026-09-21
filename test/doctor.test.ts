import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/config.ts";
import { auditQueue, envChecks, formatChecks, modelChecks, type Check } from "../src/doctor.ts";
import { parseStore } from "../src/store.ts";

function levelOf(checks: Check[], label: string): string | undefined {
	return checks.find((check) => check.label === label)?.level;
}

function detailOf(checks: Check[], label: string): string | undefined {
	return checks.find((check) => check.label === label)?.detail;
}

test("a healthy queue reports only the summary", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "api"
title = "Build the health API"
[[task]]
id = "api.route"
title = "Add GET /health returning 200"
detail = "Register the route in src/server.ts and return a JSON body with status and uptime."
`),
	);
	assert.equal(checks.length, 1);
	assert.equal(levelOf(checks, "queue"), "ok");
	assert.match(checks[0].detail, /2 active tasks, 1 leaves.*next is api\.route/);
});

test("duplicate ids are a blocking problem", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "a"
title = "First definition"
[[task]]
id = "a"
title = "Second definition"
`),
	);
	assert.equal(levelOf(checks, "duplicate ids"), "fail");
});

test("a parent that does not exist is a blocking problem", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "orphan"
parent = "nowhere"
title = "Task with a missing parent"
`),
	);
	assert.equal(levelOf(checks, "missing parents"), "fail");
});

test("cyclic parents are caught rather than hung on", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "a"
parent = "b"
title = "First task"
[[task]]
id = "b"
parent = "a"
title = "Second task"
`),
	);
	assert.equal(levelOf(checks, "cyclic parents"), "fail");
});

test("detail on a non-leaf is flagged because it is never shown", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "api"
title = "Build the API"
detail = "This text never reaches a model."
[[task]]
id = "api.route"
title = "Add GET /health returning 200"
detail = "Register the route in src/server.ts and return a JSON body with status and uptime."
`),
	);
	assert.equal(levelOf(checks, "detail on non-leaf tasks"), "warn");
});

test("an exhausted queue is a warning, not a pass", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "a"
title = "Already finished work"
status = "done"
`),
	);
	assert.equal(levelOf(checks, "queue"), "warn");
	assert.match(checks[0].detail, /nothing runnable/);
	assert.match(checks[0].detail, /1 active task,/);
});

test("formatting marks each level", () => {
	const text = formatChecks([
		{ level: "ok", label: "a", detail: "fine" },
		{ level: "warn", label: "b", detail: "hmm" },
		{ level: "fail", label: "c", detail: "no" },
	]);
	assert.equal(text, "✓ a: fine\n! b: hmm\n✗ c: no");
});

test("an explicit act owning children is a hard failure", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "api"
title = "Build the API"
level = "act"
[[task]]
id = "api.route"
title = "Add GET /health returning 200"
detail = "Register the route in src/server.ts and return a JSON body with status and uptime."
`),
	);
	assert.equal(levelOf(checks, "acts with children"), "fail");
});

test("a plan spawning a plan is no longer a violation", () => {
	// Under the old ladder this was the shape that could not be expressed, so
	// deferral had nowhere to go below a scope. Nesting is unbounded now;
	// termination comes from planners running out of next steps instead.
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "sessions"
title = "Rework session storage"
level = "plan"
[[task]]
id = "sessions.cookies"
title = "Investigate the cookie flags"
level = "plan"
`),
	);
	assert.equal(levelOf(checks, "level violations"), undefined);
});

test("a plan with no round yet is reported, not warned about", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
`),
	);
	assert.equal(levelOf(checks, "plans with no round yet"), "ok");
});

test("tasks that ran over budget are surfaced", () => {
	const checks = auditQueue(
		parseStore(`
[[task]]
id = "big"
title = "Rewrite the data layer"
status = "done"
overflowed = true
overflow_reason = "touched 14 files (budget 5)"
`),
	);
	assert.equal(levelOf(checks, "tasks that ran over budget"), "warn");
});

// ------------------------------------------------------------------ models

/** A config with both roles named outright, so nothing falls back to pi's settings. */
function withModels(worker: string, verifier: string) {
	return parseConfig(`[models]\nworker = "${worker}"\nverifier = "${verifier}"\n`);
}

const LOCAL = [
	{ name: "qwen3.8-27b:latest", size: 12e9 },
	{ name: "qwen3.5:9b", size: 6e9 },
];

test("a hosted worker is not something to pull", () => {
	const checks = modelChecks(withModels("openai-codex/gpt-5.6-terra", "opencode/qwen3.6-plus"), {
		local: LOCAL,
		piProviders: ["openai-codex", "opencode"],
	});
	assert.equal(levelOf(checks, "worker model"), "ok");
	assert.match(detailOf(checks, "worker model") ?? "", /hosted/);
	// The old check looked every worker up in the ollama tag list, so this one
	// reported "not pulled — run: ollama pull gpt-5.6-terra".
	assert.doesNotMatch(detailOf(checks, "worker model") ?? "", /ollama pull/);
});

test("a hosted worker still needs pi to hold the credentials", () => {
	const checks = modelChecks(withModels("openai-codex/gpt-5.6-terra", "opencode/qwen3.6-plus"), {
		local: LOCAL,
		piProviders: ["opencode"],
	});
	assert.equal(levelOf(checks, "worker model"), "fail");
	assert.match(detailOf(checks, "worker model") ?? "", /\/login/);
});

test("ollama being down is only a failure when something runs on it", () => {
	const hosted = modelChecks(withModels("openai-codex/gpt-5.6-terra", "opencode/qwen3.6-plus"), {
		local: undefined,
		piProviders: ["openai-codex", "opencode"],
	});
	assert.equal(levelOf(hosted, "ollama"), undefined);

	const localWorker = modelChecks(withModels("ollama/qwen3.8-27b", "opencode/qwen3.6-plus"), {
		local: undefined,
		piProviders: ["opencode"],
	});
	assert.equal(levelOf(localWorker, "ollama"), "fail");

	const localVerifier = modelChecks(withModels("openai-codex/gpt-5.6-terra", "ollama/qwen3.5:9b"), {
		local: undefined,
		piProviders: ["openai-codex"],
	});
	assert.equal(levelOf(localVerifier, "ollama"), "fail");
});

test("vram is only contended for when both models are local", () => {
	const mixed = modelChecks(withModels("openai-codex/gpt-5.6-terra", "ollama/qwen3.5:9b"), {
		local: LOCAL,
		vram: 8e9,
		piProviders: ["openai-codex"],
	});
	assert.equal(levelOf(mixed, "vram"), undefined);

	const both = modelChecks(withModels("ollama/qwen3.8-27b", "ollama/qwen3.5:9b"), {
		local: LOCAL,
		vram: 8e9,
		piProviders: [],
	});
	assert.equal(levelOf(both, "vram"), "warn");
});

test("two hosted models that are the same model are still not independent", () => {
	const checks = modelChecks(withModels("opencode/qwen3.6-plus", "opencode/qwen3.6-plus"), {
		local: LOCAL,
		piProviders: ["opencode"],
	});
	assert.equal(levelOf(checks, "verifier independence"), "warn");
});

test("what leaves the machine is disclosed once, naming every remote role", () => {
	const both = detailOf(
		modelChecks(withModels("openai-codex/gpt-5.6-terra", "opencode/qwen3.6-plus"), {
			local: LOCAL,
			piProviders: ["openai-codex", "opencode"],
		}),
		"work leaves this machine",
	);
	assert.match(both ?? "", /openai-codex/);
	assert.match(both ?? "", /OpenCode Zen/);

	const allLocal = modelChecks(withModels("ollama/qwen3.8-27b", "ollama/qwen3.5:9b"), {
		local: LOCAL,
		piProviders: [],
	});
	assert.equal(levelOf(allLocal, "work leaves this machine"), undefined);
});

test("doctor says what the project env will and will not do", () => {
	assert.deepEqual(envChecks(parseConfig("")), [], "no table, nothing to report — doctor is not a config dump");

	const plain = envChecks(parseConfig('[env]\nPI_ANDROID_PROJECT = "/data/eq2"\n'), () => true);
	assert.deepEqual(plain.map((check) => check.level), ["ok"]);
	assert.match(plain[0].detail, /PI_ANDROID_PROJECT/);

	const reserved = envChecks(parseConfig('[env]\nTODOLOOP_DRIVER = "session"\n'), () => true);
	const warned = reserved.filter((check) => check.level === "warn");
	assert.equal(warned.length, 1, "declaring a driver variable is silently ignored otherwise");
	assert.match(warned[0].detail, /TODOLOOP_DRIVER/);

	// The fake says only absolute paths exist, so the guard that stops a plain
	// value like "release" being checked as a path has to be doing real work.
	const stale = envChecks(
		parseConfig('[env]\nROOT = "/gone"\nLABEL = "release"\n'),
		(path) => path.startsWith("/") && path !== "/gone",
	);
	const missing = stale.filter((check) => check.level === "warn");
	assert.equal(missing.length, 1);
	assert.match(missing[0].detail, /ROOT=\/gone/);
	assert.doesNotMatch(missing[0].detail, /LABEL/, "a value that is not a path is not a path that is missing");
});

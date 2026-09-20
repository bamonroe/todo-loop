import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfig, type Config } from "../src/config.ts";
import { completerFor, endpointFor, piAuthKey, resolveApiKey } from "../src/providers.ts";
import { chatCompleter, verify } from "../src/verify.ts";

const config: Config = {
	...DEFAULT_CONFIG,
	ollama: { ...DEFAULT_CONFIG.ollama, base_url: "http://localhost:11434/v1" },
};

const task = { id: "a.one", title: "Add a health endpoint" };
const evidence = { diff: "+ app.get('/health')", files: ["server.ts"], dirty: false, commands: [] };

/** Run a body with a scrubbed environment, so a real key on the box cannot mask a bug. */
function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(vars)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("an ollama reference stays on the local server and needs no key", () => {
	const endpoint = endpointFor("ollama/qwen3.5:9b", config);
	assert.equal(endpoint.remote, false);
	assert.equal(endpoint.model, "qwen3.5:9b");
	assert.equal(endpoint.baseUrl, "http://localhost:11434/v1");
	assert.equal(endpoint.problem, undefined);
	// Capped even locally. An over-thinking model costs time rather than money,
	// but a verdict that never arrives blocks the queue, which is worse.
	assert.equal(endpoint.maxTokens, DEFAULT_CONFIG.ollama.max_tokens);
});

test("a bare model id is still read as ollama", () => {
	assert.equal(endpointFor("qwen3.5:9b", config).provider, "ollama");
});

test("an opencode reference resolves to zen with the key from the environment", () => {
	const endpoint = withEnv({ OPENCODE_API_KEY: "sk-test", PI_CONFIG_DIR: undefined }, () =>
		endpointFor("opencode/qwen3.6-plus", config),
	);
	assert.equal(endpoint.remote, true);
	assert.equal(endpoint.model, "qwen3.6-plus");
	assert.equal(endpoint.baseUrl, "https://opencode.ai/zen/v1");
	assert.equal(endpoint.apiKey, "sk-test");
	assert.equal(endpoint.problem, undefined);
	assert.ok(endpoint.maxTokens && endpoint.maxTokens >= 1024);
});

test("opencode-go carries the session header it refuses requests without", () => {
	const endpoint = withEnv({ OPENCODE_API_KEY: "sk-test" }, () => endpointFor("opencode-go/qwen3.8-flash", config));
	assert.equal(endpoint.baseUrl, "https://opencode.ai/zen/go/v1");
	assert.match(endpoint.headers?.["x-opencode-session"] ?? "", /^todoloop-/);
});

test("a missing key is reported as a problem rather than thrown", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-auth-"));
	fs.writeFileSync(path.join(dir, "auth.json"), "{}");
	const endpoint = withEnv({ OPENCODE_API_KEY: undefined, PI_CONFIG_DIR: dir }, () =>
		endpointFor("opencode/qwen3.6-plus", config),
	);
	assert.match(endpoint.problem ?? "", /no API key/i);
	assert.match(endpoint.problem ?? "", /OPENCODE_API_KEY/);
});

test("an unusable verifier fails the task closed instead of escaping", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-auth-"));
	fs.writeFileSync(path.join(dir, "auth.json"), "{}");
	const complete = withEnv({ OPENCODE_API_KEY: undefined, PI_CONFIG_DIR: dir }, () =>
		completerFor("opencode/qwen3.6-plus", config),
	);
	const verdict = await verify(task, evidence, complete);
	assert.equal(verdict.pass, false);
	assert.equal(verdict.mechanical, true);
	assert.match(verdict.reason, /no API key/i);
});

test("an unknown provider names itself in the problem", () => {
	const endpoint = endpointFor("wishful/some-model", config);
	assert.match(endpoint.problem ?? "", /unknown provider "wishful"/);
});

test("a key set up once with pi is found without an environment variable", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-auth-"));
	fs.writeFileSync(
		path.join(dir, "auth.json"),
		JSON.stringify({ opencode: { type: "api_key", key: "sk-from-pi" } }),
	);
	const key = withEnv({ OPENCODE_API_KEY: undefined, PI_CONFIG_DIR: dir }, () => resolveApiKey("opencode"));
	assert.equal(key, "sk-from-pi");
	assert.equal(withEnv({ PI_CONFIG_DIR: dir }, () => piAuthKey("nobody")), undefined);
});

test("the environment wins over the stored key", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-auth-"));
	fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ opencode: { key: "sk-stored" } }));
	const key = withEnv({ OPENCODE_API_KEY: "sk-env", PI_CONFIG_DIR: dir }, () => resolveApiKey("opencode"));
	assert.equal(key, "sk-env");
});

test("the completer authenticates and passes provider headers through", async () => {
	const seen: { auth?: string; session?: string; body?: Record<string, unknown> } = {};
	const server = stubEndpoint(seen, {
		choices: [{ message: { content: '{"pass": true, "reason": "ok"}' } }],
	});
	const url = await server.url;
	const complete = chatCompleter({
		baseUrl: url,
		model: "qwen3.8-flash",
		apiKey: "sk-test",
		headers: { "x-opencode-session": "todoloop-abc" },
		maxTokens: 4096,
	});
	assert.equal(await complete({ system: "s", user: "u" }), '{"pass": true, "reason": "ok"}');
	assert.equal(seen.auth, "Bearer sk-test");
	assert.equal(seen.session, "todoloop-abc");
	assert.equal(seen.body?.max_tokens, 4096);
	assert.equal(seen.body?.temperature, 0);
	await server.close();
});

test("a verdict stranded in reasoning_content is still read", async () => {
	const seen = {};
	const server = stubEndpoint(seen, {
		choices: [{ message: { content: "", reasoning_content: '{"pass": false, "reason": "route missing"}' } }],
	});
	const complete = chatCompleter({ baseUrl: await server.url, model: "m", apiKey: "k" });
	const verdict = await verify(task, evidence, complete);
	assert.equal(verdict.pass, false);
	assert.equal(verdict.reason, "route missing");
	await server.close();
});

test("an error body is surfaced, not swallowed behind the status code", async () => {
	const server = stubEndpoint({}, { error: { message: "Model is unavailable." } }, 400);
	const complete = chatCompleter({ baseUrl: await server.url, model: "m", apiKey: "k" });
	const verdict = await verify(task, evidence, complete);
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /Model is unavailable/);
	await server.close();
});

/** A throwaway OpenAI-shaped endpoint, so these tests never touch the network. */
function stubEndpoint(
	seen: { auth?: string; session?: string; body?: Record<string, unknown> },
	payload: unknown,
	status = 200,
) {
	const server = http.createServer((req, res) => {
		seen.auth = req.headers.authorization;
		seen.session = req.headers["x-opencode-session"] as string | undefined;
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			seen.body = JSON.parse(raw || "{}");
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
		});
	});
	const listening = new Promise<string>((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
		});
	});
	return {
		url: listening,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("a local verifier is tuned on the wire, because no pi registry tunes it here", async () => {
	const seen: { body?: Record<string, unknown> } = {};
	const server = stubEndpoint(seen, { choices: [{ message: { content: '{"pass": true, "reason": "ok"}' } }] });
	const local: Config = { ...config, ollama: { ...config.ollama, base_url: await server.url } };

	await completerFor("ollama/qwen3.8-27b:default", local)({ system: "s", user: "u" });

	// Temperature 0 is the shipped default and the wrong one locally: it is what
	// sends Qwen's thinking mode into a loop.
	assert.equal(seen.body?.temperature, 0.6);
	assert.equal(seen.body?.top_p, 0.95);
	assert.equal(seen.body?.presence_penalty, 0.5);
	// Unsupplied, the chat template falls back to xhigh and pays for deliberation
	// this decision does not need.
	assert.equal(seen.body?.reasoning_effort, "low");
	// A local reply is not free: an uncapped reasoning model blocks the loop.
	assert.equal(seen.body?.max_tokens, 8192);
	await server.close();
});

test("a hosted verifier still judges at temperature 0", async () => {
	const seen: { body?: Record<string, unknown> } = {};
	const server = stubEndpoint(seen, { choices: [{ message: { content: '{"pass": true, "reason": "ok"}' } }] });
	await chatCompleter({ baseUrl: await server.url, model: "m", apiKey: "k" })({ system: "s", user: "u" });
	assert.equal(seen.body?.temperature, 0);
	assert.equal(seen.body?.reasoning_effort, undefined);
	await server.close();
});

test("an effort the chat template raises on is dropped rather than sent", () => {
	for (const effort of ["max", "xhigh"]) {
		const parsed = parseConfig(`[ollama]\nreasoning_effort = "${effort}"\n`);
		assert.equal(parsed.ollama.reasoning_effort, "");
		const endpoint = endpointFor("ollama/m", parsed);
		assert.equal("reasoning_effort" in (endpoint.params ?? {}), false);
	}
});

test("local sampling is configurable, since the right values follow the model", () => {
	const parsed = parseConfig(`[ollama]\ntemperature = 0.2\nmax_tokens = 512\nreasoning_effort = "none"\n`);
	assert.equal(parsed.ollama.temperature, 0.2);
	assert.equal(parsed.ollama.max_tokens, 512);
	assert.equal(endpointFor("ollama/m", parsed).params?.reasoning_effort, "none");
});

test("a verdict truncated by the token cap says so instead of looking like a broken model", async () => {
	// A reasoning model that spends its whole budget thinking comes back with an
	// empty content AND an empty reasoning_content — ollama drops the partial
	// thinking. Reported raw, that reads as "no usable verdict: " with nothing
	// after the colon, which sends you looking at the model rather than the cap.
	const server = stubEndpoint({}, { choices: [{ finish_reason: "length", message: { content: "" } }] });
	const complete = chatCompleter({ baseUrl: await server.url, model: "m", apiKey: "k", maxTokens: 2048 });
	const verdict = await verify(task, evidence, complete);

	assert.equal(verdict.pass, false);
	assert.equal(verdict.mechanical, true);
	assert.match(verdict.reason, /2048-token budget/);
	assert.match(verdict.reason, /max_tokens/);
	await server.close();
});

test("a truncated reply that still carried the verdict is kept", async () => {
	// Hitting the cap is not itself a failure: if the verdict made it out before
	// the model ran out of room, it counts.
	const server = stubEndpoint({}, {
		choices: [{ finish_reason: "length", message: { content: '{"pass": true, "reason": "ok"}' } }],
	});
	const complete = chatCompleter({ baseUrl: await server.url, model: "m", apiKey: "k", maxTokens: 2048 });
	assert.equal((await verify(task, evidence, complete)).pass, true);
	await server.close();
});

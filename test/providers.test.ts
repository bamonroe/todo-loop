import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import { completerFor, endpointFor, piAuthKey, resolveApiKey } from "../src/providers.ts";
import { chatCompleter, verify } from "../src/verify.ts";

const config: Config = { ...DEFAULT_CONFIG, ollama: { base_url: "http://localhost:11434/v1" } };

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
	// No cap locally: an over-thinking model costs time, not money.
	assert.equal(endpoint.maxTokens, undefined);
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

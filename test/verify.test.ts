import assert from "node:assert/strict";
import { test } from "node:test";
import type { Evidence } from "../src/evidence.ts";
import { truncateTail } from "../src/evidence.ts";
import { buildVerifierPrompt, parseVerdict, verify } from "../src/verify.ts";

const task = { id: "a.one", title: "Add a health endpoint" };

const clean: Evidence = {
	diff: "+++ b/server.ts\n+app.get('/health', ...)",
	files: ["server.ts"],
	dirty: false,
	commands: [{ command: "npm test", ok: true, code: 0, output: "12 passing" }],
};

test("parses a bare JSON verdict", () => {
	assert.deepEqual(parseVerdict('{"pass": true, "reason": "endpoint added"}'), {
		pass: true,
		reason: "endpoint added",
	});
});

test("parses a fenced verdict", () => {
	const verdict = parseVerdict('Sure!\n```json\n{"pass": false, "reason": "no route registered"}\n```');
	assert.equal(verdict?.pass, false);
	assert.equal(verdict?.reason, "no route registered");
});

test("strips reasoning blocks before parsing", () => {
	const verdict = parseVerdict('<think>hmm, the diff adds it</think>\n{"pass": true, "reason": "ok"}');
	assert.equal(verdict?.pass, true);
});

test("falls back to an unambiguous verbal verdict", () => {
	assert.equal(parseVerdict("FAIL — the handler is never wired up")?.pass, false);
	assert.equal(parseVerdict("gibberish with no verdict at all"), undefined);
});

test("mechanical failures short-circuit the model call", async () => {
	let called = false;
	const verdict = await verify(task, { ...clean, hardFailure: "tests failed" }, async () => {
		called = true;
		return '{"pass": true, "reason": "looks fine"}';
	});
	assert.equal(called, false);
	assert.equal(verdict.pass, false);
	assert.equal(verdict.mechanical, true);
});

test("an unreachable verifier fails closed", async () => {
	const verdict = await verify(task, clean, async () => {
		throw new Error("connection refused");
	});
	assert.equal(verdict.pass, false);
	assert.match(verdict.reason, /connection refused/);
});

test("an unparseable verdict fails closed", async () => {
	const verdict = await verify(task, clean, async () => "I am not sure, maybe?");
	assert.equal(verdict.pass, false);
	assert.equal(verdict.mechanical, true);
});

test("the verifier never sees the worker's self-report", () => {
	const prompt = buildVerifierPrompt(task, clean);
	assert.match(prompt, /Add a health endpoint/);
	assert.match(prompt, /server\.ts/);
	assert.match(prompt, /12 passing/);
	assert.doesNotMatch(prompt, /summary/i);
});

test("truncateTail keeps the end", () => {
	const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
	const out = truncateTail(text, 200);
	assert.match(out, /line 199$/);
	assert.match(out, /^\[\.\.\. truncated/);
	assert.ok(Buffer.byteLength(out) < Buffer.byteLength(text));
});

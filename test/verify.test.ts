import assert from "node:assert/strict";
import { test } from "node:test";
import type { Evidence } from "../src/evidence.ts";
import { truncateHead, truncateMiddle, truncateTail } from "../src/evidence.ts";
import { VERIFIER_SYSTEM_PROMPT, buildVerifierPrompt, parseVerdict, verify } from "../src/verify.ts";

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

test("a truncation marker reports how many bytes went missing, not just the budget", () => {
	const text = "x".repeat(5000);

	const head = truncateHead(text, 1000);
	assert.match(head, /truncated by todo-loop/);
	// The number that matters is what is absent, which the old marker never said.
	assert.match(head, /showing the first 1000 of 5000 bytes/);
	assert.match(head, /4000 bytes \(80%\) were dropped/);

	const tail = truncateTail(text, 1000);
	assert.match(tail, /showing the last 1000 of 5000 bytes/);
	assert.match(tail, /4000 bytes \(80%\) were dropped/);
});

test("a middle cut keeps both ends, because which end matters is a property of the command", () => {
	// javap goes through bash and puts the class declaration at the head; a
	// build goes through bash and puts its verdict at the tail. One rule per
	// tool cannot be right for both.
	// A 17-byte filler line on purpose: with a line length that divides the
	// budget the tail lands on a boundary by luck and the trim goes untested.
	const text = `HEAD MATTERS\n${"filler line here\n".repeat(400)}TAIL MATTERS`;
	const out = truncateMiddle(text, 400, 0.25);
	assert.match(out, /^HEAD MATTERS/);
	assert.match(out, /TAIL MATTERS$/);
	assert.ok(Buffer.byteLength(out, "utf8") < Buffer.byteLength(text, "utf8"));
	assert.match(out, /showing the first 100 and last 300 of \d+ bytes/);
	assert.match(out, /dropped from the middle to fit the budget, not omitted by the implementer/);
	// The kept tail starts at a line boundary; a half line reads as corruption.
	const resumed = out.split("not omitted by the implementer ...]\n")[1];
	assert.ok(resumed.startsWith("filler line here\n"), `tail resumed mid-line: ${JSON.stringify(resumed.slice(0, 40))}`);
});

test("a middle cut leaves short output entirely alone and degrades to one end at the extremes", () => {
	assert.equal(truncateMiddle("short", 400, 0.25), "short");
	const text = `HEAD\n${"x".repeat(5000)}\nTAIL`;
	assert.match(truncateMiddle(text, 500, 0), /showing the last 500 of/);
	assert.match(truncateMiddle(text, 500, 1), /showing the first 500 of/);
});

test("the marker says the cut was the harness's, so a judge does not read it as an unfinished diff", () => {
	const out = truncateHead("y".repeat(3000), 500);
	assert.match(out, /not omitted by the implementer/);
});

test("the verifier is told a truncation marker is never on its own a reason to fail", () => {
	assert.match(VERIFIER_SYSTEM_PROMPT, /truncated by todo-loop/);
	assert.match(VERIFIER_SYSTEM_PROMPT, /never by itself a reason to fail/);
});

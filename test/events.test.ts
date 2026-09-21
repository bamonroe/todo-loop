import assert from "node:assert/strict";
import test from "node:test";

import { describeTelemetry, emptyTelemetry, SessionMonitor } from "../src/events.ts";

/** A monitor with a clock we control and a log we can read back. */
function monitor(start = 1_000): { m: SessionMonitor; lines: string[]; tick: (ms: number) => void } {
	const lines: string[] = [];
	let clock = start;
	const m = new SessionMonitor({ onLine: (line) => lines.push(line), now: () => clock });
	return { m, lines, tick: (ms) => (clock += ms) };
}

function event(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

const assistant = (text: string, usage?: { input: number; output: number }): string =>
	event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], usage } });

test("tool calls are counted per tool and echoed with their subject", () => {
	const { m, lines } = monitor();
	m.feed(event({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "./gradlew  assembleDebug" } }));
	m.feed(event({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false }));
	m.feed(event({ type: "tool_execution_start", toolCallId: "b", toolName: "edit", args: { file_path: "app/src/Eq.kt" } }));
	m.feed(event({ type: "tool_execution_end", toolCallId: "b", toolName: "edit", isError: false }));
	m.feed(event({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "git diff" } }));
	m.feed(event({ type: "tool_execution_end", toolCallId: "c", toolName: "bash", isError: true }));

	const t = m.telemetry;
	assert.equal(t.tools, 3);
	assert.deepEqual(t.byTool, { bash: 2, edit: 1 });
	assert.equal(t.toolErrors, 1);
	// The echo has to name the tool *and* enough of its argument to tell two
	// bash calls apart; whitespace is flattened so one call is one line.
	assert.deepEqual(lines, ["  → bash ./gradlew assembleDebug", "  → edit app/src/Eq.kt", "  → bash git diff", "  ✗ bash failed"]);
});

test("a tool with no recognisable subject still gets its arguments summarised", () => {
	const { m, lines } = monitor();
	m.feed(event({ type: "tool_execution_start", toolCallId: "a", toolName: "todo_add", args: { level: "act", parent: "eq" } }));
	assert.equal(lines[0], '  → todo_add {"level":"act","parent":"eq"}');

	// The loop's own tools say what they are doing in `summary` and `reason`,
	// and those are the two calls that decide whether a task closes.
	m.feed(event({ type: "tool_execution_start", toolCallId: "b", toolName: "todo_complete", args: { summary: "Planned three acts in order" } }));
	m.feed(event({ type: "tool_execution_start", toolCallId: "c", toolName: "todo_block", args: { reason: "no such module" } }));
	assert.deepEqual(lines.slice(1), ["  → todo_complete Planned three acts in order", "  → todo_block no such module"]);
});

test("a long argument is cut to one line", () => {
	const { m, lines } = monitor();
	m.feed(event({ type: "tool_execution_start", toolCallId: "a", toolName: "write", args: { file_path: "a".repeat(400), content: "x" } }));
	assert.ok(lines[0].length < 140, `one tool call is one log line, got ${lines[0].length}`);
	assert.ok(lines[0].endsWith("…"));
});

test("message_update is neither echoed nor counted, however much of it there is", () => {
	// One event per token: if this were parsed and kept, a thirty-minute session
	// would cost the driver orders of magnitude more memory and log than a
	// thirty-second one, which is the whole reason text mode was tolerable.
	const { m, lines } = monitor();
	for (let i = 0; i < 500; i++) {
		m.feed(event({ type: "message_update", usage: { input: 9, output: i }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }));
	}
	assert.deepEqual(lines, []);
	assert.equal(m.text, "");
	assert.equal(m.telemetry.outputTokens, 0);
	// It is still evidence that pi is speaking JSON.
	assert.equal(m.telemetry.sawEvents, true);
});

test("message_update is dropped even if pi reorders its keys", () => {
	// The hot path matches on the raw prefix. The parsed switch has to drop it
	// too, or a future pi that emits `usage` first turns the fast path off and
	// every delta starts being counted.
	const { m, lines } = monitor();
	m.feed(event({ usage: { input: 1, output: 1 }, type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }));
	assert.deepEqual(lines, []);
	assert.equal(m.text, "");
});

test("only the assistant's text is kept, so BLOCKED is read from what the worker said", () => {
	const { m } = monitor();
	m.feed(event({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "BLOCKED: this is the prompt, not an answer" }] } }));
	m.feed(event({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", text: "BLOCKED: this is me thinking aloud" }] } }));
	m.feed(assistant("Done: the engine now converts millibels."));
	assert.equal(m.text.trim(), "Done: the engine now converts millibels.");
});

test("context tokens are the last message's input, not the sum of every turn's", () => {
	// Each turn re-sends the whole conversation. Summing `input` would report a
	// worker that read fifty thousand tokens twenty times as having read a
	// million, and hide the number that matters: how large it actually got.
	const { m } = monitor();
	m.feed(assistant("one", { input: 5_000, output: 100 }));
	m.feed(assistant("two", { input: 9_000, output: 250 }));
	const t = m.telemetry;
	assert.equal(t.contextTokens, 9_000);
	assert.equal(t.outputTokens, 350);
});

test("a tool that never ends is named, with how long it has been stuck", () => {
	// This is the whole point: read mid-session from the timeout handler, the
	// answer to "the worker overran doing what?".
	const { m, tick } = monitor();
	m.feed(event({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: { command: "./gradlew test" } }));
	tick(412_000);
	assert.deepEqual(m.telemetry.inFlight, { name: "bash", elapsedMs: 412_000 });

	m.feed(event({ type: "tool_execution_end", toolCallId: "a", toolName: "bash", isError: false }));
	assert.equal(m.telemetry.inFlight, undefined, "a tool that finished is not what the worker is stuck in");
});

test("turns and compactions are counted, and compaction is visible in the log", () => {
	const { m, lines } = monitor();
	m.feed(event({ type: "turn_start" }));
	m.feed(event({ type: "turn_start" }));
	m.feed(event({ type: "compaction_start" }));
	m.feed(event({ type: "compaction_end" }));
	assert.equal(m.telemetry.turns, 2);
	assert.equal(m.telemetry.compactions, 1);
	assert.ok(lines.some((line) => line.includes("compacting")));
});

test("output that is not an event stream passes through unchanged", () => {
	// The driver has to keep working against a pi that is not in JSON mode — an
	// older build, or a stub on PATH — rather than reading every session as
	// empty. A plain line is echoed and kept exactly as it arrived.
	const { m, lines } = monitor();
	m.feed("Scaffolded the project.\nBLOCKED: no such module\n");
	assert.deepEqual(lines, ["Scaffolded the project.", "BLOCKED: no such module"]);
	assert.match(m.text, /BLOCKED: no such module/);
	assert.equal(m.telemetry.sawEvents, false);
	assert.equal(describeTelemetry(m.telemetry), "", "nothing to report is reported as nothing");
});

test("a line broken across two chunks is still one event", () => {
	const { m, lines } = monitor();
	const line = event({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "NOTES.md" } });
	m.feed(line.slice(0, 30));
	assert.deepEqual(lines, [], "nothing is emitted until the newline arrives");
	m.feed(line.slice(30));
	assert.deepEqual(lines, ["  → read NOTES.md"]);
	assert.equal(m.telemetry.tools, 1);
});

test("end() flushes a last line that arrived without its newline", () => {
	// A killed worker's stdout ends mid-stream, and the last thing it said is
	// exactly the part worth having.
	const { m, lines } = monitor();
	m.feed('Nearly done.\nBLOCKED: the emulator never booted');
	assert.equal(m.text.trim(), "Nearly done.");
	m.end();
	assert.match(m.text, /BLOCKED: the emulator never booted/);
	assert.equal(lines.length, 2);
});

test("only the tail of a long session's text is kept", () => {
	// The last BLOCKED declaration wins and the closing summary is what the
	// driver reads, so an unbounded transcript buys nothing but memory.
	const lines: string[] = [];
	const m = new SessionMonitor({ onLine: (line) => lines.push(line), maxTextBytes: 200 });
	for (let i = 0; i < 100; i++) m.feed(assistant(`line ${i} ${"padding".repeat(3)}`));
	assert.ok(m.text.length <= 200, `kept ${m.text.length} bytes`);
	assert.match(m.text, /line 99/);
	assert.doesNotMatch(m.text, /line 0 /);
});

test("the session summary names the cost, and says so when nothing was called", () => {
	const t = { ...emptyTelemetry(), sawEvents: true, turns: 3, tools: 14, toolErrors: 1, byTool: { bash: 9, edit: 5 }, compactions: 1, contextTokens: 47_400, outputTokens: 12_100, inFlight: { name: "bash", elapsedMs: 412_000 } };
	assert.equal(
		describeTelemetry(t),
		"14 tool calls (bash×9, edit×5), 1 failed, 3 turns, 47k context / 12k out, 1 compaction, still inside bash after 412s",
	);

	// A worker that called nothing cannot have changed anything, which is the
	// most useful single fact about one that ran out of clock.
	assert.match(describeTelemetry({ ...emptyTelemetry(), sawEvents: true, turns: 1 }), /^no tool calls/);
});

test("the telemetry a caller reads is a snapshot, not the monitor's own state", () => {
	// The timeout handler reads it mid-session and the close handler reads it
	// again. If the first read handed out the live object, the second session's
	// counts would land in the first one's report.
	const { m } = monitor();
	m.feed(event({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args: {} }));
	const snapshot = m.telemetry;
	m.feed(event({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: {} }));
	assert.equal(snapshot.tools, 1);
	assert.deepEqual(snapshot.byTool, { bash: 1 });
});

// ------------------------------------------- the thinking of a dying worker

/** One thinking delta, shaped exactly as pi --mode json emits it. */
const thinking = (delta: string): string =>
	event({ type: "message_update", usage: {}, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } });

test("an unfinished message's reasoning survives the kill that ends it", () => {
	// The only case that matters. A message still being generated when the
	// budget runs out never produces a message_end, so the delta stream is the
	// only place its reasoning exists — and only while the process is alive.
	const { m } = monitor();
	m.feed(thinking("The decompiler route "));
	m.feed(thinking("is not working: javap "));
	m.feed(thinking("cannot read the Compose jar."));
	assert.equal(m.thinking, "The decompiler route is not working: javap cannot read the Compose jar.");
});

test("a finished message's reasoning is dropped, because it is spent", () => {
	// pi discards it between turns, the worker already acted on it, and carrying
	// the previous turn's thoughts into a retry would describe the wrong moment.
	const { m } = monitor();
	m.feed(thinking("First I will read the file."));
	m.feed(assistant("Reading it now."));
	assert.equal(m.thinking, "");
});

test("only the last thoughts before the kill are kept", () => {
	const { m } = monitor();
	const small = new SessionMonitor({ maxThinkingBytes: 20 });
	for (let i = 0; i < 50; i++) small.feed(thinking(`chunk${i} `));
	assert.ok(small.thinking.length <= 20, small.thinking);
	assert.ok(small.thinking.includes("chunk49"), "the tail, where a reasoning block states its conclusion");
	assert.ok(!small.thinking.includes("chunk0 "), "not the head");
	assert.equal(m.thinking, "");
});

test("reading the deltas does not turn message_update into a counted event", () => {
	// The cost argument for skipping these lines still has to hold: they are one
	// per token, and nothing about them is a turn, a tool call or an output.
	const { m, lines } = monitor();
	m.feed(thinking("thinking hard"));
	assert.deepEqual(lines, [], "not echoed");
	assert.equal(m.telemetry.turns, 0);
	assert.equal(m.telemetry.tools, 0);
	assert.ok(m.telemetry.sawEvents);
});

test("a message_update that carries no thinking delta is not parsed into thinking", () => {
	const { m } = monitor();
	m.feed(event({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hello" } }));
	assert.equal(m.thinking, "");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { clockTime, describePhases, formatDuration, stampConsole } from "../src/clock.ts";

test("a duration is read without counting digits, at every scale", () => {
	// Sub-ten-second keeps a decimal: a 0.3s tool call and a 4s one are
	// different animals, and rounding both to "0s"/"4s" loses the cheap one.
	assert.equal(formatDuration(320), "0.3s");
	assert.equal(formatDuration(4200), "4.2s");
	assert.equal(formatDuration(12_000), "12s");
	assert.equal(formatDuration(72_400), "72s");
	// Just past 90s is the first minute reading; without a case here, widening
	// the seconds branch to a quarter of an hour goes unnoticed.
	assert.equal(formatDuration(95_000), "1m35s");
	assert.equal(formatDuration(600_000), "10m00s");
	// Past 90s the minute is the unit a human thinks in.
	assert.equal(formatDuration(1_872_000), "31m12s");
	assert.equal(formatDuration(1_800_000), "30m00s");
	assert.equal(formatDuration(3_840_000), "1h04m");
	// A clock that ran backwards is not a negative duration.
	assert.equal(formatDuration(-5), "0s");
});

test("the stamp is local wall clock, because that is what git and docker log", () => {
	const at = new Date(2026, 8, 21, 9, 7, 3).getTime();
	assert.equal(clockTime(at), "09:07:03");
});

test("only the phases that ran are named", () => {
	assert.equal(describePhases([["worker", 1_800_000], ["verify", 69_000]]), "worker 30m00s, verify 69s");
	// A timed-out act never reaches a verifier: no phase, not a zero-length one.
	assert.equal(describePhases([["worker", 1_800_000], ["verify", undefined]]), "worker 30m00s");
	assert.equal(describePhases([["worker", undefined]]), "");
});

test("stamping wraps both streams and hands back the console it found", () => {
	const lines: string[] = [];
	const realLog = console.log;
	const realError = console.error;
	console.log = (...args: unknown[]): void => void lines.push(args.join(" "));
	console.error = (...args: unknown[]): void => void lines.push(args.join(" "));
	const at = new Date(2026, 8, 21, 14, 7, 31).getTime();
	const undo = stampConsole(() => at);

	console.log("✓ eq.thing verified");
	console.error("✗ eq.thing rejected");
	// Spacing is spacing: a stamped blank line is a column of bare timestamps.
	console.log("");
	// The iteration separator keeps its break, and the text after it is what
	// gets stamped — not the emptiness before it.
	console.log("\n=== [6/50] code — eq.thing ===");

	undo();
	console.log("after the undo");
	// Both streams were patched, so both have to be handed back — a run that
	// restores only stdout leaves every later stderr line stamped.
	console.error("stderr after the undo");
	const captured = lines.slice();
	console.log = realLog;
	console.error = realError;

	assert.deepEqual(captured, [
		"[14:07:31] ✓ eq.thing verified",
		"[14:07:31] ✗ eq.thing rejected",
		"",
		"\n[14:07:31] === [6/50] code — eq.thing ===",
		"after the undo",
		"stderr after the undo",
	]);
});

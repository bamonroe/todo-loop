#!/usr/bin/env -S node --experimental-strip-types
/**
 * Where a run's wall clock actually went: generating, or waiting on tools.
 *
 * This exists to score the economics block in src/prompt.ts, the same way
 * provenance-count.ts scores the provenance block. The block was written
 * against a measurement, and a measurement that lives in a commit message
 * cannot be repeated, so the measuring is code.
 *
 * The finding it came from, over the last eight sessions of run 14:
 *
 *   tool time        1.3 minutes   — every build, lint, API lookup, file read
 *                                    and emulator screenshot, added together
 *   generation time  123.6 minutes — 96 turns at 77 seconds each
 *   thinking share   98%           — of the characters the worker produced
 *
 * The worst three turns took eleven to twelve minutes each and reached no tool
 * call until the end. In them the worker wrote out an API signature from
 * memory, argued with itself about a parameter that does not exist, drafted a
 * whole file in prose, and then wrote the file. One opened by planning its
 * calls with the note "keep count low!" — which it had learnt from us.
 *
 *   node --experimental-strip-types scripts/turn-cost.ts <session-dir> [--since-hours N] [--worst N]
 *
 * The session directory is pi's, e.g. ~/.pi/agent/sessions/--data-eq2--.
 *
 * What to read. `tool` staying near zero is the point being made, not a
 * problem. The number to watch is the slowest turns: a turn that generates for
 * minutes and ends in a lookup is the failure the economics block is aimed at,
 * and the honest test of whether it worked is whether that tail shortens.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

interface Turn {
	/** Seconds from the previous record to this assistant message. */
	seconds: number;
	session: string;
	input: number;
	output: number;
	thinking: number;
	text: number;
	/** Tools this turn asked for, in order. */
	calls: string[];
}

interface Usage {
	input?: number;
	output?: number;
}

interface Block {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	toolName?: string;
}

interface Message {
	role?: string;
	content?: Block[];
	usage?: Usage;
	toolName?: string;
}

function stamp(value: unknown): number {
	const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed / 1000 : Number.NaN;
}

interface SessionCost {
	name: string;
	wall: number;
	generation: number;
	tool: number;
	turns: Turn[];
	toolSeconds: Map<string, number>;
}

function readSession(file: string): SessionCost | undefined {
	const cost: SessionCost = {
		name: basename(file).slice(11, 19),
		wall: 0,
		generation: 0,
		tool: 0,
		turns: [],
		toolSeconds: new Map(),
	};
	let previous = Number.NaN;
	let first = Number.NaN;
	let last = Number.NaN;

	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let record: { type?: string; timestamp?: unknown; message?: Message };
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const at = stamp(record.timestamp);
		if (!Number.isFinite(at)) continue;
		if (!Number.isFinite(first)) first = at;
		last = at;

		const message = record.message;
		// The gap before a record is time spent producing it: before an assistant
		// message the model was generating, before a tool result the tool was
		// running. A user message is the task text and has no gap worth naming.
		const gap = Number.isFinite(previous) ? at - previous : 0;
		previous = at;

		if (message.role === "assistant") {
			cost.generation += gap;
			const blocks = Array.isArray(message.content) ? message.content : [];
			cost.turns.push({
				seconds: gap,
				session: cost.name,
				input: message.usage?.input ?? 0,
				output: message.usage?.output ?? 0,
				thinking: blocks.reduce((sum, block) => sum + (block.thinking?.length ?? 0), 0),
				text: blocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0),
				calls: blocks.filter((block) => block.type === "toolCall").map((block) => block.name ?? "?"),
			});
		} else if (message.role === "toolResult") {
			cost.tool += gap;
			const name = message.toolName ?? "?";
			cost.toolSeconds.set(name, (cost.toolSeconds.get(name) ?? 0) + Math.max(gap, 0));
		}
	}

	if (!cost.turns.length) return undefined;
	cost.wall = last - first;
	return cost;
}

const minutes = (seconds: number): string => `${(seconds / 60).toFixed(1)}m`;

const dir = process.argv[2];
if (!dir) {
	console.error("usage: turn-cost.ts <pi-session-dir> [--since-hours N] [--worst N]");
	process.exit(2);
}
const sinceIndex = process.argv.indexOf("--since-hours");
const cutoff = sinceIndex > 0 ? Date.now() - Number(process.argv[sinceIndex + 1]) * 3600_000 : 0;
const worstIndex = process.argv.indexOf("--worst");
const worstCount = worstIndex > 0 ? Number(process.argv[worstIndex + 1]) : 5;

const files = readdirSync(dir)
	.filter((name) => name.endsWith(".jsonl"))
	.map((name) => join(dir, name))
	.filter((file) => statSync(file).mtimeMs > cutoff)
	.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

const sessions = files.map(readSession).filter((session): session is SessionCost => !!session);
if (!sessions.length) {
	console.error(`no sessions with any turns in ${dir}`);
	process.exit(1);
}

console.log("session   wall     generating  tools    turns  out tok");
for (const session of sessions) {
	const output = session.turns.reduce((sum, turn) => sum + turn.output, 0);
	console.log(
		`${session.name}  ${minutes(session.wall).padStart(6)}  ${minutes(session.generation).padStart(9)}  ` +
			`${minutes(session.tool).padStart(6)}  ${String(session.turns.length).padStart(5)}  ${String(output).padStart(7)}`,
	);
}

const turns = sessions.flatMap((session) => session.turns);
const generation = sessions.reduce((sum, session) => sum + session.generation, 0);
const tool = sessions.reduce((sum, session) => sum + session.tool, 0);
const output = turns.reduce((sum, turn) => sum + turn.output, 0);
const thinking = turns.reduce((sum, turn) => sum + turn.thinking, 0);
const spoken = turns.reduce((sum, turn) => sum + turn.text, 0);
const calls = turns.reduce((sum, turn) => sum + turn.calls.length, 0);

console.log(
	`\n${sessions.length} sessions · ${turns.length} turns · generating ${minutes(generation)} · tools ${minutes(tool)}` +
		` (${generation > 0 ? (generation / Math.max(tool, 0.001)).toFixed(0) : "0"}x)`,
);
console.log(
	`per turn: ${(generation / turns.length).toFixed(0)}s · ${Math.round(output / turns.length)} output tokens · ` +
		`${(calls / turns.length).toFixed(2)} tool calls`,
);
console.log(
	`thinking share: ${thinking + spoken > 0 ? ((thinking * 100) / (thinking + spoken)).toFixed(0) : "0"}% of generated characters`,
);
console.log(`decode rate: ${(output / Math.max(generation, 1)).toFixed(1)} tok/s, prefill included`);

// The tail, which is the whole reason this script exists. A turn that spends
// minutes and asks for nothing is the shape the economics block is aimed at.
const worst = [...turns].sort((a, b) => b.seconds - a.seconds).slice(0, worstCount);
console.log(`\nslowest ${worst.length} turns:`);
for (const turn of worst) {
	const asked = turn.calls.length ? turn.calls.join(", ") : "nothing";
	console.log(
		`  ${turn.session}  ${(turn.seconds / 60).toFixed(1)}m  ${turn.output} out tok  ` +
			`${turn.thinking + turn.text > 0 ? Math.round((turn.thinking * 100) / (turn.thinking + turn.text)) : 0}% thinking  → ${asked}`,
	);
}

const byTool = new Map<string, number>();
for (const session of sessions) {
	for (const [name, seconds] of session.toolSeconds) byTool.set(name, (byTool.get(name) ?? 0) + seconds);
}
if (byTool.size) {
	console.log("\nwhere the tool time went:");
	for (const [name, seconds] of [...byTool].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
		console.log(`  ${name.padEnd(22)} ${minutes(seconds)}`);
	}
}

console.log(
	"\nbaseline, run 14's last eight sessions, before the economics block:" +
		"\n  generating 123.6m · tools 1.3m (95x) · 77s per turn · 98% thinking · worst turn 12.3m",
);

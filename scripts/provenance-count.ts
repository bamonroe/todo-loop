#!/usr/bin/env -S node --experimental-strip-types
/**
 * Count, in a run's pi transcripts, how often the worker treated something it
 * wrote itself as something it had found out.
 *
 * This exists to score the provenance block in src/prompt.ts. That block was
 * written against a measurement and is worth nothing unless the measurement is
 * repeatable, so the measuring is code rather than a number in a commit
 * message.
 *
 * Two counts, which are the two directions the confusion runs:
 *
 *   distrust — the worker doubting a tool result that was in fact correct.
 *              Run 14's dominant case, and a confabulation from nothing: it
 *              repeatedly believed it had put stray carriage returns into its
 *              own edit payloads. There were none, in any file, any tool call
 *              or any tool result of that run.
 *   theory   — the worker explaining how a tool works internally, then acting
 *              on the explanation. Rarer and far more expensive: one iteration
 *              spent its whole thirty-minute budget and seventeen lookups on
 *              a theory that the API tool was hiding static members.
 *
 * Both are reported per hundred assistant text blocks, because runs differ in
 * length and the raw count does not compare.
 *
 *   node --experimental-strip-types scripts/provenance-count.ts <session-dir> [--since-hours N]
 *
 * The session directory is pi's, e.g. ~/.pi/agent/sessions/--data-eq2--.
 *
 * Baseline is run 14, which was already under way when the provenance block
 * was written and so ran entirely without it. Measured at its iteration 14,
 * over 20 sessions and 540 assistant text blocks: distrust 13 (2.41 per 100),
 * theory 1 (0.19 per 100). Re-run this against run 14 when it finishes to fix
 * the baseline, then against run 15, which is the first run the block reaches.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DISTRUST =
	/suspicious|carriage return|stray .?\\r|trusting the result|verify the real file|actually verify|didn'?t (really|actually) (apply|land|take)/i;

const THEORY =
	/(the |these )?(tool|stubs?|api|lookup|outline|index)\w* (is|are|seems? to|appears? to|must be|might be|probably|apparently)\s+(broken|stripping|strips|hiding|hides|filtering|filters|not showing|wrong|lying|truncating)/i;

function textBlocks(file: string): string[] {
	const out: string[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		const holder = record as { message?: { content?: unknown }; content?: unknown };
		const blocks = holder.message?.content ?? holder.content;
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks) {
			if (!block || typeof block !== "object") continue;
			const b = block as { text?: unknown; thinking?: unknown };
			const text = typeof b.text === "string" ? b.text : typeof b.thinking === "string" ? b.thinking : "";
			if (text) out.push(text);
		}
	}
	return out;
}

const dir = process.argv[2];
if (!dir) {
	console.error("usage: provenance-count.ts <pi-session-dir> [--since-hours N]");
	process.exit(2);
}
const sinceIndex = process.argv.indexOf("--since-hours");
const cutoff = sinceIndex > 0 ? Date.now() - Number(process.argv[sinceIndex + 1]) * 3600_000 : 0;

const files = readdirSync(dir)
	.filter((name) => name.endsWith(".jsonl"))
	.map((name) => join(dir, name))
	.filter((file) => statSync(file).mtimeMs > cutoff)
	.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);

let blocks = 0;
let distrust = 0;
let theory = 0;
const examples: string[] = [];
for (const file of files) {
	for (const text of textBlocks(file)) {
		blocks++;
		if (DISTRUST.test(text)) {
			distrust++;
			if (examples.length < 5) examples.push(text.replace(/\s+/g, " ").slice(0, 160));
		}
		if (THEORY.test(text)) theory++;
	}
}

const per100 = (n: number) => (blocks ? ((n * 100) / blocks).toFixed(2) : "0.00");
console.log(`sessions: ${files.length}   assistant text blocks: ${blocks}`);
console.log(`distrust of a tool result: ${distrust}  (${per100(distrust)} per 100)`);
console.log(`theory about a tool's internals: ${theory}  (${per100(theory)} per 100)`);
console.log("baseline, run 14 at iteration 14, before the provenance block: 2.41 and 0.19 per 100");
if (examples.length) {
	console.log("\nfirst few distrust hits:");
	for (const example of examples) console.log(`  · ${example}`);
}

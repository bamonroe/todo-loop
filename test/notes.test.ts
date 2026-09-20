import assert from "node:assert/strict";
import { test } from "node:test";
import { decideNotesMaintenance, maintenanceHistory, queueNotesMaintenance, COMPACT_PREFIX, SPLIT_ID } from "../src/notes.ts";
import { parseStore } from "../src/store.ts";

const WINDOW = 56_320;
const SHARE = 0.15;
// 0.15 of a 56,320-token window at 4 chars/token ≈ 33,792 bytes.
const LIMIT = SHARE * WINDOW * 4;

function facts(over: Partial<Parameters<typeof decideNotesMaintenance>[0]>) {
	return decideNotesMaintenance({
		bytes: 0,
		windowTokens: WINDOW,
		maxShare: SHARE,
		openMaintenance: false,
		graduated: false,
		...over,
	});
}

test("under budget the tripwire stays quiet", () => {
	assert.equal(facts({ bytes: 40 * 40 }), "none");
	assert.equal(facts({ bytes: Math.floor(LIMIT) }), "none");
});

test("over budget queues a compaction", () => {
	assert.equal(facts({ bytes: Math.ceil(LIMIT) + 1 }), "compact");
});

test("a compaction that could not move the number graduates to structure", () => {
	// Last compaction started from about this size and the file is still there:
	// proven compact, threshold obsolete.
	assert.equal(facts({ bytes: 40_000, lastCompactFromBytes: 41_000 }), "graduate");
});

test("a file that regrew well past the last attempt is compacted again, not graduated", () => {
	// The last compaction worked (file shrank, then legitimately grew with new
	// content). Graduating here would split a file that squeezing still helps.
	assert.equal(facts({ bytes: 80_000, lastCompactFromBytes: 40_000 }), "compact");
});

test("open maintenance waits; a finished split disarms for good", () => {
	assert.equal(facts({ bytes: 80_000, openMaintenance: true }), "wait");
	assert.equal(facts({ bytes: 80_000, graduated: true }), "none");
	assert.equal(facts({ bytes: 80_000, maxShare: 0 }), "none");
});

const QUEUE = `
[[task]]
id = "eq"
title = "Equalizer"
level = "plan"
status = "doing"

[[task]]
id = "eq.done"
title = "Something finished"
parent = "eq"
status = "done"
`;

test("history is read from the queue, not from a state file", () => {
	const store = parseStore(`${QUEUE}
[[task]]
id = "${COMPACT_PREFIX}40000"
title = "Compact NOTES.md"
parent = "eq"
kind = "docs"
status = "done"

[[task]]
id = "${SPLIT_ID}"
title = "Split NOTES.md"
parent = "eq"
kind = "docs"
status = "todo"
`);
	const history = maintenanceHistory(store);
	assert.equal(history.lastCompactFromBytes, 40_000);
	assert.equal(history.openMaintenance, true);
	assert.equal(history.graduated, false);
});

test("maintenance acts land under the root plan with the facts in their detail", () => {
	const store = parseStore(QUEUE);
	const task = queueNotesMaintenance(store, "compact", "NOTES.md", 40_000, WINDOW);
	assert.ok(task);
	assert.equal(task.parent, "eq");
	assert.equal(task.kind, "docs");
	assert.equal(task.id, `${COMPACT_PREFIX}40000`);
	// The rules that make compaction safe: keep the expensive facts, add nothing.
	assert.match(task.detail ?? "", /version, an API, a path or a command/);
	assert.match(task.detail ?? "", /Add nothing new/);
	// Queueing the same maintenance twice is refused.
	assert.equal(queueNotesMaintenance(store, "compact", "NOTES.md", 40_000, WINDOW), undefined);

	const split = queueNotesMaintenance(store, "graduate", "NOTES.md", 40_000, WINDOW);
	assert.ok(split);
	assert.match(split.detail ?? "", /index/);
	assert.match(split.detail ?? "", /notes\/<topic>\.md/);
	assert.match(split.detail ?? "", /nothing may be deleted/);
});

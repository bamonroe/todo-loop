import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { lastReply, piCallArgs, piCompleter } from "../src/picall.ts";

const end = (text: string, extra = {}) =>
	JSON.stringify({ type: "agent_end", messages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text }], ...extra }] });

test("the call names the provider and model, and sends the prompt as a file", () => {
	const args = piCallArgs("openai-codex", "gpt-6-luna", "judge it", "/tmp/p.md");
	assert.deepEqual(args.slice(-5), ["--provider", "openai-codex", "--model", "gpt-6-luna", "@/tmp/p.md"]);
	assert.ok(args.includes("--no-tools") && args.includes("--no-session"));
});

test("the reply is the last assistant text, and an error stop is an error", () => {
	assert.equal(lastReply(`{"type":"agent_start"}\n${end('{"pass": true}')}\n`), '{"pass": true}');
	assert.throws(() => lastReply(end("", { stopReason: "error", errorMessage: "401" })), /error: 401/);
	assert.throws(() => lastReply("not json\n"), /no reply/);
});

test("a completer runs pi and returns its verdict", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picall-"));
	const fake = path.join(dir, "pi");
	fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' '${end("VERDICT")}'\n`);
	fs.chmodSync(fake, 0o755);
	const complete = piCompleter("openai-codex", "gpt-6-luna", { command: fake });
	assert.equal(await complete({ system: "s", user: "u" }), "VERDICT");
});

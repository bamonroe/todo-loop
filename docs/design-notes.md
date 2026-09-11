# Autonomous To-Do Loop in the Pi Harness

Notes on building a self-driving task loop in Pi (earendil-works), targeting a
local model with limited VRAM and a narrow context window.

---

## 1. Terminology: there is no "todo plugin"

Pi's unit of extension is an **extension** — a TypeScript module loaded from
`~/.pi/agent/extensions/` (global) or `.pi/extensions/` (project-local).
"Plugin" is loose usage in the community; the API calls them extensions.

Pi ships **no built-in to-dos by design**. The stated reasoning is that they
confuse models; the suggested alternatives are a `TODO.md` file or your own
extension. So anything todo-shaped is something you add.

Prior art worth reading:

| Thing | Where | Notes |
|---|---|---|
| Official example | `packages/coding-agent/examples/extensions/todo.ts` | One `todo` tool, actions `list`/`add`/`toggle`/`clear`, TypeBox params |
| `pi-til-done` | pi.dev gallery | `write_todos`/`edit_todos`, statuses `not_started` → `in_progress` → `complete`, iterates until done |
| Rust port | `nktkt/pi` | `todo` is a **built-in** tool there, alongside read/write/edit/bash/grep/glob/web_fetch |

The design detail worth stealing from the official example: it stores state in
**tool result `details`**, not an external file. Because state lives in the
conversation, branching and rewinding give you the correct todo state for that
point in history automatically. External files break this.

For the loop below, `todo.toml` on disk is the right choice anyway — it has to
survive session replacement, which conversation-embedded state does not.

---

## 2. Two shapes for the loop

### Option 1 — Shell driver (recommended first version)

Pi's print mode (`-p`) is one process per prompt, so "clear the context" is free:
it's process exit.

```bash
while task=$(todo-next --toml todo.toml); [ -n "$task" ]; do
  pi -p "$task" || break
  todo-archive --toml todo.toml
done
```

Fresh context per task is guaranteed by the OS rather than by session
bookkeeping. You can checkpoint with git between iterations, and failures are
loud. For a weak-model setup where mechanical verification is the whole thesis,
this is the version that fails in ways you can see.

### Option 2 — In-session extension

Keeps everything inside one Pi process. More capable, more footguns.

The relevant API surface:

- `ctx.newSession({ withSession })` — fresh session, callback runs against the
  **new** context. This is the context clear.
- `ctx.waitForIdle()` — settles through retries, auto-compaction, and queued
  continuations.
- Both live on `ExtensionCommandContext`, i.e. **commands only**. Calling them
  from an event handler can deadlock — which is a trap, because `agent_settled`
  is the natural place to want them.

The way around that is the pattern Pi's own docs use for `/reload`: a tool queues
a command as a follow-up user message, and the command does the session work.

```ts
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  let running = false;
  let current: Task | null = null;

  pi.registerCommand("todo-run", {
    description: "Work the todo.toml queue until empty",
    handler: async (_args, ctx) => { running = true; await startTask(ctx); },
  });

  pi.registerCommand("todo-advance", {          // internal
    description: "Archive current task and start the next",
    handler: async (_args, ctx) => {
      if (!running) return;
      await ctx.waitForIdle();
      await startTask(ctx);
    },
  });

  async function startTask(ctx: ExtensionCommandContext) {
    const task = nextLeaf();                    // leftmost incomplete leaf
    if (!task) { running = false; ctx.ui.notify("Queue empty", "info"); return; }
    current = task;
    await ctx.newSession({
      withSession: async (fresh) => {           // use `fresh`, never captured ctx/pi
        await fresh.sendUserMessage(renderPrompt(task));
      },
    });
  }
}
```

### Three things that will bite you

**Termination signal.** Don't infer completion from "the agent stopped talking."
Make a `todo_complete` tool the only exit, with `terminate: true`, and add an
`agent_settled` handler that halts the loop if a run ended without it. Otherwise
a model that quietly gives up mid-task advances the queue.

**Stale captures.** After `newSession`, the old `pi` and old `ctx` throw if used.
Anything needed inside `withSession` must be plain data — strings, ids —
captured before the switch.

**Hierarchy.** Only leaves become prompts. A parent node's "task" is its
children; handing the model an interior node is how you get a 40-turn run that
touches twelve files.

Cap iterations, and require a clean git tree between tasks before advancing.

---

## 3. Verification: a second opinion before closing a todo

Do the check as a **nested model call inside `todo_complete`** via
`ctx.modelRegistry.streamSimple()`, not as a separate session. This keeps the
worker's context alive for the retry case — if the verifier says "not done," you
want to continue in the existing session, not start cold.

```ts
pi.registerTool({
  name: "todo_complete",
  label: "Complete Todo",
  description: "Mark the current task finished. Only when fully done.",
  promptSnippet: "Mark the assigned todo task complete",
  parameters: Type.Object({ summary: Type.String() }),

  async execute(_id, params, signal, _onUpdate, ctx) {
    const evidence = await gatherEvidence();    // git diff, test output, build status
    const verdict  = await verify(ctx, current, evidence, signal);

    if (verdict.pass) {
      archive(current, params.summary);
      pi.sendUserMessage("/todo-advance", {
        deliverAs: "followUp",
        expandPromptTemplates: true,            // required for command dispatch
      });
      return {
        content: [{ type: "text", text: "Verified and archived." }],
        usage: verdict.usage,
        terminate: true,
      };
    }

    attempts[current.id] = (attempts[current.id] ?? 0) + 1;
    if (attempts[current.id] >= 3) {
      markBlocked(current, verdict.reason);
      running = false;
      return { content: [{ type: "text", text: `Blocked after 3 attempts: ${verdict.reason}` }],
               usage: verdict.usage, terminate: true };
    }

    // No `terminate` — the tool result lands in context and the worker resumes.
    return {
      content: [{ type: "text", text: `Not complete: ${verdict.reason}\nContinue.` }],
      usage: verdict.usage,
    };
  },
});
```

Returning without `terminate` is what resumes the worker. No prompt injection
needed.

### What makes or breaks the verifier

**Give it evidence, not testimony.** The verifier sees the task text, the diff,
and test/build output. It does **not** see the worker's conversation or its
`summary` argument. A model shown another model's confident claim of completion
agrees with it at a rate unrelated to correctness. Withholding the self-report is
most of the value.

**Let tools answer mechanical questions.** Tests passing, build succeeding, file
existing — check in code before the model runs, and short-circuit on failure.
The verifier's only job is the question tooling can't answer: does this diff do
what the task text asked, or something adjacent? That's a narrow judgment a 27B
can make. "Is this correct?" is not.

**Use a different model.** The verify call is short — read a diff, emit a verdict
— so it's cheap even hosted. Qwen as worker, something hosted as verifier, buys
genuine independence for cents per task. Same model judging itself is the weakest
version.

**Force the schema, cap the retries.** Structured verdict
(`{ pass: boolean, reason: string }`), three strikes, then mark blocked in the
toml and halt rather than advance. Without the cap, a slightly-too-strict
verifier becomes an unbounded token burn on a task the worker can't finish.

**Report gaps, not fixes.** Constrain the verifier's prompt so it says what's
missing and never how to fix it. Once it proposes implementations you have two
models negotiating a design, and the task drifts from what the todo said.

---

## 4. Context management on limited VRAM

The per-todo session reset is the main mechanism — context never holds more than
one task. Everything here is about *within-task* growth.

Calibration first: **if compaction fires routinely inside a single task, the
todos are too coarse.** Split them before reaching for compression.

### Pin the task where pruning can't reach it

Put the current todo in the system prompt via `before_agent_start` returning
`{ systemPrompt }`, rather than as the first user message. No amount of context
surgery can then lose the one thing the worker must not forget. Same for the
verifier's last rejection reason.

### The `context` event is the real lever

Fires before every LLM call, hands you a deep copy, and you return what actually
gets sent. The session on disk is untouched, so nothing is destroyed. Highest
value use is eliding old tool results:

```ts
pi.on("context", async (event, ctx) => {
  const usage = ctx.getContextUsage();
  if (!usage || usage.tokens < PRUNE_AT) return;        // leave prefix alone

  const cutoff = nthLastAssistantIndex(event.messages, KEEP_FULL);
  return {
    messages: event.messages.map((m, i) =>
      i < cutoff && m.role === "toolResult" && isBulky(m)
        ? stub(m)   // "[read src/auth.ts — 412 lines, elided; re-read if needed]"
        : m),
  };
});
```

A `read` of a 400-line file is several thousand tokens squatting in context for
the rest of the task when the model needed one function. Stubbing beats
compaction: deterministic, reversible, and the model can just re-read.

### Prune in batches, not every turn

This is the part that bites on local hardware. llama.cpp and Ollama reuse the KV
cache only across a **matching prefix**. Rewriting the middle of the history
forces recompute of everything after the edit point — so a handler that trims a
little every turn means near-full prefill every turn.

Hence the threshold guard above: stable prefix most turns, one big edit when you
cross the line. Same reasoning argues for a large prune step rather than a small
one.

### Truncate at ingestion

Pi's built-in cap is 50KB / 2000 lines, far too generous for a 27B. Use
`truncateTail` in a `tool_result` handler to bring bash and grep output down to
~2KB, writing the full text to a temp file and telling the model where it is.

### Externalize exploration

- Have the worker maintain a `NOTES.md` that survives compaction while the
  exploration that produced it gets elided.
- For scoped lookups ("where is X defined"), do a nested
  `ctx.modelRegistry.streamSimple()` call inside a tool so the search transcript
  never enters the main context — only the answer does.

### Make compaction structured when it does fire

`session_before_compact` lets you return your own summary. For this loop the
right shape is fields, not prose:

```
task:          <verbatim todo text>
files_touched: [...]
verified_done: [...]
remaining:     [...]
last_failure:  <verifier reason>
```

Prose summaries lose exactly the details a weak model needs to resume.

### Runtime settings

`num_ctx` directly sizes the KV cache, so raising it costs the headroom you're
trying to protect. `OLLAMA_KV_CACHE_TYPE=q8_0` with flash attention roughly
halves that at negligible quality cost — usually a better trade than shrinking
the window further. `OLLAMA_KEEP_ALIVE=-1` avoids reload latency between tasks.

---

## 5. Relevant API reference

Gathered from `pi.dev/docs/latest/extensions`.

**Events** (selected, in lifecycle order): `session_start`,
`resources_discover`, `input`, `before_agent_start`, `agent_start`,
`turn_start`, `context`, `before_provider_request`, `tool_execution_start`,
`tool_call` (can block), `tool_result` (can modify), `tool_execution_end`,
`turn_end`, `agent_end`, `agent_settled`, `session_before_compact`,
`session_shutdown`.

**ExtensionContext** (all handlers): `ctx.ui`, `ctx.cwd`, `ctx.sessionManager`,
`ctx.modelRegistry`, `ctx.signal`, `ctx.isIdle()`, `ctx.abort()`,
`ctx.getContextUsage()`, `ctx.compact()`, `ctx.getSystemPrompt()`,
`ctx.shutdown()`.

**ExtensionCommandContext** (commands only — these deadlock from event
handlers): `ctx.waitForIdle()`, `ctx.newSession()`, `ctx.fork()`,
`ctx.navigateTree()`, `ctx.switchSession()`, `ctx.reload()`.

**ExtensionAPI**: `pi.on()`, `pi.registerTool()`, `pi.registerCommand()`,
`pi.sendMessage()`, `pi.sendUserMessage()`, `pi.appendEntry()`,
`pi.setSessionName()`, `pi.setActiveTools()`, `pi.exec()`, `pi.events`.

**Delivery modes** for `sendMessage`/`sendUserMessage`: `"steer"` (after current
assistant turn's tool calls), `"followUp"` (after agent finishes all tools),
`"nextTurn"` (queued, no trigger).

**Truncation helpers**: `truncateHead`, `truncateTail`, `truncateLine`,
`formatSize`, `DEFAULT_MAX_BYTES` (50KB), `DEFAULT_MAX_LINES` (2000).

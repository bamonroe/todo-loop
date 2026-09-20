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

## 5. Levels: who decomposes, and what stops a task being too big

The loop takes the first incomplete **leaf** and never prompts an interior node,
because a parent's work is its children and handing a model a parent is how a
bounded task becomes a forty-turn run. That rule consumes a decomposed queue but
says nothing about where the decomposition comes from. Originally: from you, by
hand, before the run.

The gap that exposes is not subtle. Before levels, an item with no children was
structurally indistinguishable from an atomic task, so an epic dropped into the
queue was selected first and handed to a 27B with "Do exactly this task"
attached — exactly the failure the leaf rule exists to prevent.

`level` closes it. The first design was a ladder of three tiers, smallest first:
**`task`** (atomic, the only level that writes code), **`scope`** (not yet
implementable — read the code, then add the tasks it breaks into), and **`epic`**
(spanning — add scopes and tasks). An epic spawns scopes, a scope spawns tasks, a
task spawns code, so the deepest possible chain is three and nothing recurses.

That ladder is gone; see [§5b](#5b-the-ladder-was-the-wrong-axis) for what
replaced it and why. Everything in the rest of this section was written against
it and still describes the machinery accurately — only the vocabulary moved.

### Why a breakdown needs no model

The verifier exists because "does this diff do what the task asked" has no
mechanical answer. A breakdown is a different question entirely, and all of it is
answerable from the store and the diff: do children exist, are their levels legal,
do their titles stand alone, are there cycles, and **did the working tree stay
clean**.

That last check is the implementation gate inverted. An implementation task with
an empty diff is a hard failure; a breakdown with a *non-empty* diff is the same
failure the other way round. "A scope produces todos, not code" is enforced, not
requested — which matters, because a request is exactly the kind of thing a weak
model drifts away from over twenty turns.

So a breakdown costs no tokens, no network round trip, and nothing leaves the
machine. On a single GPU that is not a small detail: the hosted verifier exists
because a local one evicts the worker on every call, and a breakdown skips the
question altogether.

### The dead end this design walks into, and the way out

The first cut required at least two children, reasoning that one child is a
rename rather than a breakdown. That is true of an epic and false of a scope — a
scope is an open question, and "it turns out to be one task" is a real answer.

With a two-child minimum, a scope that really was one task had no exit. One child
was rejected by the gate; `todo_block`, which the prompt offered as the
alternative, sets `loop.running = false` and halts the entire queue, stranding
every unrelated task behind it. On an overnight run that is the worst available
outcome, and the design produced it on a perfectly ordinary input.

The minimum now applies to epics only, and a scope may return a single task. The
thing the minimum was really protecting — termination — was never its job: an
epic may spawn scopes or tasks and a scope may spawn only tasks, so the deepest
possible chain is epic → scope → task. Nothing can recurse. Blocking is back to
meaning what it says: genuinely impossible, stop and fetch a human.

### Keeping the bottom level atomic

Everything above only pays off if leaf tasks are small enough to fit one session
of a model with no memory of any other. Three layers, because prompting alone
will not hold the line:

**Stated as tests, not adjectives.** "Keep it small" is unfalsifiable. The
breakdown prompt instead asks for things that either succeed or fail: name the
files it touches; count them against `atomic.max_files`; if describing the change
needs "and", it is two tasks; put everything the worker needs in the detail,
because that is the only context it will ever have. *If you cannot name the
files, it is still a scope* does more work than any amount of emphasis.

**Measured.** Two signals say a task overran its budget: compaction firing inside
a single task — the worker ran out of room in work that was supposed to fit — and
a diff touching more files than the budget allows. Both are free; the loop was
already collecting them.

**Acted on.** Overflow is never a failure by itself. The work may be entirely
correct and only the size is in question, and rejecting good work for being broad
would be its own bug. Under `on_overflow = "promote"`, a task that overran *and*
failed verification becomes a scope and gets broken down on the next pass —
rather than burning two more attempts re-running the same oversized prompt. The
default is `warn`, which records it and surfaces it in `status` and `doctor`,
because silently restructuring someone's queue is not a default.

### What the models actually did

Measured on this machine: worker `qwen3.8-27b:default` (IQ3_XXS, 16GB card),
verifier `qwen3.6-plus` on OpenCode Zen. A four-file no-dependency node HTTP
service, and one epic: *add rate limiting to the HTTP API — per client IP,
configurable limit and window, 429 with a JSON body, no new dependencies.*

The 27B broke it into two ordered tasks, and they are the two a person would
write:

1. `src/ratelimit.ts` plus `src/config.ts` — a fixed-window limiter keyed by IP,
   exporting `check(ip): { allowed, retryAfter }`, with defaults named. "Do not
   modify any other files."
2. `src/router.ts` — read the IP off `req.socket.remoteAddress`, call `check`,
   return `json(res, 429, …)` before dispatch. "The `json` helper is already
   defined in `src/router.ts`."

Both name their files, both come in under the file budget, both are
self-contained, and the order runs the right way. The second one proves the
"investigate first" instruction did something: it could only know that `json`
already exists in `router.ts` by having read the file. Neither task needed a
retry, and the epic rolled up on its own.

So the decomposition assumption holds on a well-specified epic. It remains
untested on a vague one, which is where a well-formed but useless breakdown would
show up — and that is the failure the mechanical gate structurally cannot catch.

### What the same run says about the verifier

More interesting, and not what was being tested: **the verifier passed code that
does not run.** `ratelimit.ts` came back importing `"./config"` where every other
file in that project imports `"./config.ts"`, so the service dies on startup with
`ERR_MODULE_NOT_FOUND`. The hosted verifier saw the diff and passed it.

That is not a verifier failure. It is told to judge whether the diff does what the
task asked — which this diff does — and explicitly told not to review code
quality. Resolution errors are not a matter of opinion, and asking a language
model to be a module resolver is the wrong tool.

The run had `test_command` and `build_command` empty. Adding one line:

```toml
build_command = "node --experimental-strip-types -e \"import('./src/router.ts')\""
```

turns the same evidence into a hard mechanical failure that short-circuits
*before the verifier is called at all* — `mechanical: true`, no tokens spent, the
exact stack trace handed back to the worker as the rejection reason.

`todo doctor` warns when neither command is set, and the warning says exactly
this: *"the verifier has to judge everything on the diff alone."* That warning was
present and ignored in the run above. It is worth treating as an error in
practice. The model verifier is for the question tooling cannot answer; every
question tooling *can* answer should reach it already settled.

---

## 5b. The ladder was the wrong axis

Three real runs against a from-scratch Android app produced the same shape every
time, and none of it was a prompting problem.

The measurements, from run 2: zero compactions, peak context 14,138 of a 56,320
window — so the compaction hypothesis was simply wrong. Of 21,878 output tokens,
roughly 20,115 were thinking. Twelve thinking blocks, sized `[225, 149, 329, 63,
169, 80, 833, 53, 73, 100, 11133, 6902]`. **Two blocks hold 82% of all thinking**,
both at the very end, and what they contain is a design for the entire
application — including an `EqDevice` interface — worked out against an empty
directory. About 11,000 output tokens per child that actually landed.

And across all three runs the model produced **zero scopes**. The deferral
affordance existed, the prompt recommended it, and it was never once used.

Both of those follow from the same cause. `level` encoded *depth*, so the root of
a project was an epic, and an epic is by definition everything — which means the
first session had to scope the whole thing before any of it existed. Asked that
question, a model has no available answer except to invent one. And a `scope` is
the model saying "I refuse to decide this now" in a frame that asked it for a
plan; emitting one reads as failing the assignment. The affordance contradicted
the frame it lived in, so no amount of rewording was going to rescue it.

### What replaced it

`level` now says what a session *does*: an **`act`** writes (one session, one
diff, one verdict), a **`plan`** decides what the next few steps are. A plan may
spawn either, so nesting is unbounded.

The load-bearing change is that **plans are re-entrant**. A plan is not finished
by having children; every time its batch completes it comes back for another
round, holding the last few things that landed. It closes only when a round adds
nothing. So it is only ever asked *"what are the next few things?"* — never
*"design this project"* — and by the time it is asked again, the code it needs to
reason about is on disk rather than imagined. That is the whole mechanism. You
cannot prompt away a guess; you can decline to ask for one.

Termination moves accordingly. It used to come from the depth cap; it now comes
from planners running out of next steps. `plan.max_depth` survives only as a
backstop against a branch that plans forever without building.

### Two rules, because planning is comfortable

Unbounded planning is the failure this design trades for the old one, and it is a
*comfortable* failure: reading and re-planning always feels productive and never
risks a failing build. So both guards are mechanical rather than requested.

**Every round must land at least one act.** A round of nothing but plans is
rejected outright.

**Research is allowanced.** "Go and find out about X" is the honest answer when
there is genuinely nothing to build yet, so a `research` act satisfies that rule
— but only `plan.research_budget` times per branch, and the remaining allowance
is *inherited* by child plans rather than reset. Without inheritance the first
move any model looking for more research would find is to spawn a sub-planner and
refill. An escape valve that never closes is not an escape valve; it is a bypass.
Making the valve real is what makes it safe to shut.

A third, smaller rule turns the first one from a claim about data into a claim
about time: **acts are ordered ahead of their plan siblings** within a round.
Left in emission order, a round of `[plan, plan, act]` is walked depth-first, the
first plan emits its own batch, and the act sits at the bottom of a growing
subtree for hours. The rule would hold while delivering nothing.

### What is deliberately not guarded

A round can satisfy the at-least-one-act rule with an act that is real but
unrelated to the branch it is on. There is no clean mechanical test for
relevance, and inventing speculative machinery for a failure nobody has observed
is how a harness accumulates weight it cannot justify. It is written down here
instead, to be watched for.

Triviality is also not policed. `git init` is a nearly empty diff and a perfectly
good act — it is the thing that has to exist before anything else can. A
"substantial enough" check would only teach the model to pad. Cross-model
verification already rejects acts that claim to do something and do not, which is
the right place for it and does not punish small-but-real.

## 6. Relevant API reference

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

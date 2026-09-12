# todo-loop

An autonomous to-do loop for [pi](https://pi.dev), built for a local model with
limited VRAM and a narrow context window.

One task per session. The queue lives on disk. A task only closes when a
*different* model, shown the diff and the test output but never the worker's own
account of what it did, agrees that the diff does what the task text asked.

The reasoning behind each of those choices is in [docs/design-notes.md](docs/design-notes.md).

## Install

Nothing to build. Node 22.18+ runs the TypeScript directly.

```bash
git clone <this repo> todo-loop
cd your-project
node /path/to/todo-loop/src/cli.ts init      # or: /path/to/todo-loop/bin/todo init
todo doctor                                  # check models, VRAM, git and queue shape
```

`init` writes two files into your project:

- `todo.toml` — the queue, plus the loop's own state
- `todoloop.toml` — models and thresholds

Dev dependencies (`npm install`) are only needed to run `npx tsc` and are not
required to use the loop.

## Check the setup first

`todo doctor` answers the questions that are cheaper to ask now than to discover
halfway through an overnight run: is Ollama up, is the worker pulled, can the
verifier actually be reached with the credentials on this machine, is this a git
repository, and does the queue have a runnable leaf. Add `--probe` to measure a
real verifier round trip.

## Where the verifier runs

`models.verifier` takes one of three shapes:

```toml
verifier = "opencode/qwen3.6-plus"     # hosted on OpenCode Zen (default)
verifier = "opencode-go/qwen3.8-flash" # hosted on OpenCode Go
verifier = "ollama/qwen3.5:9b"         # local, nothing leaves the machine
```

Hosted keys are read from `OPENCODE_API_KEY`, or from whatever `pi` already
stored in `~/.pi/agent/auth.json`. If `pi auth check --provider opencode` says
`ready`, there is nothing else to configure. In-session, the extension resolves
the model through pi's own registry first and only falls back to calling the
provider directly.

The choice is a genuine trade, and `todo doctor` states both sides of it.

**Local** keeps the diff on your machine, but the verifier has to share VRAM
with the worker:

```
! vram: 18.5GB needed but only 17.2GB available — every verification evicts the
  worker, so expect two model loads per task.
```

On a single GPU that is the dominant cost. A 27B worker and a 9B verifier do not
both fit in 16GB, so each verification swaps the worker out and the next task
swaps it back in. Measured here, a local verifier call that generates a hundred
tokens takes about 150 seconds, nearly all of it model load.

**Hosted** removes the contention entirely — the worker never leaves VRAM, and
the same call takes about six seconds. The price is that the task text, the
changed file list and the diff are sent to the provider on every verification,
and the call is metered. `doctor` says so out loud rather than leaving it
implicit:

```
! evidence leaves this machine: the task text, changed file list and diff go to
  OpenCode Zen on every verification, and the call is metered.
```

If neither suits, there are two cheaper local options:

- **Shrink the worker's context.** KV cache is real VRAM. Dropping the worker
  from a 52k to a 16k context variant can free enough for a small verifier to
  stay resident — and if tasks are scoped tightly enough, 16k is plenty.
- **Use the same model as its own verifier.** Cheapest and weakest. It still
  catches empty diffs and failing tests, because those are answered by tooling
  before the model is asked anything, but it will wave through work that is
  merely adjacent to the task.

## Two ways to run it

### Shell driver

One `pi` process per task, so clearing the context is process exit rather than
session bookkeeping. Failures are loud and every iteration is a clean start.

```bash
todo add api        "Build the health API"
todo add api.route  "Add GET /health returning 200" --detail "JSON body with status and uptime."
todo add api.test   "Cover /health with a test"

# or let the loop do the breaking down:
todo add auth "Rebuild the authentication system" --level epic

todo run                 # drives the whole queue
todo run --dry-run       # prints each prompt instead of calling a model
```

`--dry-run` walks the queue in memory and writes nothing — it will not mark
tasks done, and it will not commit.

`bin/todo-loop.sh` is the same loop written as fifteen lines of bash, for when
you want to see exactly what is happening.

One thing to know if you write your own driver: pi's print mode waits for EOF on
stdin before it runs the prompt. Launch it with stdin closed (`</dev/null`, or
`stdio: ["ignore", ...]`) or it will sit there with the model loaded and idle,
looking exactly like a slow model.

### In-session extension

Keeps everything inside one pi process, replacing the session between tasks.
More capable, and where all the interesting footguns live.

```bash
pi -e /path/to/todo-loop/extension/index.ts
```

```
/todo-run       start the loop
/todo-stop      stop after the current task
/todo-status    show the queue
```

Three tools reach the model: `todo_complete`, `todo_block`, and `todo_add` —
the last only while a scope or an epic is being broken down.

To load it permanently, add it to `~/.pi/agent/settings.json` or drop a symlink
in `.pi/extensions/`.

## How a task closes

1. The worker calls `todo_complete` with a one-line summary.
2. Tooling answers the mechanical questions first — the build and test commands
   from `todoloop.toml` run, and a failure short-circuits before any model call.
   An empty diff is also a hard failure.
3. The verifier model gets the task text, the changed files, the diff, and the
   command output. `todo.toml` and `todoloop.toml` are excluded from that diff —
   the loop's own bookkeeping changes on every task, and showing it to the
   verifier makes a task that touched nothing else look like it did something. It does **not** get the conversation or the worker's summary.
   It answers one narrow question — does this diff do what the task asked? — as
   `{"pass": bool, "reason": string}`.
4. On a pass: the task is archived, the work is committed, and `/todo-advance`
   replaces the session with a fresh one for the next task.
5. On a fail: the rejection lands in the worker's context *without* terminating
   the turn, so it continues where it is rather than starting cold. Three
   strikes and the task is marked `blocked` and the loop halts.

A verifier that is unreachable, or that returns something unparseable, fails
closed. Silence is never a pass.

A **breakdown** — a scope or an epic being split up — skips steps 2 and 3
entirely. It runs no build and no tests (it changed no code, so there is nothing
to build), and asks no model. See
[How a breakdown closes](#how-a-breakdown-closes).

## What the extension does to your context

| Hook | What it does | Why |
|---|---|---|
| `before_agent_start` | Pins the task into the system prompt | No amount of context surgery can then lose the one thing the worker must not forget |
| `context` | Elides old bulky tool results once past `prune_at_fraction` | A 400-line `read` squats in context for the rest of the task. Stubbing is deterministic, reversible, and the model can re-read |
| `tool_result` | Caps bash/grep output at `tool_output_max_bytes`, spilling the rest to a temp file | Pi's built-in 50KB limit is far too generous for a 27B |
| `session_before_compact` | Replaces the prose summary with fields | Prose loses exactly the details a weak model needs to resume |
| `agent_settled` | Halts if a run ended without `todo_complete` | A model that quietly gives up must never advance the queue |

Pruning is deliberately batched rather than per-turn: llama.cpp and Ollama reuse
the KV cache only across a matching prefix, so rewriting the middle of the
history forces a recompute of everything after the edit point. One large edit at
a threshold keeps the prefix stable on every other turn.

If compaction fires routinely inside a single task, the task is too coarse. The
loop notices — compaction is one of the two signals that mark a task as having
overrun its budget. See
[Keeping the bottom level atomic](#keeping-the-bottom-level-atomic).

## Writing a good queue

Order is priority order — the loop always takes the **first incomplete leaf**.
Parents are never handed to the model as work; a parent's work is its children,
and a parent rolls up to `done` on its own once every child is done.

Hierarchy comes from an explicit `parent`, or from dotted ids when `parent` is
absent (`api.route` is a child of `api`). Both work, and they mix; the explicit
field wins. Use it when your ids are not hierarchical:

```toml
[[task]]
id = "rotate-secrets"
title = "Rotate the signing secrets on boot"
parent = "harden-auth"
status = "todo"
attempts = 0
```

### Levels — task, scope, epic

`level` says how big an item is, and therefore what *working* it means:

- **`task`** (the default) — atomic and implementable as written. This is the
  only level that writes code.
- **`scope`** — not yet implementable. Working it means reading the code to find
  out what actually needs to happen, then adding the concrete tasks it breaks
  into. A scope produces queue entries, not code.
- **`epic`** — a spanning feature. Working it means adding `scope` children where
  the shape is still unclear and `task` children where the work is already clear.

**An epic spawns scopes, a scope spawns tasks, a task spawns code.** You do not
have to decompose anything up front: drop an epic in the queue and the loop
breaks it down as its first assignment.

A childless scope or epic is a *breakdown* assignment. Once it has children it is
a container — never prompted again, closed by roll-up. Levels are optional and
backwards compatible: an item with children and no `level` is a container, which
is what a parent has always been here, so existing queues need no edit.

```toml
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "epic"
status = "todo"
attempts = 0
```

### How a breakdown closes

Nothing about it is a judgement call, so no model is asked and nothing leaves the
machine. `todo_complete` on a scope or an epic checks:

- children exist — at least `decompose.min_children` of them for an **epic**;
  a **scope** may return a single task, because "it turns out to be one task" is
  a real answer to an open question
- each child's level is one the parent may spawn
- each child's title can stand on its own
- no cycles
- **the working tree is unchanged**

That last one is the same hard failure as an implementation task's empty diff,
inverted. "A scope produces todos, not code" is enforced, not requested.

### Keeping the bottom level atomic

A leaf task has to fit in one session of a model with no memory of any other
session. The breakdown prompt states that as tests the model can actually apply
rather than an adjective — name the files it touches, count them against
`atomic.max_files`, no "and" in the description, self-contained detail,
verifiable from the diff alone. If it cannot name the files, it is still a scope.

Prompting alone would not hold that line, so the loop also measures it. Two
signals mark a task as having overrun its budget:

- **compaction fired inside a single task** — the worker ran out of room in work
  that was supposed to fit in one session, which is the loudest signal available
- **the diff touched more than `atomic.max_files` files**

Overflow is never a failure by itself: the work may be perfectly correct, and
only the size is in question. What happens next is `atomic.on_overflow`:

```toml
[atomic]
max_files = 5
on_overflow = "warn"      # or "promote", or "off"
```

`warn` (the default) records it on the task, and `todo status` and `todo doctor`
surface it:

```
! tasks that ran over budget: api.route (touched 11 files (budget 5)) — these
  were not atomic. Split them, or set atomic.on_overflow = "promote" to have the
  loop break them down itself.
```

`promote` closes the loop: a task that overran its budget **and** failed
verification is turned into a scope and broken down on the next pass, instead of
spending two more attempts re-running the same oversized prompt. It only fires on
failure — oversized work that verified fine is left alone and merely flagged.

## Configuration

See `templates/todoloop.toml` for every option with its default. The ones that
matter most:

- `models.worker` — defaults to `inherit`, meaning the shell driver uses whatever
  model pi is already configured with. Prefer that: pi's `--model` flag reads a
  trailing `:suffix` as a thinking level, so an Ollama tag like
  `qwen3.8-27b:52k` cannot be passed through the flag at all. The in-session
  extension always uses the active session model and ignores this setting.
- `models.verifier` — keep it different from the worker. A model judging its own
  output is the weakest version of this check, and the verify call is short
  enough that a small model is fine. Defaults to `opencode/qwen3.6-plus`; see
  [Where the verifier runs](#where-the-verifier-runs) for the local option and
  what each choice costs.
- `verify.test_command` / `verify.build_command` — the more tooling answers, the
  less the verifier has to.
- `verify.max_attempts` — the cap that stops a slightly-too-strict verifier from
  becoming an unbounded token burn.
- `loop.checkpoint` — `commit` (default), `require-clean`, or `off`.
- `loop.on_silent_stop` — `halt` (default) or `retry`.
- `decompose.min_children` — smallest breakdown accepted **from an epic**,
  default 2. Scopes are exempt; see
  [How a breakdown closes](#how-a-breakdown-closes).
- `atomic.max_files` / `atomic.on_overflow` — the bottom-level size budget and
  what to do when a task blows through it. See
  [Keeping the bottom level atomic](#keeping-the-bottom-level-atomic).

## Commands

```
todo init                      Write todoloop.toml and todo.toml starters
todo doctor [--probe]          Check models, VRAM, git and queue shape
todo status                    Show the queue
todo stop                      Stop a running loop after the current task
todo next [--id]               Print the next task's prompt (exit 3 when empty)
todo start                     Claim the next task and print its prompt
todo add <id> <title...>       Append a task (--detail "...", --parent <id>)
todo done <id> [summary...]    Mark done without verifying
todo block <id> <reason...>    Mark blocked
todo reset <id>                Return a task to todo and clear attempts
todo verify [id]               Gather evidence and print the verdict as JSON
todo complete <id> [summary]   Verify, then mark done or record the failure
todo checkpoint [message...]   Commit everything in the working tree
todo run [--max N] [--dry-run] Drive the queue with one pi process per task
```

Exit codes: `0` success, `1` error or halt, `3` queue empty, `4` verification
rejected.

## Tests

```bash
node --test test/      # 135 tests, no model required
npx tsc                # type-checks src, extension and tests
```

The suite covers the TOML round-trip, leaf selection and roll-up, prompt
rendering, git evidence collection against a real temporary repository, the
verdict parser against the shapes local models actually emit, queue-shape
auditing, provider resolution and credential lookup against a stub endpoint,
levels and the breakdown gate, and the CLI end to end in `--dry-run`.

There is also a live check that needs a running model:

```bash
node scripts/live-extension-check.ts        # add --keep to inspect the workspace
```

It drives the extension inside a real pi session over RPC with a mixed queue — a
plain task and a scope — which exercises the part the fakes cannot: that
`newSession` works from a command, that the `/todo-advance` a tool queues is
actually dispatched, and that the tools reach the model at all. It reports any
`extension_error` pi emits.

The scope is there for a second reason. A fake API will accept a breakdown no
real model would produce, so the check prints the children the model invents,
with their details, for you to read. **Whether a small model decomposes *well* is
not something the mechanical gate can answer** — it catches empty breakdowns,
code in a breakdown and illegal levels, but a well-formed and useless breakdown
passes. That is the same class of failure the model verifier exists to catch on
the implementation side, and it is the one assumption in the level design that is
still unvalidated. Read the output before trusting a long queue of epics to it.

The extension is driven against a fake pi API, so the wiring that only exists at
runtime is covered too: which hook fires when, that a rejection resumes the
worker instead of ending the turn, that three rejections block the task, that a
run ending without `todo_complete` halts rather than advancing, and that the
pruning, truncation and compaction hooks stay out of the way when the loop is
not running.

Separately, the verifier has been exercised against live models — `qwen3.5:9b`
on Ollama and `qwen3.6-plus` on OpenCode Zen. Given a diff that adds the
requested `/health` route both return `pass`; given a diff that adds a
`/version` route instead — plausible work that is not the task — both return
`fail` and name the gap. That is the discrimination the whole design rests on,
so it is worth re-running on your own models before trusting a long queue to it.

The round trip differs by two orders of magnitude. The hosted verifier answers
in about 3 seconds; the local one takes about 150, almost all of it evicting and
reloading the worker.

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
halfway through an overnight run: is Ollama up, are both models pulled, is this
a git repository, and does the queue have a runnable leaf. Add `--probe` to
measure a real verifier round trip.

The check worth reading carefully is VRAM:

```
! vram: 18.5GB needed but only 17.2GB available — every verification evicts the
  worker, so expect two model loads per task.
```

On a single GPU this is the dominant cost. A 27B worker and a 9B verifier do not
both fit in 16GB, so each verification swaps the worker out and the next task
swaps it back in. Measured here, a verifier call that generates a hundred tokens
takes about 150 seconds, nearly all of it model load.

That is a real trade, not a bug. Independent judgement costs two model loads per
task. Your options, in order of how much they give up:

1. **Accept it.** Verification is per task, not per turn. Two minutes on a task
   that took twenty is noise, and this is the only option that keeps the
   verifier genuinely independent.
2. **Shrink the worker's context.** KV cache is real VRAM. Dropping the worker
   from a 52k to a 16k context variant can free enough for a small verifier to
   stay resident — and if tasks are scoped tightly enough, 16k is plenty.
3. **Use the same model as its own verifier.** Cheapest and weakest. It still
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

todo run                 # drives the whole queue
todo run --dry-run       # prints each prompt instead of calling a model
```

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

If compaction fires routinely inside a single task, the task is too coarse.
Split it before reaching for compression.

## Writing a good queue

Order is priority order — the loop always takes the **first incomplete leaf**.
Dotted ids imply hierarchy, so `api.route` is a child of `api`. Parents are
never handed to the model; a parent's work is its children, and prompting with
an interior node is how a bounded task becomes a forty-turn run. A parent rolls
up to `done` on its own once every child is done.

```toml
[[task]]
id = "api.route"
title = "Add GET /health returning 200"
status = "todo"
attempts = 0
detail = """
Return a JSON body with `status` and `uptime`. Register it on the existing
router in server.ts. No new dependencies.
"""
```

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
  enough that a smaller model is fine. Check `todo doctor` for the VRAM trade
  before choosing.
- `verify.test_command` / `verify.build_command` — the more tooling answers, the
  less the verifier has to.
- `verify.max_attempts` — the cap that stops a slightly-too-strict verifier from
  becoming an unbounded token burn.
- `loop.checkpoint` — `commit` (default), `require-clean`, or `off`.
- `loop.on_silent_stop` — `halt` (default) or `retry`.

## Commands

```
todo init                      Write todoloop.toml and todo.toml starters
todo doctor [--probe]          Check models, VRAM, git and queue shape
todo status                    Show the queue
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
node --test test/      # 75 tests, no model required
npx tsc                # type-checks src, extension and tests
```

The suite covers the TOML round-trip, leaf selection and roll-up, prompt
rendering, git evidence collection against a real temporary repository, the
verdict parser against the shapes local models actually emit, queue-shape
auditing, and the CLI end to end in `--dry-run`.

The extension is driven against a fake pi API, so the wiring that only exists at
runtime is covered too: which hook fires when, that a rejection resumes the
worker instead of ending the turn, that three rejections block the task, that a
run ending without `todo_complete` halts rather than advancing, and that the
pruning, truncation and compaction hooks stay out of the way when the loop is
not running.

Separately, the verifier has been exercised against a live local model
(`qwen3.5:9b` on Ollama). Given a diff that adds the requested `/health` route
it returns `pass`; given a diff that adds a `/version` route instead — plausible
work that is not the task — it returns `fail` and names the gap. That is the
discrimination the whole design rests on, so it is worth re-running on your own
models before trusting a long queue to it.

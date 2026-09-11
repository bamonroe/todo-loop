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
```

`init` writes two files into your project:

- `todo.toml` — the queue, plus the loop's own state
- `todoloop.toml` — models and thresholds

Dev dependencies (`npm install`) are only needed to run `npx tsc` and are not
required to use the loop.

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
   command output. It does **not** get the conversation or the worker's summary.
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

- `models.verifier` — keep it different from the worker. A model judging its own
  output is the weakest version of this check, and the verify call is short
  enough that a smaller model is fine.
- `verify.test_command` / `verify.build_command` — the more tooling answers, the
  less the verifier has to.
- `verify.max_attempts` — the cap that stops a slightly-too-strict verifier from
  becoming an unbounded token burn.
- `loop.checkpoint` — `commit` (default), `require-clean`, or `off`.
- `loop.on_silent_stop` — `halt` (default) or `retry`.

## Commands

```
todo init                      Write todoloop.toml and todo.toml starters
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
node --test test/      # 48 tests, no model required
npx tsc                # type-checks src, extension and tests
```

The suite covers the TOML round-trip, leaf selection and roll-up, prompt
rendering, git evidence collection against a real temporary repository, the
verdict parser against the shapes local models actually emit, and the CLI end to
end in `--dry-run`.

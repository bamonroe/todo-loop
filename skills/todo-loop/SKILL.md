---
name: todo-loop
description: Set up and run the todo-loop autonomous task queue in a project — write todoloop.toml and todo.toml, choose build and test commands that gate verification, author a queue of acts and plans, and drive the loop. Use when asked to set up todo-loop, initialise a todo queue, add work to one, choose a build_command for it, or start an autonomous loop with /todo-run or `todo run`.
compatibility: Needs the todo-loop package installed and the `todo` CLI on PATH. Node 22.18+, a git repository, and a reachable verifier model.
---

# todo-loop

An autonomous task queue. One task per session. A task closes only when a
*different* model — shown the diff and the test output, never the worker's own
account of what it did — agrees the diff does what the task text asked.

The reasoning behind every choice here is in the package's `README.md` and
`docs/design-notes.md`. Read those before changing the design; this file is the
operating manual.

## Setting a project up

Run from the project root, which must be a git repository.

```bash
todo init      # writes todo.toml (the queue) and todoloop.toml (models, thresholds)
todo doctor    # checks both models are reachable, plus git and the queue shape
```

### Choosing the build and test commands

This is the most important step, and the one most often skipped.

```toml
[verify]
build_command = "npx tsc --noEmit"
test_command  = "node --test test/"
```

Work them out by reading `package.json`, `Cargo.toml`, `Makefile`, or the CI
config. Then apply both checks below. `todo doctor` warns when neither is set.

**Why it matters.** These run before the verifier sees anything, and a non-zero
exit short-circuits the model call entirely. The verifier judges *intent* — it
is explicitly told not to review code quality — so it will pass code that does
not run. In a real run with both commands empty, it passed a module that crashed
on startup: the file imported `"./config"` in a project that imports
`"./config.ts"` everywhere. One build command turns that into a hard mechanical
failure. Tooling should answer the mechanical questions; leave the verifier only
the judgment call.

**Check 1 — the gate must bite.** A command that always exits 0 is worse than
none, because it looks like coverage. `npm test` with no tests, `tsc` with no
`tsconfig.json`, a runner whose glob matches nothing — all exit 0. Introduce a
syntax error in a source file on purpose, confirm the command exits non-zero,
then undo it. A gate nobody has watched fire is a gate nobody knows works.

**Check 2 — prohibition, not completeness.** `build_command` is **global**: it
runs after every task. Tasks are **local**: each touches a slice of the work.

- Prohibitions compose. *"It compiles"*, *"tests pass"*, *"nothing is broken"* —
  any subset of the finished work satisfies them.
- Completeness checks do not. *"All four files exist"*, *"every endpoint is
  implemented"* — the first task cannot pass without doing all the others,
  which blows its scope and defeats the whole arrangement.

This failure is silent: the queue still runs, each act just quietly grows to
the size of the whole project. Phrase every check as *this did not break anything*,
never *the project is finished*.

## Writing the queue

Order is priority order — the loop always takes the first incomplete leaf.
Parents are never handed to the model; a parent's work is its children, and it
rolls up to `done` on its own once every child is done.

```bash
todo add api.route "Add GET /health returning 200" \
  --detail "Edit src/router.ts only. JSON body with status and uptime fields."

todo add auth "Rebuild the authentication system" --level plan
```

Hierarchy comes from `--parent`, or from dotted ids when it is absent
(`api.route` sits under `api`).

### Levels

A level says what a session *does*, not how big the work is.

- **`act`** (the default) — one session, one diff, one verdict. The only level
  that writes. Its `--kind` says what it produces:
  - `code` (the default) — writes or changes code.
  - `docs` — writes or changes documentation.
  - `research` — finds something out and appends it to `plan.memory_file`.
- **`plan`** — decides what the next few steps are and writes them to the queue.
  Touches no files; a non-empty diff rejects the round.

A plan may spawn either kind, so nesting is unbounded. Drop a single plan in and
the loop grows the rest of the queue itself.

### Plans are re-entrant

A plan is **not** finished by having children. Every time its whole batch is
done it comes back for another round, and is handed the last few things that
landed so it decides the next step against a repository that now contains them.
It closes only when a round adds nothing — a planner saying there is no next
step.

This is the point of the design. A plan is only ever asked *"what are the next
few things?"*, never *"design this project"*, so it never spends a session
guessing at code that does not exist yet.

Two rules keep it honest, both enforced mechanically:

- **Every round must land at least one act.** A round of nothing but plans is
  rejected. Planning that spawns more planning always feels productive and never
  risks a failing build.
- **Research is allowanced.** A `research` act satisfies that rule, but only
  `plan.research_budget` times per branch (default 2) — and the remaining
  allowance is *inherited* by child plans rather than reset, so a planner cannot
  refill it by spawning a sub-planner to keep reading.

`plan.max_children` (default 5) caps a round, and `plan.max_depth` (default 8) is
a backstop against a branch that only ever plans.

### What makes an act atomic

An act must be finishable by one worker in one session with no memory of any
other session. Apply these as tests, not as adjectives:

- It names the files it touches. **If you cannot name them, it is not an act
  yet — make it a plan.**
- It stays within `atomic.max_files` (default 5).
- Its description has no "and" in it.
- It is verifiable from the diff alone.

`--detail` is the only context that item will ever have. Put everything it needs
there — the file paths, the exact signature, the names of things that already
exist. Being specific here is what makes small models work.

## Running it

**In-session**, when already inside pi:

```
/todo-run        start the loop
/todo-status     show the queue
/todo-stop       stop after the current task finishes
```

`/todo-run` **takes over the session**. Each verified task replaces the
conversation with a fresh one, because the whole point is that the worker never
carries stale context between tasks. Never start a loop in a session being used
for something else.

In-session, the worker is **whatever model the session is on**. `models.worker`
in `todoloop.toml` is only read by the shell driver — the extension cannot set a
model on a session it is in the middle of replacing. `/todo-run` warns when the
two disagree, but it does not switch: use `/model` first if you meant to.

**Shell driver**, one process per task:

```bash
todo run --dry-run     # prints every prompt, calls no model, writes nothing
todo run               # the real thing
todo run --max 3
todo run --model ollama/qwen3.8-27b   # override models.worker for this run
```

The dry run names the model each task would go to, so a wrong `models.worker` is
something you read rather than something you pay for.

Start a new queue with `--dry-run`. It walks the queue in memory and will not
mark tasks done or commit.

Only the extension can detect compaction firing inside a task, which is one of
the two signals that a task was not atomic. The shell driver has no such signal.

## How a task closes

1. The worker calls `todo_complete`.
2. The build and test commands run. Failure, or an empty diff, is a hard failure
   before any model is called.
3. The verifier sees the task text, the changed files, and the diff — not the
   conversation, and not the worker's summary. It answers pass or fail.
4. Pass: archived, committed, fresh session for the next task.
5. Fail: the rejection lands in the worker's context without ending the turn, so
   it continues rather than starting cold. Three strikes blocks the task and
   halts the loop.

An unreachable or unparseable verifier fails closed. Silence is never a pass.

A **planning round** skips all of that. It runs no build and asks no model. It
is checked mechanically: the round is within the cap, it lands at least one act,
research is within allowance, titles stand alone, no cycles, and **the working
tree is unchanged**. That last one is the empty-diff rule inverted: a plan
produces queue entries, not code, and this is enforced rather than requested.

## Diagnosing a stuck queue

- `todo status` — the tree, plus any task flagged as having overrun its budget.
- `todo doctor` — the same warnings plus the environment.
- `todo reset <id>` — returns a blocked task to `todo` and clears its attempts.

A task blocked after three rejections usually means the task text was ambiguous,
not that the model is incapable. Read the recorded failure, rewrite the
`--detail` to be specific, then reset it.

An act flagged as over budget was not atomic. Split it, or set
`atomic.on_overflow = "promote"` to have the loop turn a failed oversized act
into a plan and decide its next steps itself.

## Things worth knowing

- Keep the verifier a *different* model from the worker. A model judging its own
  output is the weakest form of this check.
- `todo.toml` and `todoloop.toml` are excluded from the diff the verifier sees,
  so the loop's own bookkeeping cannot make an empty task look productive.
- A well-formed but useless round passes the mechanical gate. Whether a small
  model plans *well* is not something tooling can answer — read the first few
  rounds it produces before leaving it alone with a project.
- Nothing stops a round from satisfying the at-least-one-act rule with an act
  that is real but unrelated to the branch it is on. There is no clean
  mechanical guard for that; watch for it rather than assuming it cannot happen.

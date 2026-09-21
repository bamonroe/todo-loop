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

**If your project already keeps a backlog, skip `init` for the queue** — point
the loop at the real one instead. See
[Working an existing queue](#working-an-existing-queue).

## Working an existing queue

The loop is only worth running on the backlog you actually keep, so it reads
whichever of two schemas it finds rather than insisting on its own. With no
`--file`, an existing `TODO.toml` or `todo.toml` in the working directory is
adopted; `todo status` names the file, the schema and the state file it settled
on, so a queue is never silently the wrong one.

|                        | native                     | project                                        |
|------------------------|----------------------------|------------------------------------------------|
| prose field            | `detail`                   | `description`                                  |
| statuses               | `todo doing done blocked`  | `active in-progress blocked`, `finished`       |
| priority               | position in the file       | `urgency`, then `order`                        |
| finished work          | stays, marked `done`       | moves to the archive named in `[meta]`         |
| the loop's bookkeeping | on the task                | a sidecar beside the queue                     |

The project schema is recognised by its own markers — a `schema_version`, a
`[meta]` table, or a task carrying `description`/`urgency`/`order`/`category`.

Three rules govern every write to a queue in that shape, because the project's
own CLI owns the file and the two have to be able to hand it back and forth:

1. **Nothing is dropped.** Every field the loop has no opinion about — category,
   tags, created, your own per-task flags — is carried through verbatim, in its
   original position, and `created = 2026-09-12` stays a date rather than
   becoming a string in quotes. A full load and save of a queue and its archive
   is byte-for-byte identical.
2. **Nothing foreign is added.** Attempt counts, timings, verdicts and loop
   state go to `<queue>.todoloop-state.toml` beside the queue. A project CLI
   that rewrites its file from a fixed field list would drop them, so they never
   go in it; claiming a task changes exactly one line of your queue, from
   `active` to `in-progress`. Delete the state file to forget every attempt
   count — nothing about the work itself is in there. Gitignore it if you would
   rather it did not travel with the repo.
3. **New rows look like old ones.** An item the loop adds during a round gets
   the same metadata every other row carries, including an `order` ten past the
   highest in use.

The archive is read as well as written. A plan whose children have
since shipped its children would otherwise look untouched, and the loop would
break it down a second time into duplicate children.

`blocked_by` on a task, where the schema has it, is honoured: a leaf whose
blockers have not shipped is skipped rather than handed out. See
[Work the loop should not start yet](#work-the-loop-should-not-start-yet).

`todo status` hides archived work; `todo status --all` includes it.

## Work the loop should not start yet

A task can be well written, correctly implemented and fully tested, and still be
worthless — because the state it addresses cannot be reached until some other
task ships. Verification will not catch it. The verifier is asked whether the
diff does what the task said, and it does; nobody is asked whether the task was
worth doing yet. Unattended, that is a whole night spent building something
correct for a program state that does not exist.

So a task may declare `blocked_by`, a list of ids that must be `done` first:

```toml
[[task]]
id = "colour-when-fully-constrained"
title = "Colour the sketch when it has no freedom left"
blocked_by = ["lock-a-point"]
```

- **A blocked leaf is skipped, not queued behind.** The loop moves to the next
  runnable task, so declaring a dependency reorders work rather than stopping
  it. Urgency does not override a gate: something that cannot be started is not
  more startable for being important.
- **A blocker that is not in the queue counts as unmet.** Treating an unknown id
  as "nothing in the way" turns one typo into a silently disabled guard.
  `todo doctor` fails on it by name, because that task can never become ready.
- **Nothing runnable is reported as two different things.** A queue with work
  left that is only waiting on dependencies is *stuck*, and `todo status` and
  `todo doctor` both say so rather than letting it read as finished.

The loop never creates a dependency — it only refuses to ignore one. A schema
without the field simply never has any.

## Check the setup first

`todo doctor` answers the questions that are cheaper to ask now than to discover
halfway through an overnight run: is each model reachable — pulled, if it runs on
Ollama, or backed by credentials pi holds, if it is hosted — is this a git
repository, and does the queue have a runnable leaf. Checks that only apply to a
local model are skipped for a hosted one, so a fully hosted pair does not report
a missing Ollama it never wanted. Add `--probe` to measure a real verifier round
trip.

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
  stay resident — and if acts are kept tight enough, 16k is plenty.
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
todo add auth "Rebuild the authentication system" --level plan

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
the last only while a plan is being worked.

To load it permanently, add it to `~/.pi/agent/settings.json` or drop a symlink
in `.pi/extensions/`.

## How a task closes

1. The worker calls `todo_complete` with a one-line summary.
2. Tooling answers the mechanical questions first — the build and test commands
   from `todoloop.toml` run, and a failure short-circuits before any model call.
   An empty diff is also a hard failure. They are skipped, and reported as
   skipped, when every file in the diff is documentation: a task that edited
   only NOTES.md can neither break a build nor fix one, and failing it for a
   build that was already broken — or that has no project to run against yet —
   rejects work that was correct.
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

Rejections accumulate. A retry is shown **every** verdict the task has collected
so far, oldest first, not just the most recent one — a worker told only why the
last attempt failed has no way of knowing the one before it was rejected for the
opposite reason, and oscillating between two wrong answers is the characteristic
failure of a retry loop with no memory. `todo reset <id>` clears the history
along with the attempt count.

A verifier that is unreachable, or that returns something unparseable, fails
closed. Silence is never a pass.

A **planning round** skips steps 2 and 3
entirely. It runs no build and no tests (it changed no code, so there is nothing
to build), and asks no model. See
[How a planning round closes](#how-a-planning-round-closes).

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

(A queue in the [project schema](#working-an-existing-queue) states its priority
in fields instead, and states it flat, so the tree is rebuilt and walked
depth-first with siblings ranked by `urgency` then `order` — same rule, read from
a different place. Everything below applies to both.)

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

### Levels — act and plan

`level` says what a session *does*, not how big the work is:

- **`act`** (the default) — one session, one diff, one verdict. The only level
  that writes. `kind` says what it produces: `code` (the default), `docs`, or
  `research` — which finds something out and appends it to `plan.memory_file`.
- **`plan`** — decides what the next few steps are and writes them to the queue.
  It touches no files; a non-empty diff rejects the round.

A plan may spawn either kind, so nesting is unbounded. You do not have to break
anything down up front: drop a single plan in the queue and the loop grows the
rest itself.

This replaced a fixed ladder — epic spawns scopes, scope spawns tasks — where
`level` encoded depth. That shape forced the first session to scope an entire
project before any of it existed. Across three real runs the model spent roughly
82% of its output tokens on that one up-front design, and never once used the
deferral level it was given. Old queues still load: `epic` and `scope` both read
as `plan`, `task` reads as `act`, and a file that spells it the old way is
written back out in its own words.

```toml
[[task]]
id = "auth"
title = "Rebuild authentication"
level = "plan"
status = "todo"
attempts = 0
```

### Plans are re-entrant

A plan is **not** finished by having children. Every time its whole batch is
done it becomes startable again, and the prompt hands it the last few things
that landed. It closes only when a round adds nothing — a planner saying there
is no next step. Roll-up deliberately refuses to close one on its children's
behalf, which would end the branch at round one.

So a plan is only ever asked *"what are the next few things?"*, never *"design
this project"*. It never spends a session guessing at code that does not exist
yet, because the code it needs to see is on disk by the time it is asked.

Termination stops coming from a depth cap and starts coming from planners
running out of next steps. `plan.max_depth` (default 8) remains only as a
backstop against a branch that plans forever without building.

### How a planning round closes

Nothing about it is a judgement call, so no model is asked and nothing leaves the
machine. `todo_complete` on a plan checks:

- the round is within `plan.max_children` (default 5) — it is "what is next",
  not the whole project
- it lands **at least one act**. A round of nothing but plans is rejected:
  planning that spawns more planning always feels productive and never risks a
  failing build, so it is a gate rather than a request
- research is within allowance. A `research` act satisfies the rule above, but
  only `plan.research_budget` times per branch (default 2), and the remaining
  allowance is **inherited** by child plans rather than reset — otherwise a
  planner refills it by spawning a sub-planner to keep reading
- each child's title can stand on its own, and no cycles
- **the working tree is unchanged**

That last one is the same hard failure as an act's empty diff, inverted. "A plan
produces queue entries, not code" is enforced, not requested.

**Looking is budgeted too, in the session rather than at the gate.** A round is
told to look at the repository before deciding, and that instruction on its own
has no stopping condition in it — the first run under this design spent its
entire window on thirteen exploratory calls and added nothing. After
`plan.look_budget` inspection calls (default 6) every further tool result comes
back carrying the exit: *anything you still do not know is a research act; write
it down and move on*. The todo tools are never counted, and acts are not metered
at all — an act is supposed to read the repository. The point is not to forbid
the next call but to give the unanswered question somewhere to go, where it
becomes budgeted, verifiable and readable by every round after it.

An empty round is legal *only* once the branch has delivered something; on the
first round it would close a project having built nothing.

Acts are inserted ahead of their plan siblings within a round. Without that the
at-least-one-act rule holds as a property of the data while delivering nothing:
depth-first through `[plan, plan, act]` leaves the act at the bottom of a subtree
for hours. Ordering it first is what makes the rule a heartbeat.

### Keeping acts atomic

An act has to fit in one session of a model with no memory of any other session.
The planning prompt states that as tests the model can actually apply rather than
an adjective — name the files it touches, count them against `atomic.max_files`,
no "and" in the description, self-contained detail, verifiable from the diff
alone. If it cannot name the files, it is still a plan.

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

`promote` closes the loop: an act that overran its budget **and** failed
verification is turned into a plan and re-decided on the next pass, instead of
spending two more attempts re-running the same oversized prompt. It only fires on
failure — oversized work that verified fine is left alone and merely flagged.

## Configuration

See `templates/todoloop.toml` for every option with its default. The ones that
matter most:

- `models.worker` — the shell driver's model, as `provider/model`. Defaults to
  `openai-codex/gpt-5.6-terra`, which needs a ChatGPT Plus or Pro subscription
  logged in through pi's `/login`; `todo doctor` fails loudly if pi holds no
  credentials for the provider. `todo --provider <name>` and `todo --model <id>`
  override it for a single run — either alone is enough, and a `--model` that
  carries its own `provider/` prefix decides both halves. Set it to `inherit` to
  use whatever pi is already configured with, which is the right answer for a
  local worker: pi's `--model` flag reads a trailing `:suffix` as a thinking
  level, so an Ollama tag like `qwen3.8-27b:52k` cannot be passed through the
  flag at all. The in-session extension still uses the active session model —
  it cannot set the model on a session it is in the middle of replacing — but
  `/todo-run` now says so when the two disagree, rather than running the queue
  on a model the config claims it is not using.
- `models.verifier` — keep it different from the worker. A model judging its own
  output is the weakest version of this check, and the verify call is short
  enough that a small model is fine. Defaults to `opencode/qwen3.6-plus`; see
  [Where the verifier runs](#where-the-verifier-runs) for the local option and
  what each choice costs.
- `verify.test_command` / `verify.build_command` — the more tooling answers, the
  less the verifier has to. **Set at least one.** With both empty, a real run
  here passed code that would not start: the module imported `"./config"` in a
  project that imports `"./config.ts"` everywhere, and the verifier — which is
  told to judge intent, not resolve modules — passed it. One `build_command`
  turns that into a hard failure that short-circuits before the verifier is even
  called. `todo doctor` warns when neither is set.
- `verify.max_attempts` — the cap that stops a slightly-too-strict verifier from
  becoming an unbounded token burn.
- `loop.checkpoint` — a ladder of strictness, each rung doing what the one below
  it does: `off` ignores git, `commit` auto-commits each verified task, and
  `require-clean` (default) commits *and* refuses to start a task while the tree
  is dirty. That is the default because the commit is `git add -A`: anything
  already uncommitted when the loop starts is swept into a commit named after a
  task that did not do it, and the diff the verifier judges is wrong by the same
  amount. Refusing to start costs one `git stash`.
- `loop.on_silent_stop` — `halt` (default) or `retry`.
- `plan.max_children` / `plan.research_budget` / `plan.look_budget` /
  `plan.max_depth` / `plan.memory_file` — the size of a round, how many rounds a
  branch may close with research alone, how many inspection calls a round may
  spend before the harness tells it to stop looking (default 6; `0` disables),
  the nesting backstop, and where research acts write what they find. See
  [How a planning round closes](#how-a-planning-round-closes).
- `loop.plan_timeout_ms` — wall-clock cap on a planning round specifically
  (`decompose_timeout_ms` is still read). A round that runs out of clock is
  judged on **what it landed**, not on the clock: its items go through the
  ordinary check, and if they pass they are kept and the plan comes back for
  the rest. Only a cut-off round that wrote nothing, or wrote something the
  check rejects, loses its half-batch. A timeout can never close a plan — an
  empty round means "no next step" when the planner says it, and means the
  stopwatch when the clock does.
- `verify.worker_check` — how the *worker* is told to check its own work.
  `build_command` and `test_command` are how the verifier checks the worker;
  pasting them into the worker's prompt conflates the two, and where the
  project has tools it is worse than that — the worker gets a shell command
  competing with a tool that does the same job better, and raw command output
  costs more context than the retry it saves. Set this to name the tools. Left
  empty, the commands are named instead, which is all a project without
  tooling has to go on. Either way the rule is the same and is the part that
  matters: you cannot compile in your head, and do not finish on a failing
  build.
- `atomic.max_files` / `atomic.on_overflow` — the bottom-level size budget and
  what to do when a task blows through it. See
  [Keeping the bottom level atomic](#keeping-the-bottom-level-atomic).

## Commands

```
todo init                      Write todoloop.toml and todo.toml starters
todo doctor [--probe]          Check models, VRAM, git and queue shape
todo status [--all]            Show the queue (--all includes archived work)
todo stop                      Stop a running loop after the current task
todo next [--id]               Print the next task's prompt (exit 3 when empty)
todo start                     Claim the next task and print its prompt
todo add <id> <title...>       Append an item (--detail "...", --parent <id>, --level act|plan,
                              --kind code|docs|research,
                               --category <c>, --urgency <u> where the schema has them)
todo done <id> [summary...]    Mark done without verifying
todo block <id> <reason...>    Mark blocked
todo reset <id>                Return a task to todo and clear attempts
todo verify [id]               Gather evidence and print the verdict as JSON
todo complete <id> [summary]   Verify, then mark done or record the failure
todo checkpoint [message...]   Commit everything in the working tree
todo run [--max N] [--dry-run] Drive the queue with one pi process per task

Shared flags: --cwd <dir> --file <todo.toml> --config <todoloop.toml>
              --provider <name> --model <id>   override the configured worker
```

With no `--file`, an existing `TODO.toml` or `todo.toml` in `--cwd` is adopted
and its schema read from the file — see
[Working an existing queue](#working-an-existing-queue).

Exit codes: `0` success, `1` error or halt, `3` queue empty, `4` verification
rejected.

## Tests

```bash
node --test test/      # 150 tests, no model required
npx tsc                # type-checks src, extension and tests
```

The suite covers the TOML round-trip, leaf selection and roll-up, prompt
rendering, git evidence collection against a real temporary repository, the
verdict parser against the shapes local models actually emit, queue-shape
auditing, provider resolution and credential lookup against a stub endpoint,
levels and the planning gate, and the CLI end to end in `--dry-run`.

There is also a live check that needs a running model:

```bash
node scripts/live-extension-check.ts        # add --keep to inspect the workspace
```

It drives the extension inside a real pi session over RPC with a mixed queue — a
plain act and a plan — which exercises the part the fakes cannot: that
`newSession` works from a command, that the `/todo-advance` a tool queues is
actually dispatched, and that the tools reach the model at all. It reports any
`extension_error` pi emits.

The plan is there for a second reason. A fake API will accept a round no
real model would produce, so the check prints the children the model invents,
with their details, for you to read. **Whether a small model decomposes *well* is
not something the mechanical gate can answer** — it catches empty rounds,
code in a breakdown and illegal levels, but a well-formed and useless breakdown
passes. That is the same class of failure the model verifier exists to catch on
the implementation side, and it is the one assumption in the level design that is
still unvalidated. Read the output before leaving it alone with a project.

The extension is driven against a fake pi API, so the wiring that only exists at
runtime is covered too: which hook fires when, that a rejection resumes the
worker instead of ending the turn, that three rejections block the task, that a
run ending without `todo_complete` halts rather than advancing, and that the
pruning, truncation and compaction hooks stay out of the way when the loop is
not running.

The level design has been exercised end to end against live models too: a 27B
(`qwen3.8-27b`, IQ3_XXS) broke a "add rate limiting to the HTTP API" epic into
two ordered tasks — a limiter module plus config, then the router wiring — both
naming their files, both inside the file budget, and both verified first time by
`qwen3.6-plus`. The breakdown quoted a helper that already existed in the file it
was going to edit, which is only knowable by having read it, so "investigate
first" does real work. See [docs/design-notes.md](docs/design-notes.md) for the
full run, including what it revealed about running without a `build_command`.

Separately, the verifier has been exercised against live models — `qwen3.5:9b`
on Ollama and `qwen3.6-plus` on OpenCode Zen. Given a diff that adds the
requested `/health` route both return `pass`; given a diff that adds a
`/version` route instead — plausible work that is not the task — both return
`fail` and name the gap. That is the discrimination the whole design rests on,
so it is worth re-running on your own models before trusting a long queue to it.

The round trip differs by two orders of magnitude. The hosted verifier answers
in about 3 seconds; the local one takes about 150, almost all of it evicting and
reloading the worker.

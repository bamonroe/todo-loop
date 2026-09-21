# todo-loop harness findings

What running the loop against a real project has taught us about the harness
around it. The project under test is an Android graphic equalizer at
`/data/equalizer`, built by `qwen3.8-27b` locally with `qwen3.5-plus` verifying.

Every finding here came from running the thing. None came from reading the code
— in each case the code looked correct.

---

## 1. Deliberation, not looking, is the bottleneck

Run 7 spent its entire ten-minute planning window on three thinking blocks
totalling 29,746 characters, and landed one item at 8:55. All three derived the
same five-item plan from scratch. Nothing on disk changed between them. Two
questions were re-litigated in every block, and one of them flip-flopped.

The look budget — six inspection commands — was not the constraint. The planner
used three of them.

At 10-12 tokens/second, thinking is the most expensive thing a session can
spend and the first thing lost when it ends early.

**There is no "think less" lever.** Tested empirically, one prompt per level
against the local model: `--thinking off` produced 0 thinking characters, `low`
produced 623, `max` produced 719. pi maps the graded levels to
`reasoning_effort`, which ollama ignores. Only the on/off toggle reaches the
model. So prompt wording is the only control we have.

## 2. Telling it what it may skip beats telling it what to prefer

`dda1275` rewrote the plan prompt. The old text already said to prefer plans and
to keep deliberation short, and run 7 quoted that rule back to itself and argued
past it.

What changed things was removing a demand rather than adding an instruction:

> Put what the worker will need in `detail` — it is the only context that item
> will ever have. **But write it in one pass.** If you cannot fill it in without
> working the design out first, that is a `plan`, not an act you deliberate into
> shape.

Requiring a perfect `detail` on every item is what made each item worth agonising
over. Run 8, same cap and same baseline: 13,638 thinking characters, five items,
first write at 2:49, and plan children appeared for the first time at scale.

## 3. Prompt text is not free

`17c047f` added the unattended-run block to both prompts. Planning thinking went
from 13,638 (run 8) to 19,625 (run 10) for the same five items — about 40% more
deliberation for identical output.

This model reads everything it is given and thinks about all of it. Each block
added to a prompt has a running cost paid every session, and that cost is
invisible until you measure two runs against each other.

Open question: the unattended block may belong only in the act prompt, where the
impossible-requirement case actually arises. The planning round has nothing to
substitute.

## 4. The act prompt is cheap; acts are expensive for other reasons

Run 10's scaffold act: 1,333 thinking characters, four and a half minutes, seven
tool calls, verified first time. The act prompt is not the problem.

Run 10's persistence act took nineteen minutes. The breakdown matters more than
the total:

| span | what |
|---|---|
| ~1.5 min | four `bash` calls hunting the host filesystem for an `org.json` jar |
| ~5.5 min | one unbroken think, no tool calls |
| ~6 min | writing three files |
| ~6 min | five `android_test` runs, editing between each |

Three files is inside the five-file atomicity budget, and the act finished and
verified. **This was not an atomicity failure.**

## 5. The planner sets traps for the worker

The persistence item's `detail` said to use `org.json` "built into Android; do
NOT add kotlinx". True on a device. But `org.json` is stubbed on the JVM, so
unit tests need an explicit `testImplementation` — and the version the worker
first reached for did not resolve from Maven Central.

So the worker spent a third of its session discovering and fixing a constraint
the planner invented, in a `detail` written by a session that could not test it.

This is the structural cost of `detail` being the only context an item ever gets.
A plan is asserting facts it has not verified, one round before anyone can check.

**Mitigation, and two thirds of this was anticipatable:**

- The JVM/`org.json` stub is a well-known Android gotcha, not a discovery.
- The unresolvable version is precisely what `src/versions.ts` in pi-android
  exists to prevent. It pins Gradle, AGP, Kotlin and Compose so the model never
  guesses. `org.json` simply was not on the list — a one-line fix, plus a
  mention in `android_status` so the *planner* sees it before writing the item.
- The filesystem hunt needs one sentence in `android_status`: dependencies
  resolve from Maven Central inside the container; do not look for jars on disk.
- Only the third layer — that `org.json` drops a trailing `.0` on serialisation
  and accepts `NaN` — is genuine discovery, and NOTES.md is its right home.

The generalisable version, since you cannot enumerate every library in advance:
make `android_build` and `android_test` recognise an unresolvable dependency in
the Gradle output and say so plainly, rather than making the model infer it from
a wall of log.

## 6. The memory file works

Unprompted, the worker appended this to NOTES.md:

> JVM tests need `testImplementation("org.json:json")`; 20250101 was NOT
> resolvable from mavenCentral in this container — **use 20240303**.

That is the trap from finding 5, written down with the working version, for a
session that has not been born yet. The notes file after three tasks reads like
something a person would write. This part of the design needs no change.

## 7. A tool the model does not have to assemble is worth a lot

pi-android gives the worker a build front door, a fixed version matrix, and
shaped output — an injected failure goes from 2,837 bytes of Gradle log to 191.

Run 6, without it, spent roughly a third of a session hunting for a Gradle
wrapper. Run 10's scaffold act called `android_status`, `android_scaffold`,
`android_build` and was done in four and a half minutes.

Output shaping is most of the value. The small model's window cannot afford raw
Gradle logs, and a truncated log is worse than no log.

---

## Where run 10 stands

Reset to the `16b8e14` baseline, no wall-clock cap. Planned five items, then:

- `eq.scaffold-compose-project-and-get-a` — verified
- `eq.profile-model-json-store-in-filesdir` — verified
- `eq.research-how-band-sliders-can-actually` — running

This is the first run where a task closed and the loop advanced to the next one
on its own.

## Run 11: the mechanical gate did not know what it was judging

Twenty minutes, one commit, halted by a documentation task.

Round one planned a docs act first — write the acceptance criteria into
NOTES.md, change nothing else. The act did exactly that. Verification then ran
`build_command`, as it does for every task, and the Android CLI answered "no
Android project at or above /data/eq2": the scaffold was the *next* item. Exit
2, rejected, for a failure the task could not have caused.

The retry drew the only conclusion available to it and scaffolded the whole
project inside the documentation task. The build passed; the verifier then
rejected it — correctly — for touching twelve files against a task that said
only NOTES.md may change. Failed *and* oversized is the precondition for
`on_overflow = "promote"`, so the loop converted a one-file note into a plan and
opened iteration 4 by asking what to break it down into.

One wrong gate, three wasted sessions and a corrupted queue row. Run 10 never
saw it by luck: its first planned item was the scaffold, so everything after had
a project to build. The notes tripwire makes a docs act first much more likely.

Fixed by judging the *diff*, not the act's declared `kind`: if every changed
file is documentation the commands are skipped and the evidence says so. Kind
would have opened a loophole — a docs act that touched code would skip the
build — and the diff closes it. Three tests, each mutation-checked.

Two things did work, and this is the run that showed it. Thinking retention is
live: one turn emitted 4,948 output tokens and the next turn's input rose by
4,986 — a ratio of ~1.0 where run 10's equivalent turn moved 217 tokens against
4,082. And `promote` fired for the first time in any run. It fired on poisoned
input, but the mechanism works.

## Run 12: the verifier cannot see the worker's tools

The documentation fix held — the docs act ran and verified, where run 11 died.
Then the scaffold was rejected on its first attempt, and the reason was
structural.

The planning round wrote "finish by verifying android_install succeeds on the
booted emulator" into the task. The worker did it. But the verifier reads the
task, the diff and the output of `build_command` and `test_command` — the
worker's tool calls happen inside a session it never sees. The only trace of the
install was a sentence the worker had added to NOTES.md, and the verifier
refused to take a claim as evidence. It was right to. Any task whose proof is a
tool result rather than a build log was unverifiable by construction.

Then `promote` compounded it. The rejection came with the twelve files a
Gradle/Compose scaffold inherently touches, and failed-and-oversized promoted a
nearly-right task into a plan with two attempts unspent. Breaking a scaffold
down makes it strictly worse: no piece of a scaffold builds alone, so every
child fails the gate its parent would have passed. Run 10 never saw this because
`on_overflow` was `warn`; turning promote on is what exposed it.

Both fixed. `verify.evidence_tools` names the tools whose results are recorded
as they run and appended to the evidence, labelled as the tools' own output; the
file lives outside the repository and is truncated before every session, so a
rejected attempt's install can never be credited to its retry. And promotion now
waits until the attempts are spent.

## Run 13: what a green build cannot see

Seven and a half hours, 31 iterations, 23 commits, 14 items verified and 7
planning rounds. Both run-12 fixes held: the docs act verified instead of
cascading, and the scaffold passed on its first attempt. Killed at iteration 31
rather than run to exhaustion.

Then we installed the APK on the emulator and looked at it. It launches, it does
not crash, every file compiles, lint is clean, and all JVM tests pass. The
screen is wrong in two ways, and the interesting one is the first.

### The defect lives in the seam between two tested units

The band labels read "60 kHz", "230 kHz" ... "14000 kHz". The gains read
"+300.0 dB". Both are off by exactly a thousand, for the same reason:
`android.media.audiofx.Equalizer` reports centre frequencies in **milliHertz**
and band levels in **millibels**. `SystemEqualizer` passes both straight through
into an `EqualizerEngine` interface whose members are named `centerFrequencyForBand`,
`gainForBand`, `minGainDb` and `maxGainDb`. Nothing converts.

What matters is why it survived twenty-eight consecutive verifications:

- `formatHz` is **correct**, and its five unit tests are correct. They pass Hz
  in and assert on Hz. Nothing about them is wrong.
- `SystemEqualizer` has **no tests at all**, and cannot have JVM ones — it needs
  a device.

Each side of the boundary is right on its own terms. The mismatch exists only
where they meet, and that seam is reachable by no test either side could have
written. The verifier sees one diff at a time, so it never saw both halves
together. A compile gate, a lint gate and a passing unit suite are all
structurally incapable of catching this class of bug.

This is not the same as run 10's invisible sliders, which were a layout mistake.
This is a contract violation between two modules that each pass their own gate,
and it is the strongest argument yet that on-device evidence is not a nicety.

### The layout is still wrong, and still compiles

The vertical-slider decision — a horizontal M3 `Slider` under `Modifier.rotate(90f)`
inside a fixed-size `Box`, which the probe act researched and NOTES.md records as
"THE decision" — does not produce vertical sliders. It renders five short
horizontal stubs crammed against the top of the screen, with the frequency labels
stranded a third of the way down behind a large dead gap, and the last label
wrapping onto two lines.

The probe was honest about its limits: it verified that the expression compiles,
and said so. Compiling was all it could check. Nobody looked.

### The harness truncated the evidence, then charged the worker for it

A research act was rejected twice with, verbatim: "The diff is truncated and does
not show sections (c) ProfileControls.kt analysis or (d) MainActivity.kt
confirmation — I cannot verify all four required subsections are present from the
evidence provided."

The verifier was right, and the missing content was ours — and the budget was far
smaller than it looks. `verify.max_evidence_bytes` is 12000, but `gatherEvidence`
splits it: `perPart = Math.max(1000, Math.floor(maxBytes / 3))`, shared by the
diff, each command's output and the tool evidence. **The diff was capped at 4000
bytes**, then run through `truncateHead`, which appended `[... truncated after N
bytes ...]`. The worker's NOTES.md append ran well past that and the tail was cut. Nothing in the payload distinguishes *the harness
trimmed this* from *the worker stopped short*, so a correct refusal reads as a
failed attempt, the tree is reverted, and the retry reproduces it exactly. Two
attempts burned; the third was live when we killed the run. The task was going to
block on a defect the harness introduced.

A docs or research act is the worst case here, because its entire work product
*is* the diff — there is no build log to fall back on.

### Nearly half of all iterations hit a budget

Fourteen budget overruns across 31 iterations: ten against the 30-minute worker
timeout, four against the 10-minute plan timeout. One item — the instrumented
smoke test — spent three attempts and ninety minutes producing nothing at all
before promotion. The run's throughput problem is not rejection; it is that the
local worker routinely cannot finish an act inside half an hour.

## Still open

- **The project description contradicts Android.** It says the app adjusts
  system audio and that moving a slider changes the sound. An unprivileged app
  cannot equalize other apps' audio. Run 7 worked this out privately and lost
  it; runs 8 and 10 both queued research for it. The standing guidance in `eq`'s
  detail still asserts the impossible thing.
- **Acts have no look budget.** Deliberately exempt. The 30-minute worker
  timeout is the only backstop.
- **`timedOutRound()` has never fired in a live run.** Tested, never exercised.
- **Run 10 tests two prompt changes at once** — `dda1275` and `17c047f`. If the
  numbers move we will not know which one moved them.
- The worker prompt still describes the `todo add <id> ...` CLI form while the
  extension registers `todo_add`.
- `todo doctor` warns about `detail` on non-leaf tasks, but a plan's detail *is*
  read, via the plan prompt. The warning is probably wrong for plans.
- The eval harness in `eval/` has never been run. Run it or delete it.
- **Truncation is not labelled as ours.** `truncateHead` marks the cut, but the
  verifier prompt never says that a truncation marker is the harness trimming
  rather than the worker stopping short, and never says not to reject for it.
  Fixing the label is cheap; raising `max_evidence_bytes` only moves the cliff.
  **Fixed in `7de7245`:** `verify.max_diff_bytes` (48000) gives the diff its own
  budget, markers name their author and their dropped byte count, and the
  verifier is told a marker is never by itself grounds to fail.
- **On-device evidence is still optional.** `evidence_tools` makes a tool result
  visible to the verifier when the worker chooses to run one. Nothing requires a
  UI act to have looked at the UI, and a screenshot is not in the loop at all.
  Run 13's unit bug needed exactly that and nothing less.
- **`atomic.max_files = 5` is wrong for a scaffold**, which inherently touches
  about twelve files. Later promotion mitigates it; the budget itself was never
  revisited.
- **A docs or research act should probably never be promotable.** Breaking a
  one-file note into children is never the answer. `cf477d7` stops the run-11
  cascade at its source, so this is belt-and-braces.
- **`todo run --help` is not a flag** — it starts a real 50-iteration run.
  Discovered by accident; cost a queue reset.
- **`thinking_keep_bytes` has never fired live.** It only acts past
  `prune_at_fraction` of the window, which no session has yet reached.

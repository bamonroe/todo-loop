# Android tooling: decisions

Decisions taken 2026-09-20 while run 10 was in flight. Each is justified by
counted waste in a real worker transcript, not by guessing at what might help.
The package is `pi-android` at `~/pi/android` — four tools today
(`android_status`, `android_scaffold`, `android_build`, `android_test`), about
900 lines across six source files, 19 tests.

Android work is recurring here, not a one-off, so this is infrastructure and
worth building properly.

---

## Measured first

**Tool definitions are cheap.** The four Android tools cost ~2,400 characters,
roughly 670 tokens — **1.2% of the worker's 56,320-token window**.

This killed the argument that per-project package loading is about saving
context. It is not. The number is too small to matter.

**Tool confusion is not a live risk at this scale.** The known effect sets in
in the dozens, and small models degrade earlier — but run 10's scaffold act
called status, scaffold, build and test in order, correctly, in four and a half
minutes. The failure mode we actually observed is the opposite: falling back to
raw `bash` 24 times because no tool fit.

Revisit both if a project ever reaches a dozen or more tools.

---

## 1. `android_api` — new tool

**Evidence.** Run 10's research act made 24 container calls in 18.5 minutes.
Eight of them — a third — carried no information about Android at all: three
consecutive calls hunting for `javap` on the PATH, three establishing a
container and locating the SDK, two re-establishing one after it died. The model
wrote a `/tmp/builder_cid` file to carry a container ID between calls, which is
the exact shape of a workaround for a tool that does not exist.

The other sixteen were real: `javap` against `android.jar`, unzipping
`android-stubs-src.jar`, grepping the stubs for specific methods.

**Design.**

- **One required argument, `query`. No mode flag.** If it looks like a
  fully-qualified class name, do a class lookup; otherwise search the stub
  sources for that symbol and report which classes expose it. The model never
  has to choose, which is the safest shape for a small model.
- **Report API level availability.** The stub sources carry "added in API level
  N" annotations. Saying whether something exists at the project's `minSdk` is
  the question the model was actually asking, and raw `javap` cannot answer it.
- **Shape the output.** Signatures always; doc text only for members that
  matched the query; hard cap on length. Dumping a whole platform class into a
  56k window is its own failure. Same principle that takes a build failure from
  2,837 bytes of Gradle log to 191.
- **Cache the stubs on the host.** Extract `android-stubs-src.jar` and the
  `android.jar` class list once into a host-side cache. Every lookup after that
  is a local grep with no container at all — faster than what the model built
  for itself, and the container lifecycle that cost it eight calls disappears.

Rough size: ~150 lines plus tests.

## 2. Dependency handling — upgrade to existing tools

**Evidence.** Run 10's persistence act lost roughly six of nineteen minutes to a
trap the *planner* set. The item's `detail` said to use `org.json`, "built into
Android". True on a device — but `org.json` is stubbed on the JVM, so unit tests
need an explicit `testImplementation`, and the version the worker first reached
for (`20250101`) did not resolve from Maven Central. Four more `bash` calls went
hunting the host filesystem for a jar.

Two thirds of this was anticipatable. The JVM stub is a well-known Android
gotcha. The unresolvable version is exactly what `src/versions.ts` exists to
prevent — it pins Gradle, AGP, Kotlin and Compose so the model never guesses.
`org.json` simply was not on the list.

**Decisions.**

- Add common test dependencies to the version matrix, `org.json:json:20240303`
  included, and surface them in `android_status` so the **planner** sees them
  before it writes the item.
- Teach `android_build` and `android_test` to recognise an unresolvable
  dependency in the Gradle output and say so in one line. This is the
  generalisable half — you cannot enumerate every library in advance.
- Two sentences in `android_status`: dependencies resolve from Maven Central
  inside the container; do not go looking for jars on the host.

Only the third layer of that trap was genuine discovery — that `org.json` drops
a trailing `.0` on serialisation and accepts `NaN`. NOTES.md is its right home,
and the worker put it there unprompted.

## 3. Emulator verbs — second, not first

Corrected assumption: **the emulator runs fine on host RAM and does not contend
with ollama**, which uses VRAM. It was never ruled out.

This matters because it is the only path to mechanical evidence about
*behaviour* rather than compilation. Today the verifier sees that code compiles
and that JVM unit tests pass. That covers the profile store and says nothing
about whether the equalizer actually attaches to an audio session. An
instrumented test can construct `Equalizer` against a real session id, call
`setBandLevel`, and read the level back — real evidence from the platform.

Honest limits: it proves the API path works, not that anything sounds
different. And boot plus instrumented tests is slow against a 30-minute worker
timeout.

**Decision:** build it, but after `android_api`. The API tool is smaller,
cheaper, and justified by a transcript already read. The emulator is the bigger
prize and the bigger build.

## 4. Project profiles — build the plumbing, defer the abstraction

**The emulator boot belongs to the driver, not the model.** Boot once when
`todo run` starts, tear down at the end; the worker just finds a device present.
Same principle that hides the container inside `android_build`. Needs a health
check before use (a long-lived emulator across an overnight run can wedge) and
orphan cleanup, because the driver gets killed hard fairly often and would leave
an emulator running every time.

`pi` already has the mechanism for per-project packages: `--no-extensions`
disables discovery while explicit `-e <path>` still loads named ones. todo-loop
assembles the worker's arguments in one function in `src/cli.ts`, so wiring a
`packages` key from `todoloop.toml` is small.

**Decision:** add the `packages` key and the setup/teardown hooks for this one
project. Do **not** build named, shareable profiles yet — that is designing the
abstraction before having the instances, which is the same mistake the plan
prompt work just taught us to avoid. Revisit at two or three real ones.

The honest framing: the value is that `todoloop.toml` becomes the single place
saying what a project *is* — its packages, its commands, its lifecycle. The
lifecycle hook is the expensive part and is needed regardless; the package list
comes along nearly free once that plumbing exists.

---

## Design rules worth keeping

- **Build verbs out of observed waste in real transcripts, not guesses.** Every
  verb so far was justified by counted tool calls.
- **Separate tools when the *when to use it* differs; one tool with a mode when
  only the *what it operates on* differs.** Build and test differ in when you
  reach for them. A docker tool's `exec`/`ps`/`stop` all act on containers, so
  they belong in one tool. Ambiguity between two descriptions is the real
  failure, not tool count.
- **Better still, remove the choice.** `android_api` infers class-lookup versus
  symbol-search from the query itself.
- **Descriptions should say when *not* to use something.** `android_status`
  telling the model not to explore the filesystem visibly worked.
- **Output shaping is most of the value.** The small model's window cannot
  afford raw logs, and a truncated log is worse than no log.

## 5. `android_lint` — now evidenced, was not

Originally parked as unjustified. Reading run 10's output changed that: three of
the four defects found by hand in 648 lines of generated Kotlin are
lint-catchable.

- Broken indentation in `Bands.kt` — a formatter (ktlint/spotless) catches it,
  and arguably should just fix it rather than report it.
- Unused and badly ordered imports — same.
- **API level misuse — calling something above `minSdk`.** Directly relevant
  given the audio API constraints the research act just established, and the
  audio-wiring tasks are queued right now.

Honest caveat: stock Android Lint's accessibility checks are far stronger for
the old View system than for Compose. The missing semantics on a custom
Compose slider may well slip through. Lint closes three of the four gaps, not
all of them.

**Where it goes.** Not folded into `android_build` — the worker compiles many
times per session and lint is slow, so every inner loop would pay. Its own verb,
wired into `todoloop.toml` as part of what the **verifier** sees, since the
verifier runs once per task and is where "is this good enough" belongs. Named in
`worker_check` so the worker runs it before finishing rather than being rejected
for it.

A rejection for lint failures is the loop working, not the loop breaking.

---

# The closing gate

A separate decision, in todo-loop rather than pi-android, from the same run.

## The failure it prevents

The root `eq` plan is re-entrant and closes when a round adds nothing. It sees
the project description every round. But nothing forces it to *compare* against
that description — it is asked what the next few things are, and **an empty
queue reads as nothing left to do**. Declaring victory because the queue emptied
rather than because the goal was met is the drift risk over fifteen-plus rounds.

Observed already: after nine tasks there is a `ProfileStore` with 134 lines of
tests and **no queued task for the profile save/load UI** — naming a profile,
picking one from a list. The only queued profile work is restoring the last one
used. The headline feature is half-built and the planner has not noticed.

## Rejected: an appended final task

Three problems. A tree has no end to append to. If it is an `act` it must
produce a diff, and a review that finds nothing produces nothing. And it fires
once, when the question needs asking every time the root re-enters.

## Decision: put it in the closing gate

The plan prompt already says "an empty round is how a branch closes". That line
becomes the gate: restate the goal, say where each part of it is satisfied, and
only then close. Anything unsatisfied becomes this round's items. Re-entrant for
free, no new task type.

## Decision: two classes of acceptance criterion

Derive acceptance criteria once from the project description, write them into
`NOTES.md`, and make closing mean ticking those rather than recalling prose.
Tag each one:

- **Checkable** — "the background must be blue", "profiles save and load".
  Verified mechanically by tests, lint, and eventually instrumented tests.
- **Good-faith** — "make it look good". The user is asking for effort, not a
  measurable property, and it is unreasonable to demand exactness.

**The anchor that stops good-faith becoming a rubber stamp:** make the model
*point*, not judge. Not "did you make a good-faith effort" — the answer is
always yes, and this model is generous with itself. Instead: **name the work.**
Which task, which file addressed this goal. A goal nothing can be named for is
unmet. That is mechanical rather than a judgment call, and much harder to fake.

## The by-product: a morning handoff

When the root closes, emit the good-faith criteria alongside what was named for
each. An overnight run then ends not with a claim of "done" but with a short
list — *"make it look good: addressed by the tokens task and the screen task"* —
skimmable in a minute, telling you where to look and what to disbelieve.

## The standing limit

A goal check against a project that has never executed is a check of intentions,
not behaviour. "Moving a slider changes the sound" cannot be ticked by any
amount of reading. That is what the emulator verbs buy, and it is the strongest
argument for building them.

---

# Notes-file maintenance

Third decision from the same conversation. The notes file is append-only across
up to fifty iterations, so growth is guaranteed even though rot has not appeared
yet (at nine tasks the file is ~40 lines and excellent).

## The wrong design, rejected

A fixed size threshold that triggers a "compact the notes" act. Fatal flaw: a
large project's correctly-compacted knowledge eventually exceeds any fixed
number, at which point the trigger stops meaning "tidy this" and starts meaning
"delete true facts until the number is satisfied". That is worse than rot.

## Decisions

- **The currency is window share, not bytes.** The notes are read by every
  session, so what matters is the fraction of the 56,320-token window they eat.
  That ratio is the tripwire that queues a compaction docs act.
- **Judge compaction by outcome, with the harness's own idiom.** A compaction
  that shrinks the file made progress. A compaction that cannot shrink it has
  *proven the file compact* — the same way a planning round that adds nothing
  proves the branch done. No model ever judges "is this organized".
- **A no-shrink compaction graduates the file to structure.** Split into an
  index every session always reads — one line per topic, like titles — plus
  per-topic files read only when a task touches them. The audio act reads the
  audio notes; the profile act never pays for them. This is the sibling-titles
  trick one level up (titles always, details on demand), and it scales
  indefinitely because the always-paid part grows like a table of contents
  rather than like the knowledge.
- **One standing rule for any compaction act:** never delete a constraint that
  names a version or an API. Those are the expensive facts.

## Not proposed

APK inspection. Plausible, but no run has burned time on it. When one does, that
is the evidence to build it.

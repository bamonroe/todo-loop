# Prior art: harnesses that make limited models do more

A survey, written 2026-11-23, of what other people have built that resembles
interrogate + todo-loop, and what of it is worth borrowing. It starts with a review
of our own design, because the comparison only means something against that.

How sure each claim is: entries marked **(checked)** were confirmed by web search
on 2026-11-23. The rest are well-established projects, described from knowledge as
of mid-2026 and not re-checked. Star counts and version numbers are from pages of
unknown date. Treat them as rough.

---

## 1. What we have, briefly

The whole pipeline, as it stands:

```
interrogate  ──►  SPEC.md  ──►  todo.toml (one root plan)  ──►  todo run
(one question,     (requirements          (plans re-enter;       (one pi -p process
 a suggested        tagged checkable       acts write one diff)    per item, verified)
 answer, a clock)   or good-faith)
```

- **interrogate** (`~/pi/interrogate`) asks one question per turn, about one
  decision. Every question carries the interviewer's own suggestion, and an
  unanswered question is recorded as an *assumption*, marked as one in the spec. A
  closing review judges whether the answers are enough to build. An optional
  respondent model answers from the owner's notes, so the owner sees only what the
  notes leave open.
- **todo-loop** runs each item in a fresh `pi -p` process, so a context clear is a
  process exit. Its items are of two kinds, set by `level`:
  - an **act** writes one diff and gets one verdict;
  - a **plan** decides only the next few steps, and comes back for another round
    after its batch lands (`design-notes.md` §5b).

  The build and test commands short-circuit before any model judges a diff. A
  different model then judges the diff against the task text, never against the
  worker's own summary. Three attempts, then blocked. `NOTES.md` is the memory
  that passes between sessions.

### Strengths, against the field

1. **Measured, not argued.** `findings.md` comes from fourteen real runs, and
   nearly every rule traces back to a run that broke without it. No project
   surveyed below publishes anything like it.
2. **The verifier works from evidence, not the worker's claims.** It sees the
   diff, the command output and the recorded tool results, never the worker's
   summary. Most of the projects below accept the agent's own "done", or check it
   with the same model.
3. **Plans re-enter.** A small model asked to design a whole project against an
   empty directory can only invent the design: in run 2, 82% of the thinking went
   into exactly that. Asked "what are the next few things?" with the code on disk,
   it answers well. None of the spec-first tools works this way. They all plan up
   front.
4. **The rules on planning are enforced in code, not requested.** Every round must
   land at least one act. The research allowance is inherited by child plans, not
   reset.
5. **The interview's suggestions make it usable.** The interview finishes when the
   owner walks away, and every guess stays labelled.

### Weaknesses

1. **The seam between two units.** In run 13, every gate passed, but the screen
   said "14000 kHz" and "+300 dB". Two modules disagreed on units, and each was
   correct on its own terms. The verifier sees one diff at a time, so no test
   either side could write would catch it. On-device evidence for UI acts is still
   optional.
2. **Thinking eats the time.** In run 14, 98% of session time was generation,
   mostly reasoning, and tool calls took 1.3 minutes in total. Ollama ignores the
   graded thinking levels, so prompt wording is the only lever. `0e049f0`, the
   block on what tool calls really cost, is not yet measured on a run.
3. **Prompt text costs every session.** One added block raised planning thinking
   by about 40% for the same output (finding 3). The current prompts have not been
   audited against that.
4. **Plans assert facts nobody has checked** (finding 5, the `org.json` trap).
5. **The interview has no step that checks the goal is possible.** The equalizer
   goal asked for something stock Android doesn't allow, and it was still open
   after several runs.
6. **The default worker is no longer local.** `cb3ad93` (2026-11-08) moved it to
   `openai-codex/gpt-6-luna`. Projects that pin the local model still test the
   original idea. Runs on the default do not.
7. **Housekeeping** (from `findings.md` → Still open):
   - the worker prompt still shows the `todo add` CLI form, but the tool the model
     has is `todo_add`;
   - `eval/` has never been run;
   - run 10 changed two prompts at once, so their effects can't be told apart.

---

## 2. Why research acts get stuck

This section is a diagnosis from one project's logs. It belongs in `findings.md`
and has a summary there. The detail is here because it decided what to borrow.

The owner's report was that the loop "gets stuck when there is deep research to
do". The case studied is `ai-desktop.integration-inventory` in
`~/AI desktop`. It is a research act, blocked on 2026-11-15 after three attempts,
each rejected with "No file changes were made for this task". The worker was
`ollama/default:buddy` (`maxTokens` 8192 per turn in `~/.pi/agent/models.json`).
The sessions are in `~/.pi/agent/sessions/--home-bam-AI desktop--/`, started at
01:50, 02:09 and 02:23 UTC.

**All three attempts ended the same way.** About fifteen minutes of short
read/bash turns, then one final turn with no tool call: 29,105, 31,036 and 28,842
characters of thinking, stopped by `stopReason: "length"`, the 8,192-token output
cap. The model was drafting the whole inventory in its reasoning before calling
`write`. It hit the cap mid-thought, the session ended, the diff was empty, and the
rejection said only "no file changes". So the retry knew nothing about why the last
attempt failed, and it did the same thing again. The same day's 01:29 session also
ended on a length stop.

Two harness causes make it worse:

1. **Research is the worst case for drafting in your head.** An act's deliverable
   for a code task is checked by the build, piece by piece. A research act's
   deliverable is one block of prose, and a model told to "write it for a session
   that cannot ask you anything" composes the whole thing before writing any of
   it. The economics block (`0e049f0`) tells the model not to draft *code* in
   reasoning. It says nothing about prose.
2. **The project pins an outdated output cap.** The project's `todoloop.toml` sets
   `tool_output_max_bytes = 2048`. The default is now 8192, raised because 2048
   handed a worker 39% of its own files (config.ts). `NOTES.md` was 4,020 bytes, so
   every read was cut, and attempt 1 read it, or tried to, six times. The same
   files were re-read across turns to piece them together.

**What this rules out.** This question was a read-only inventory of local files,
not web research. The other stuck research act on record (`eq2`, on-device
`bandCount`) was emulator work that ran into the 30-minute limit. So a web research
engine (§4.1) would not have unstuck either of them. The fixes are in the harness:

- **Make the deliverable incremental.** Have research acts append to the memory
  file as they go, one finding at a time, and say so in the research block: write
  each fact the moment it is known, never compose the section at the end.
- **Tell the worker it is near the cap.** The extension already shapes tool
  results. A turn that is about to run long can't be interrupted, but a rejection
  can say what happened.
- **Say why in the rejection.** When the last turn of an attempt stopped on
  `length` with an empty diff, the rejection should say "your session ended on the
  output-token cap while you were reasoning, before you wrote anything; write
  findings to the file as you go". Then the retry gets a different prompt from the
  attempt that failed.
- **Let `todo doctor` flag stale caps.** It could warn when a project pins
  `tool_output_max_bytes` below the default.
- **Also consider:** raising `maxTokens` for the worker model, which only moves the
  cliff, and breaking an inventory over many directories into one research act
  per directory at planning time.

---

## 3. The field

### 3.1 Interview first: the closest to interrogate

- **interview-me / grill-me skills (Addy Osmani's agent-skills)** (checked).
  Interview skills that ask one question at a time, each with a proposed answer
  the user reacts to, until about 95% confidence. This is interrogate's core idea,
  without the clock, the respondent model, the assumption ledger or the handoff.
  <https://github.com/addyosmani/agent-skills>
- **Kiro (AWS) spec mode** (checked). Writes `requirements.md` in EARS form ("WHEN
  ... THE SYSTEM SHALL ..."), then `design.md` and `tasks.md`. It can analyse the
  requirements for ambiguity, gaps and conflicts *before* design, and runs
  independent tasks in parallel. That analysis pass is the nearest commercial
  match to "a spec that needs no guessing", and the one piece interrogate lacks.
  <https://kiro.dev/docs/specs/>
- **SpecBench (Red Hat / MIT-IBM)** (checked). A research paper on an interactive
  agent that interviews a user to draft a spec sheet, with a benchmark. By
  coincidence its agent is also called "Buddy".
  <https://haowang94.github.io/files/specbench.pdf>

### 3.2 Spec, then a task list

- **GitHub Spec Kit** (checked). A constitution, then `/speckit.specify`, `/plan`,
  `/tasks` and `/implement`, through a `specify` CLI that targets about 30 agents.
  Very popular (around 96K stars). The spec-then-tasks shape matches, but there is
  no interview, no fresh context per task, no independent verifier, and the whole
  plan is made up front. <https://github.com/github/spec-kit>
- **BMAD Method** (checked). Analyst, PM and Architect personas write a PRD and an
  architecture doc, then shard them into "story" files, each implemented by a Dev
  agent in a fresh chat. The closest to one-context-per-task among the spec tools.
  It is built around strong models and a person driving each step. MIT licence.
  <https://github.com/bmad-code-org/BMAD-METHOD>
- **Taskmaster / claude-task-master** (checked). Parses a PRD into tasks with
  dependencies, complexity scores and subtasks, and now has a `loop` command that
  runs Claude Code per task. It is the only one shaped enough like todo-loop to
  *replace* it. But it decomposes the whole PRD up front with a strong model,
  which is the failure §5b of the design notes documents, and it has no
  mechanical gate or cross-model verifier. MIT with a Commons Clause.
  <https://github.com/eyaltoledano/claude-task-master>
- **Aider architect/editor mode.** A strong model proposes the change and a
  cheaper or local one writes the edit. The same planner/worker split, done per
  edit rather than per task. <https://aider.chat/docs/usage/modes.html>

### 3.3 Fresh-context loops

- **The Ralph loop (Geoffrey Huntley)** (checked). A bash loop that feeds the same
  prompt to a fresh agent process again and again, with state only in files and
  git (a PRD, a progress file). It is now on the Thoughtworks Technology Radar.
  todo-loop is a far more structured Ralph: re-entrant plans, a cross-model
  verifier and mechanical gates.
  <https://ghuntley.com/ralph/>
- **Anthropic's Ralph plugin for Claude Code** (checked). Keeps the agent going
  with Stop hooks. Critics note it often stays in one context, which loses the
  point.
  <https://www.thoughtworks.com/radar/techniques/ralph-loop>
- **mini-swe-agent** (checked). About 100 lines, bash as its only tool, no
  tool-calling API. A 2026 study found weak models drop off sharply as its context
  grows, which supports short fresh contexts.
  <https://github.com/SWE-agent/mini-swe-agent>
- **SWE-agent.** Origin of the "agent-computer interface": purpose-built, linted
  view and edit commands instead of a raw shell. pi-android's shaped tools are the
  same idea. <https://github.com/SWE-agent/SWE-agent>
- **Agentless.** No agent loop at all: fixed stages (localise, repair, validate
  with tests) a weak model can follow. The extreme form of "the harness decides,
  the model fills in". <https://github.com/OpenAutoCoder/Agentless>
- **OpenHands.** An open agent platform. Its "condensers" are context-compaction
  strategies worth comparing with `capped-compaction`.
  <https://github.com/All-Hands-AI/OpenHands>
- **smolagents (Hugging Face).** Agents act by writing code rather than JSON tool
  calls, which tends to suit small models. <https://github.com/huggingface/smolagents>

### 3.4 Levers aimed at small models

- **"Small Language Models are the Future of Agentic AI" (NVIDIA, 2025)**
  (checked). Argues most agent subtasks are narrow and repetitive, so small models
  handle them once the work is decomposed. It is the theoretical case for this
  whole design. <https://arxiv.org/abs/2506.02153>
- **Harness-Bench (Qihoo360, May 2026)** (checked that it exists). Holds the model
  fixed and varies the harness. A secondary write-up reports a 23.8-point swing
  from the harness alone, largest for weak models. That figure is not checked
  against the paper. <https://arxiv.org/abs/2605.27922>
- **Tool count.** An O'Reilly write-up (checked) reports an 8B model failing with
  46 tools and succeeding with 19 in the same 16k window.
  <https://www.oreilly.com/radar/agent-harness-engineering/>
- **Observation masking** (checked). JetBrains research (December 2025) and arXiv
  2508.21433 found that simply hiding old tool output matches LLM summarisation,
  at lower cost.
  <https://blog.jetbrains.com/research/2025/12/efficient-context-management/>
- **Anthropic, "Effective context engineering for AI agents"** (checked). Context
  rot, and using the smallest set of high-signal tokens.
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- **Addy Osmani, "Agent Harness Engineering"** (checked). The "ratchet": every
  agent mistake becomes a permanent rule. `NOTES.md` and `findings.md` already do
  this. <https://addyosmani.com/blog/agent-harness-engineering/>
- **WWT, "Building agent systems on small local models"** (checked). Move
  computation and planning into code, budget the context, distrust a small model's
  "done". <https://www.wwt.com/blog/building-agent-systems-on-small-local-models>
- **Constrained decoding.** Outlines, llama.cpp GBNF grammars, guidance and
  XGrammar force output to match a schema. Ollama exposes this as `format` with a
  JSON schema. It would make plan rounds, verdicts and interrogate's turns
  unparseable-proof. Whether pi can pass a schema through per call is not yet
  known. <https://github.com/dottxt-ai/outlines>, <https://github.com/mlc-ai/xgrammar>
- **DSPy.** Optimises prompts and few-shot examples against a metric. It could
  tune the act and plan prompts against `scripts/turn-cost.ts` numbers, but needs
  an eval set first, which is `eval/`. <https://dspy.ai>
- **Test-time compute.** Self-consistency, best-of-N with a verifier, Reflexion's
  retry with the failure attached. todo-loop already does the last one. Best-of-N
  is costly at 10 to 12 tokens a second.
- **Planner/executor patterns.** ReWOO, LLMCompiler (plan a task graph once, run
  it) and Tree-of-Thoughts. They are the up-front planning that §5b moved away
  from. <https://github.com/SqueezeAILab/LLMCompiler>

---

## 4. Verdict: borrow pieces, don't adopt

Nobody surveyed has solved this better. The popular tools (Spec Kit, BMAD,
Taskmaster, Ralph) put a strong model in front, plan the whole project up front,
and accept the agent's word. The research results (NVIDIA, Harness-Bench, the
tool-count and masking studies) agree with what our runs measured rather than
going beyond it. There is no project to adopt in place of todo-loop. These pieces
can be lifted in whole:

### 4.1 For web research: a research engine as a tool

These are from knowledge, not checked 2026-11-23. Check them before building on
them.

- **GPT Researcher.** A planner splits a question into sub-questions. Each is
  searched, scraped and summarised in its own small context, then a writer combines
  the summaries into a cited report. That is todo-loop's decomposition applied to
  research. It supports Ollama, local documents as a source, and runs as a CLI or
  MCP server. It is the strongest candidate to wrap as a worker tool.
- **Stanford STORM.** Asks questions from several simulated points of view, builds
  an outline, then writes. Slower; better for open "how should we do X" questions.
- Also in this family: LangChain's open_deep_research and Jina's node-DeepResearch.
- **A search backend.** None of the workers can search today: `~/.pi/agent/mcp.json`
  has only cadweb and buddy, and pi has no web search built in. Any of the above
  needs one, and a self-hosted SearXNG is the usual local choice.

§2 shows this is **not** what is blocking today's stuck acts, which were local
investigations. It matters as soon as an act needs outside knowledge, such as
whether an Android API can do something.

### 4.2 For interrogate

- **A spec analysis pass**, like Kiro's: before handoff, a call over `SPEC.md` that
  lists ambiguities, contradictions and requirements that can't be met on the
  stated platform, and sends them back into the interview as questions.
- **EARS-form requirements** in the writer's template, for the requirements tagged
  `checkable`: "WHEN ... THE SYSTEM SHALL ...". Each one turns into a test more
  directly. That is also the best lever on the run-13 seam bug: a requirement
  stated end to end ("WHEN the user opens the EQ screen THE SYSTEM SHALL label each
  band in Hz") gives the planner an acceptance test that spans both units.

### 4.3 For todo-loop

- **Schema-constrained output** for plan rounds and verdicts, via Ollama's `format`.
  First check whether pi can pass it.
- **A tool set per kind of act.** A research or docs act doesn't need the build
  tools, and fewer tools means less for a 27B to weigh.
- **Observation masking** instead of summarising old tool output, if sessions ever
  start reaching the window. They have not so far.
- **The research fixes in §2**, which come from our own logs, not from anyone else.

---

## 5. Next steps, in order

Done 2026-11-23:

- §2 fixes in todo-loop: research acts write each finding as they go
  (`634e666`); a rejection after an output-cap stop says so (`f1f0fc0`); the
  memory file is never capped on read (`7d20981`); the template's cap matches
  the 8192 default and `todo doctor` flags a stale pin (`d36204c`);
  `scripts/turn-cost.ts` counts output-cap stops.
- §4.2 in interrogate (`de1088b`, local only, as that repo has no remote):
  checkable requirements in EARS form, and a closing review that counts
  contradictions, impossibilities and untestable answers as gaps.
- A bench to measure all of it: `/side_hustle/sky-bench`, a sky almanac web
  page. See its README.

Still to do:

1. Run the bench on the local worker and score it with `bench-report.sh`.
2. Stand up SearXNG plus GPT Researcher, and trial it on the local Qwen as a
   research-act tool against a question that really needs the web. The bench's
   sun and moon algorithms are such a question.
3. Check whether pi can pass an Ollama JSON schema per call. If it can,
   constrain verdicts first.
4. A tool set per kind of act.

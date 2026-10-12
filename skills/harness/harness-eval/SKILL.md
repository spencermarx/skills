---
name: harness-eval
description: >-
  Measure whether a repository's skills fire when they should: routing evals that show
  which skill a prompt actually triggers in Claude Code, plus harness-neutral static checks
  (skill inventory, description cap, Claude Code rule glob reach). Use whenever someone says
  run the evals, did that skill trigger, why did the wrong skill fire, is this description
  any good, write routing cases for this skill, or check the harness. Do NOT use to write or
  rewrite the skill under test (measure here, then edit it), or to review a code change.
license: MIT
compatibility: >-
  Static checks need python3 and git, in any repository and any harness. Routing evals
  measure Claude Code only: they need Node.js 22.22 or newer, a one-time npm install the
  skill asks before running, and a Claude Code login or ANTHROPIC_API_KEY; every case costs money.
argument-hint: '[census|checks|routing <skill or cases path>]'
---

# harness-eval

Two questions decide whether a skill library works: does the right skill fire for
a prompt, and does every artifact stay inside the limits the harness reads it by.
This skill decides what to measure and how to read the answer. The scripts and the
engine it carries do the mechanical part.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

**A number here is evidence, never a verdict.** Routing results are
non-deterministic, so none of them becomes a gate. A static check may become one
(a CI step, a hook) only once it has been watched both catching an injected
defect and staying quiet on a legitimate shape. The repository this engine comes
from once retired a validator wired to a pre-commit hook after an audit found 45
of its 47 checks had never fired: a check nobody has watched fail is
indistinguishable from one that never ran.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

From `docs/agents/workspace.md`:

- **Eval cases:** where this repository keeps its routing cases. Default:
  `.evals/cases/`.
- **Scratch folder:** where run history (and, if needed, the engine install) goes.
  Default: `.scratchpad/`.
- **Conventions folder:** optional; `census.py` reads it from the same file and
  counts its documents.

Pass a non-default scratch folder to every engine and runner call as
`--scratch <folder>`.

## Two halves, two different claims

| | Static checks | Routing evals |
|---|---|---|
| Question | is every artifact well formed and inside its limits | which skill fires for this prompt |
| Harness | any: they read files, not a running agent | **Claude Code only** |
| Needs | python3, git | Node.js 22.22+, one install, a Claude Code login or API key |
| Cost | free | real money per case |

Routing evals run each prompt through the Claude Agent SDK with Claude Code's own
system prompt and tools, so a trigger rate is a statement about Claude Code's
routing. It is good evidence about a description in general, but say "in Claude
Code" when you report it. No runner for another harness ships here.

## Static checks

Run from the repository root:

```bash
python3 scripts/census.py .
python3 scripts/check_descriptions.py .        # add --cap 500 for a tighter house cap
python3 scripts/check_globs.py .               # Claude Code .claude/rules/ only
```

- **`census.py`** inventories skills wherever they live: `.claude/skills/`,
  `.agents/skills/`, `.github/skills/`, `.cursor/skills/`, a `skills/**` catalog
  layout, and every Claude Code plugin manifest's `skills` list (add more with
  `--root DIR`). It prints the invocation split, each description's length, which
  skills the eval cases assert on, the harness files present, and the conventions
  folder. `--json` for machine output. Exit 0 always: it is an inventory.
- **`check_descriptions.py`** reports any description over the cap: 1024
  characters by default (the Agent Skills maximum, where Copilot truncates), or
  `--cap N`. It finds skills exactly where `census.py` does.
- **`check_globs.py`** reports Claude Code rule globs that match no file, and,
  for each tree named with `--vendored PREFIX`, globs that reach into prose this
  repository does not author. Without `.claude/rules/` it skips with a note.

The checks exit 0 clean and 1 with findings, one per line. **Exit 1 with empty
stdout is a precondition that could not be met**, explained on stderr: read both
streams before reading an empty result as a pass.

## The partition that comes before any measurement

A skill carrying `disable-model-invocation: true` is reached by a person typing
its name. Its description is not a dispatch surface, no trigger eval is possible
for it, and its length says nothing about routing.

`census.py` draws that line and is the only place it is drawn. Skipping it
produces confident false positives: a "description too short to trigger" check
across a whole library flags every human-invoked skill, and every one of those
flags is wrong. Read the split off the tool, never off a page; it moves whenever
a frontmatter changes.

## Routing evals

### 1. Check the engine is installed

The engine's Node dependencies (promptfoo and the Claude Agent SDK, pinned in
`engine/package-lock.json`) are not shipped installed. Check first:

```bash
bash scripts/engine.sh status --repo . --scratch <scratch folder>
```

Exit 0 prints where it is installed: go on. Exit 3 means it is not, and prints the
exact command an install would run. Then:

1. Tell the user what will happen: npm installs promptfoo and the Claude Agent
   SDK (several hundred packages) into the folder the status named, and every
   routing case run afterwards costs money, billed to their Claude Code login or
   API key.
2. Ask the user whether to install, using your structured-question tool if you
   have one; otherwise list numbered options in plain text and stop until they
   reply.
3. Only on yes, run
   `bash scripts/engine.sh install --repo . --scratch <scratch folder>`. It runs
   `npm ci --prefix` on this skill's `engine/` folder, or, when that folder is not
   writable (a plugin cache can be read-only), copies the manifest and lockfile to
   `<scratch folder>/harness-eval-engine/` and installs there, and says which. If
   it fails, show the user the command it printed so they can run it themselves.

An update to this skill replaces its folder, or changes the lockfile, so the
status check simply asks again. Never install without the user's yes.

### 2. Pick which skills the agent under test sees

- **Default:** the repository's own `.claude/skills/`, discovered the way a live
  Claude Code session discovers them (`setting_sources: project`).
- **`--skills DIR`** (repeatable): every skill folder under DIR is copied into a
  throwaway sandbox's `.claude/skills/` and the run happens there. Use it for a
  catalog layout (`--skills skills`), for `.agents/skills/`, which Claude Code does
  not read, and for fixtures. Skill names stay bare.
- **`--setting-sources project,user`**: also loads the user's own skills and
  plugins. Plugin skills are invoked as `plugin:skill`, so a case asserting on one
  must use that full name.

### 3. Run

```bash
bash scripts/run.sh --repo . --scratch <scratch folder> <eval cases folder>/<file>.yaml --repeat 3
bash scripts/run.sh --repo . --scratch <scratch folder> --view
```

With no case path it runs the whole eval cases folder. Always go through
`run.sh`: it writes the promptfoo config where the SDK can be resolved, keeps
promptfoo's history in the scratch folder instead of the user's home directory,
and puts `Skill` in the agent's allowed tools, without which every `skill-used`
assertion silently fails. `--print-config` shows the generated config and costs
nothing; check it before a large sweep. Pass any other promptfoo option after
`--` (for example `-- --output results.json`). Mechanics and failure modes:
[references/engine.md](references/engine.md).

`--view` opens a local grid where a person can read each case's transcript and
mark it pass or fail. Reading the transcripts is the point; the aggregate is a
summary of what you read.

## Procedure

1. **Run `census.py`.** Confirm the partition and name which side the skill under
   test sits on. A human-invoked skill stops here.
2. **Name the tier.** [references/tiers.md](references/tiers.md). "Does the right
   thing fire" is routing. "Was the convention obeyed" is adherence, which no
   script here measures yet.
3. **Write the cases** in the eval cases folder, one file per skill or per cluster
   of competing skills, positives and near-misses balanced.
   [references/writing-cases.md](references/writing-cases.md) has the format and
   what makes a near-miss worth running; a negative that is obviously irrelevant
   tests nothing.
4. **Prove the eval discriminates before trusting it**: a paired fixture, one
   capability described twice, once weakly and once well, run head to head
   ([references/writing-cases.md](references/writing-cases.md#prove-the-instrument-first)).
   If the eval cannot separate them, it is measuring nothing, and that is the
   finding.
5. **Run at `--repeat 3` or more.** A single run of a non-deterministic system is
   an anecdote.
6. **Open the viewer and read transcripts.**
7. **Report a paired delta**, never a bare number.
   [references/interpreting.md](references/interpreting.md) has the arithmetic.

## What a result may claim

A trigger rate is evidence about a description, measured in Claude Code on
queries somebody chose. It is not a quality score for the skill, and it says
nothing about whether the skill does good work once it fires.

Read a low number in order. The intended skill did not fire at all: the
description failed to be recognised, so rewrite its triggers before touching the
body. The wrong sibling fired: the two descriptions overlap, so add negative
routing to both. The right skill fired and the work was poor: routing is fine and
this skill has nothing more to say. Why that order:
[references/interpreting.md](references/interpreting.md#which-failure-you-are-looking-at).

## Cost

Each case is a full Claude Code session. One measurement put a completed case
near $0.58; a subscription login spends usage limits instead of dollars, but the
volume is the same. Full coverage, every model-invocable skill at 20 queries and
3 runs each, lands in the thousands of runs: multiply `census.py`'s count before
proposing it. Scope a sweep to the skill or cluster being worked on and say what
was left out; a sweep that silently covers less than it claims reads as coverage.
Never start a routing run the user has not asked for.

## Done

- The skill under test is on the model-invocable side of the partition, or the
  measurement was abandoned because it is not.
- The cases include near-misses that route to a named sibling, not only
  happy-path prompts.
- Every check you added has both an injected-defect case and a stays-quiet case,
  and you watched each do its job.
- The result is reported as a delta against a stated baseline, with the number of
  runs it averages, and says it measured Claude Code.
- Every static finding is resolved or explained. A finding that stands needs its
  reason written beside it, because a check whose output nobody dispositions
  decays into one nobody reads.

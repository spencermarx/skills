# Writing cases

A case file is a list of prompts and what should have happened. The prompts are
the hard part and cannot be generated; the format is mechanical, and the
judgement is in choosing which queries are worth running.

## Where they go

In the repository's eval cases folder (`docs/agents/workspace.md`, default
`.evals/cases/`), one file per skill (`handoff.yaml`) or per cluster of skills
that compete for the same triggers (`grilling.yaml`). Clusters are the more
useful shape, because collisions are where routing actually fails. Start each
file with a comment saying what it measures, which siblings are the likely
thieves, and whether it establishes a baseline or detects a regression.

## The format

promptfoo's test format, deliberately: a second schema on top of it would mean a
translation layer for no capability. A file is a YAML list; each case has a
`description`, the prompt in `vars.query`, and assertions:

```yaml
# handoff: does it fire at the end of a session, and stay quiet for its neighbours?

- description: names the artifact, which is also the word scratchpad claims
  vars:
    query: write a handoff before I stop for the day
  assert:
    - type: skill-used
      value: handoff
    - type: not-skill-used
      value: scratchpad

- description: a scratch file with no handoff intent
  vars:
    query: I need somewhere git-ignored to dump these API responses
  assert:
    - type: not-skill-used
      value: handoff
```

`value` is the skill's name exactly as the agent invokes it: the bare name for a
project skill, `plugin:skill` for a plugin skill. It also takes a list, or an
object with `pattern:` (glob, case-insensitive) when a name varies.

**Quote any query containing `#`.** A bare YAML value with `#` in it (a
`#channel`, an issue number) is cut at the `#` as a comment, and the case runs a
truncated prompt without complaint.

Files ending `.config.yaml` are skipped by the runner, and a file in another
format (a `query` / `should_trigger` list, say) is refused rather than run.

## Write the prompts before the assertions

Draft the queries first, as a set, and only then decide what each asserts.
Writing an assertion beside each prompt as you go biases the prompt toward what
is easy to assert, and the result is a suite that passes because it only ever
asks easy questions.

## Assert twice wherever a sibling could steal the trigger

A case naming an intended skill also names the sibling most likely to steal it.
A near-miss whose only job is to prove a skill stays quiet asserts once, because
there is often no single winner to name without guessing, and a positive
assertion that fails for a defensible reason makes a noisy case.

A case asserting only the positive cannot distinguish a precise description from
one that fires on everything. A library where every skill fires on every prompt
would pass a suite of positives at 100 percent.

## Near-misses are the whole exercise

A negative that is obviously irrelevant tests nothing. "Write me a fibonacci
function" as a negative for a PDF skill is too easy: it would pass against every
skill in the library and prove none of them precise.

A useful near-miss sits one step away from a real trigger, a sentence a person
could plausibly type on a day when they wanted the other skill:

- a settled choice rather than a convention, which is a decision record and not
  a new standard;
- prose for a person rather than for an agent;
- a summary written for someone to act on rather than for an agent to resume;
- a glossary term rather than a rule.

Find a library's dense clusters by reading its descriptions side by side: any
two that share a trigger verb, or name each other in their negative routing, are
a cluster worth one file.

## Queries a model would answer without any skill

A skill is consulted for work the model cannot trivially do alone, so "read file
X" is a poor case: it will not trigger anything regardless of how the description
is written, and it will look like a description failure.

Write queries with enough substance that reaching for a procedure is reasonable.
Include the texture of real requests: a file path, a name, a complaint, a typo, a
half-sentence. A suite of clean imperative sentences measures a register nobody
actually types in.

## How many

Twenty per cluster is a working number, roughly half positive. Fewer than fifteen
cannot distinguish anything but enormous differences.

Sizing is not a matter of taste. At 100 cases and an 80 percent pass rate the 95
percent confidence interval runs from about 72 to 88, and it narrows only with
the square root of the case count, so halving its width costs four times the
cases. [interpreting.md](interpreting.md) has the consequence: report paired
deltas, because pairing on the same cases cancels the noise that makes absolute
numbers unreadable at this scale.

## Prove the instrument first

Before believing any number about a real skill, watch the eval tell a weak
description from a strong one. Build a paired fixture outside every folder a
harness discovers skills from (a `tests/` or `fixtures/` folder, never
`.claude/skills/`, where it would register as a live skill):

- two skills covering one capability, with identical stub bodies and names that
  carry no signal (`widget-forge-a`, `widget-forge-b`), so the description is the
  only difference. One description names what the skill *is* as a noun phrase;
  the other leads with the capability, lists the phrases a person types, and
  routes a near-miss away to a named sibling;
- that sibling (`widget-inspect`), because negative routing to a skill that is
  absent tests nothing: the query lands nowhere and the case passes on the model
  doing no work;
- a case file asserting the strong arm fires and the weak arm stays quiet on
  every positive, and the sibling takes the near-miss.

Keep which arm is meant to win out of both `SKILL.md` files: the agent under
test can read them. Run the fixture alone with
`run.sh --skills <fixture skills folder> <fixture cases file> --repeat 3`. If the
weak arm wins, or neither fires, the instrument is not reading description
quality, and that is the finding.

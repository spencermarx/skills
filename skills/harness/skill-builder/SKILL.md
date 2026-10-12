---
name: skill-builder
description: >-
  Author, refactor, split or port an agent skill (a folder with a SKILL.md) so it does one
  thing, composes with other skills, works in any harness that reads SKILL.md, and fires
  when it should. Use whenever someone says make this a skill, turn this workflow into a
  skill, write a skill for X, refactor or split this skill, port this skill to another
  agent, this skill is not firing, or asks whether something should be a skill, an
  instructions-file note, a standard, a subagent or a command. Do NOT use to measure whether
  a skill fires (use `harness-eval`), to state or route a convention (use `add-standard` or
  `standards`), or for the craft of agent-facing prose in general (use `writing-for-agents`).
license: MIT
metadata:
  credits: "Partly adapted from Anthropic's skill-creator skill, https://github.com/anthropics/skills (Apache-2.0)"
---

# skill-builder

A skill is a folder an agent finds by its description and reads only when that
description matches the task in front of it. Everything below follows from that:
the description decides whether anything else you write is ever read, and the
body is paid for in context every time the skill fires.

Paths below are relative to this skill's directory; resolve them to absolute
paths before reading anything.

## The five rules

1. **Atomic.** One skill does one thing. A skill that does five is reusable by
   none, and its description has to carry five sets of triggers.
2. **Composable.** When the logic already lives in another skill, load that
   skill rather than reimplementing it, and say what happens when it is not
   installed. Calling several skills in a stated order is composition worth
   naming. A skill whose body only hands off to one other skill is an alias:
   it spends a description on a second name for the same thing and splits the
   triggers that should reach one place. Delete it and give its triggers to the
   real skill.
3. **Auto-invocable.** The description is the whole dispatch mechanism. There
   is no router skill, and a library of thirty skills works only because each
   description says when to fire and when to leave the task to a sibling.
4. **Progressively disclosed.** `SKILL.md` stays lean. Depth goes in bundled
   files that load only when the body points at them and the task needs them.
5. **Portable and deterministic.** The skill reads correctly in a harness that
   has never heard of the one you wrote it in. Mechanical work goes in a bundled
   script; the model is reserved for judgment.

## First, is this a skill at all?

The highest-leverage question, and the one most often skipped.

| Need | Primitive |
|---|---|
| A fact agents should know when working in one area | a note in that folder's instructions file (`AGENTS.md`, or the harness's equivalent) |
| A convention that governs a kind of file | a standard: load `add-standard` |
| A repeatable multi-step procedure | a skill |
| A procedure only a person should start | a skill with `disable-model-invocation: true` |
| Context isolation, or a tool surface the main agent must not have | a subagent, shipped inside a portable skill as a prompt template |
| A deterministic action, especially one taking arguments | a script the skill runs, or the harness's own command mechanism |

The row people miss is the second. If what you are writing is "always do X when
touching Y", it is a standard, not a skill: put in a skill, it fires only when
something else remembered to invoke it.

## Procedure

1. **Capture the intent.** If the conversation already holds the workflow ("turn
   this into a skill"), mine it first: the steps that were taken, the
   corrections the user made, the inputs and the outputs. Then settle with the
   user only what the conversation did not answer: what the skill lets an agent
   do, the words someone would type when they need it, what it produces, what
   it must never do, and which skills sit next to it. Ask the user, using your
   structured-question tool if you have one; otherwise list the open questions
   numbered in plain text and stop until they reply. Done when you can write one
   sentence for each of those five.
2. **Check the table above.** If it is not a skill, stop and build the right
   thing instead.
3. **Check for an existing skill** that already covers it, or that this should
   extend: the skills installed in this harness, and the catalog the new one
   will join. Two skills competing for one trigger is worse than either alone.
4. **Write the description first.** It is the hardest part and it decides
   whether anything else you write is ever read:
   [references/descriptions.md](references/descriptions.md).
5. **Write the procedure**, with each step ending on a condition that can be
   observed to be true or false. "Review the document" cannot fail; "list every
   claim with no inline citation" can. Say why a step matters rather than
   shouting it: a model that understands the reason applies it to the case you
   did not foresee, and a wall of capitalised MUSTs reads as noise. Write the
   instruction you want ("write the owner on every action item"), not the
   mistake to avoid. If `writing-for-agents` is installed, load it (through
   your skill tool, `/writing-for-agents`, or by reading its SKILL.md) for the
   underlying craft.
6. **Push depth out.** Anything long, reference-heavy, or needed in only one
   scenario goes to a bundled file the body links, with a line saying when to
   read it: [references/anatomy.md](references/anatomy.md).
7. **Make it portable.** Work through
   [references/portability.md](references/portability.md) item by item. Each
   item is there because breaking it silently fails in at least one harness.
8. **Try it on real prompts.** Write two or three prompts a person would really
   type, with the specifics a real request carries (a file name, a number, a
   bit of backstory), and show them to the user before running them. Run each
   with the skill available and nothing from this conversation: if you can
   dispatch subagents, give each one prompt and the skill's path and run them in
   parallel; otherwise follow the skill's text yourself, one prompt after
   another, and say that you wrote what you are testing. When the question is
   whether the skill earns its place, run the same prompts once more without it
   (or with the previous version) and compare. Read what each run did, not only
   what it produced: steps that waste time point at text to cut, and a helper
   that every run wrote for itself points at a script to bundle. Revise for the
   pattern behind what you saw, never for the specific prompts, which the skill
   will not see again.
9. **Measure whether it fires.** Load the `harness-eval` skill (through your
   skill tool, `/harness-eval`, or by reading its SKILL.md) and hand it the
   skill: it writes balanced should-fire and near-miss cases, runs them, and
   reports a delta against a baseline. Its routing runs measure Claude Code, so
   say so when you report a rate; its static checks (description length, skill
   inventory) work in any harness. If it is not installed, open a fresh
   session per prompt with a mix of should-fire prompts and near-misses that
   belong to a sibling, note which skill fired, and report the result as an
   anecdote rather than a rate.
10. **Self-review** against the five rules, then the anti-patterns below. If
    the catalog the skill joins has its own validator, run it.

## Writing the description, in one paragraph

Under-triggering is the dominant failure mode: a skill that never fires is worse
than one that fires slightly too often, because its absence is silent. Write the
triggers in the words a person actually types, route away from siblings by name,
and keep it under 1024 characters. If a skill is not firing, the description is
nearly always the cause, not the body: rewrite the triggers before touching
anything else. The full method is
[references/descriptions.md](references/descriptions.md).

## Anti-patterns

- **A description that describes the skill instead of its triggers.** Its
  reader is a dispatcher choosing among dozens, not someone browsing.
- **Restating a convention inside a skill.** Link where it is stated. Two copies
  diverge, and the copy in the skill is the one read first.
- **A skill that is really a standard**, so it fires only when someone
  remembers it.
- **Naming one harness's tools or variables** in the body. Describe the action;
  [references/portability.md](references/portability.md) has the wording.
- **A 500-line `SKILL.md`.** If firing the skill is expensive, it will be
  avoided, or it will crowd out the work.
- **A skill whose contents would surprise its user if described**: hidden
  network calls, data leaving the machine, access the task did not ask for.
  Build nothing you would not describe out loud.

## Done

- The description is at most 1024 characters, opens with the capability and
  its triggers, and routes away from every sibling that could plausibly claim
  the same prompt, naming only skills that exist or marking one as optional.
- The body is at most 500 lines; depth sits in bundled files one level deep,
  each linked with a line saying when to read it.
- Every item in [references/portability.md](references/portability.md) holds.
- The skill has run on at least two realistic prompts and you read what each
  run did.
- Whether it fires was measured with `harness-eval`, or the hand check is
  reported as the anecdote it is.

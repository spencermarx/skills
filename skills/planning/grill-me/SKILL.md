---
name: grill-me
description: Relentlessly interview the user about a plan, decision, design or idea, one round of questions at a time, until every branch is settled and nothing is silently assumed. Use when the user wants to stress-test a plan or their thinking before building, when a choice cannot be settled alone and one question will not clear it, or on any 'grill' trigger phrase ("grill me", "grill this plan"). Do NOT use when what the interview settles must be written down as glossary entries or decision records (use `grill-with-docs`), when a single question would do, or to gather raw material for a piece of writing.
metadata:
  credits: "Adapted from Matt Pocock's grill-me and grilling skills, https://github.com/mattpocock/skills (MIT)"
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then stop and wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (the codebase, the filesystem, documentation, a tool's output), look it up rather than asking the user for anything you could find yourself. If you can dispatch subagents, send one to find it in the background and don't block on it: a running lookup is an unsettled prerequisite, so only the questions downstream of it wait for the report, and you ask the rest of the frontier now. Otherwise look it up yourself before composing the round. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.

This interview **converges**: each round narrows the tree until one design stands. An interview that mines raw material for a piece of writing does the opposite, widening what could be said and refusing to structure any of it; this skill is the wrong tool for that.

## Wording the questions

Before composing any question or recommended answer, load the `conveying-clearly` skill (through your skill tool, `/conveying-clearly`, or by reading its SKILL.md) and hold every question, option set and answer to its contract. If it is not installed, hold to its core yourself: lead with the decision being asked for, give each option its consequence, and never use a term you coined this session without expanding it to plain words or glossing it inline at first use.

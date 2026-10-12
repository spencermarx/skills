---
name: domain-modeling
description: Build and sharpen a project's domain model while designing. Use when the user wants to pin down domain terminology or a ubiquitous language, write or edit the project glossary, notices a term being used two ways, or when a significant design decision surfaces that may deserve a record, and when another skill needs to maintain the domain model. Owns the judgment of which terms matter. Do NOT use merely to read the glossary for vocabulary, or to author the decision record itself (use `decision-record`).
metadata:
  credits: "Adapted from Matt Pocock's domain-modeling skill, https://github.com/mattpocock/skills (MIT)"
---

# Domain modeling

Actively build and sharpen the project's domain model as you design. This is the _active_ discipline: challenging terms, inventing edge-case scenarios, and writing the glossary down the moment a term crystallizes. (Merely _reading_ the glossary for vocabulary is not this skill: that is a one-line habit any skill can do. This skill is for when you are changing the model, not just consuming it.)

Paths below are relative to this skill's directory; resolve them to absolute paths before reading.

## Where the model lives

This repository's agent configuration should have been provided to you (the `## Agent skills` block pointing at `docs/agents/`). If it is missing, use the defaults below and suggest the user run the `setup-aclarify-skills` skill.

`docs/agents/domain.md` names the glossary file, its layout, and the decision-record folder. Defaults:

```
/
├── GLOSSARY.md            ← single context (most repos)
├── docs/adr/              ← decision records
└── src/
```

```
/
├── GLOSSARY-MAP.md        ← multiple contexts: indexes them, defines no terms
├── docs/adr/              ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/      ← context-specific decisions
    └── billing/
        └── GLOSSARY.md
```

If a map exists, read it to find the glossary for the context you are in; when the topic's context is unclear, ask. Create files lazily, only when you have something to write: scaffold the glossary when the first term is resolved, never ahead of it. The glossary's format, and how the single and multi-context layouts are told apart, are in [references/glossary-format.md](references/glossary-format.md). Read it before your first write.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in the glossary, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y. Which is it?"

### Challenge your own terms

Hold vocabulary you coined this session to the same standard. It is not ubiquitous language, however settled it feels from inside. Before a coined term reaches a question, an answer, or anything a human reads, do one of three things with it:

1. **Expand it** into plain words.
2. **Gloss it** inline at first use.
3. **Promote it**, rarely: only for a genuine domain concept the humans themselves speak, propose adding it to the glossary here.

Never add session shorthand to the glossary to dodge glossing it. The `conveying-clearly` skill carries this rule for every surface a colleague reads; load it (through your skill tool, `/conveying-clearly`, or by reading its SKILL.md) when it is installed, and hold to the three options above when it is not.

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account': do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible. Which is right?"

### Update the glossary inline

When a term is resolved, update the glossary right there. Don't batch these up: capture them as they happen. (Run from `grill-with-docs`, the order is different: that skill collects terms during the interview and writes them after, with the user's agreement.)

The glossary should be totally devoid of implementation details. Do not treat it as a spec, a scratch pad, or a store for implementation decisions. It is a glossary and nothing else.

### Surface decisions as they crystallize

When a **significant** design decision settles during the session (a boundary, a pattern, a key standard, a chosen approach and the alternative you rejected), note that it looks worth recording and ask. A decision is significant when it is precedent-setting, hard to reverse, or surprising given its trade-off: two of the three is a clear yes, one is a judgment call to raise with the user rather than settle alone. Leave one-off or obvious choices alone.

**Ask; do not write.** A decision record is created only after the user says yes. Collecting two or three candidates and putting them up at a natural pause beats interrupting the modeling each time one surfaces.

On a yes, load the `decision-record` skill (through your skill tool, `/decision-record`, or by reading its SKILL.md); it owns the location, the naming, the shape, and supersession. If it is not installed, write a short record in the decision-record folder: a title stating the decision, then a paragraph giving the context, the decision, why, and the alternative rejected.

### Flag conflicts with recorded decisions

If what the user now wants contradicts an existing decision record, surface it rather than silently overriding: "This contradicts the event-sourced orders decision; worth reopening because…"

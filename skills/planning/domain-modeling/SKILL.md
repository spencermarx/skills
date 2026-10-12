---
name: domain-modeling
description: Build and sharpen a project's domain model while designing. Use when the user wants to pin down a domain's vocabulary or settle what a term means, uses a vague or overloaded word, notices a term being used two ways, says the code and the language disagree, or when a significant design decision surfaces that may deserve a record, and when another skill needs to maintain the domain model. Owns the judgment of which terms matter and whether the language is right. Do NOT use to scaffold, format or restructure the glossary file (use `ubiquitous-language`), merely to read the glossary for vocabulary, or to author the decision record itself (use `decision-record`).
metadata:
  credits: "Adapted from Matt Pocock's domain-modeling skill, https://github.com/mattpocock/skills (MIT)"
---

# Domain modeling

Actively build and sharpen the project's domain model as you design. This is the _active_ discipline: challenging terms, inventing edge-case scenarios, and writing the glossary down the moment a term crystallizes. (Merely _reading_ the glossary for vocabulary is not this skill: that is a one-line habit any skill can do. This skill is for when you are changing the model, not just consuming it.)

## Where the model lives

This repository's agent configuration should have been provided to you (the `## Agent skills` block pointing at `docs/agents/`). If it is missing, use the defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Glossary:** `docs/agents/domain.md` names the file and layout. Default: `GLOSSARY.md` at the repository root, or, when a root `GLOSSARY-MAP.md` exists, the per-context glossary it points at. A repository that already uses `CONTEXT.md` and `CONTEXT-MAP.md` keeps those names. When several contexts exist and the topic's context is unclear, ask.
- **Decision records:** `docs/agents/domain.md` names the folder. Default: `docs/adr/`.

Read the glossary before you challenge any term. If none exists, that is normal: it is created when the first term is resolved, never ahead of it.

## Writing the glossary down

This skill decides what goes in the glossary; the `ubiquitous-language` skill owns how it is written: the file's name and place, its sections, the map, and the links that must change with it. Before your first write in a session, load the `ubiquitous-language` skill (through your skill tool, `/ubiquitous-language`, or by reading its SKILL.md) and write through it.

If `ubiquitous-language` is not installed, write the entry yourself in the existing file's own shape. With no file yet, create the one the configuration names (default `GLOSSARY.md` at the root) with a `# {Context name}` heading, a one- or two-sentence description of the context, and a `## Language` section of entries: the term in bold followed by a colon, a one- or two-sentence definition of what it is, and an `_Avoid_:` line listing the synonyms it replaces. Never overwrite an existing glossary; edit it in place. Anything beyond that (relationships, open questions, a map for several contexts) is the `ubiquitous-language` skill's, so suggest the user install it once a second context appears.

## Which terms earn an entry

- **Only terms specific to this domain.** General programming concepts (timeouts, error types, utility patterns) do not belong, however much the code uses them. Ask: is this unique to the domain, or a general programming concept? Only the former belongs.
- **Only words the domain's people speak.** A term earns an entry because the people who work in this domain use it, not because it was convenient during one design session.
- **Only what the thing is.** The glossary is devoid of implementation detail. It is not a spec, a scratch pad, or a store for implementation decisions; those go in code, docs, or a decision record.

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

When a term is resolved, update the glossary right there, as [Writing the glossary down](#writing-the-glossary-down) describes. Don't batch these up: capture them as they happen. (Run from `grill-with-docs`, the order is different: that skill collects terms during the interview and writes them after, with the user's agreement.)

### Surface decisions as they crystallize

When a **significant** design decision settles during the session (a boundary, a pattern, a key standard, a chosen approach and the alternative you rejected), note that it looks worth recording and ask. A decision is significant when it is precedent-setting, hard to reverse, or surprising given its trade-off: two of the three is a clear yes, one is a judgment call to raise with the user rather than settle alone. Leave one-off or obvious choices alone.

**Ask; do not write.** A decision record is created only after the user says yes. Collecting two or three candidates and putting them up at a natural pause beats interrupting the modeling each time one surfaces.

On a yes, load the `decision-record` skill (through your skill tool, `/decision-record`, or by reading its SKILL.md); it owns the location, the naming, the shape, and supersession. If it is not installed, write a short record in the decision-record folder: a title stating the decision, then a paragraph giving the context, the decision, why, and the alternative rejected.

### Flag conflicts with recorded decisions

If what the user now wants contradicts an existing decision record, surface it rather than silently overriding: "This contradicts the event-sourced orders decision; worth reopening because…"

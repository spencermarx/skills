---
name: grill-with-docs
description: Relentlessly interview the user to settle an ambiguous plan, design or request, then capture what it settled as glossary entries and decision records. Use whenever a request carries a choice you cannot settle alone and one question will not clear it, before building anything, and when the outcome should be written down. Do NOT use when a single question would do, or when nothing needs recording afterwards (use `grill-me`).
metadata:
  credits: "Adapted from Matt Pocock's grill-with-docs skill, https://github.com/mattpocock/skills (MIT)"
---

Two skills, in order.

1. **Grill.** Load the `grill-me` skill (through your skill tool, `/grill-me`, or by reading its SKILL.md) and work it to the end: rounds continue until the frontier is empty and the user confirms you have reached a shared understanding. While it runs, keep a private list of the terms the interview turned on and the decisions it settled. Write none of them yet.
2. **Record.** Load the `domain-modeling` skill (through your skill tool, `/domain-modeling`, or by reading its SKILL.md) and run it over what the interview settled: pin down the terms, and put forward the decisions worth recording.

The order is not a preference. The terms worth pinning down and the choices worth recording are outputs of the interview, not inputs to it. Record while the interview is still running and you capture a position the next round overturns.

## Recording needs a yes

Nothing is written until the user agrees. Once the interview closes, put the candidates to the user in one message: each glossary term with its proposed one-line definition, and each decision as the one-sentence claim its record would make. Ask the user, using your structured-question tool if you have one; otherwise list the candidates numbered in plain text and stop until they reply. Record exactly what they approve, nothing they struck, and nothing they passed over in silence. A decision record goes through the `decision-record` skill when it is installed.

## If a skill is missing

`grill-me` is required; if it is not installed, say so and stop. Without `domain-modeling`, record approved items yourself: write glossary entries through the `context` skill when it is installed, which owns the glossary format; otherwise use these defaults unless the repository's configuration says otherwise.

This repository's agent configuration should have been provided to you (the `## Agent skills` block pointing at `docs/agents/`). If it is missing, use the defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Glossary:** `docs/agents/domain.md` names the file and layout. Default: `GLOSSARY.md` at the repository root, one entry per term: the term in bold, a one- or two-sentence definition of what it is, and an `_Avoid_:` line listing the synonyms it replaces.
- **Decision records:** `docs/agents/domain.md` names the folder. Default: `docs/adr/`, one short file per decision: a title stating the decision, then a paragraph giving the context, the decision, why, and the alternative rejected.

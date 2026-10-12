---
name: ubiquitous-language
description: >-
  Create or edit a repository's glossary file (its name, place, sections and entry
  format) or the glossary map that indexes one file per bounded context. Use whenever a
  glossary file must be scaffolded, written to, restructured or checked: set up the
  glossary, fix its format, add or reword an entry, write or update the glossary map,
  split one context into several, "where do domain terms live", a map row pointing at a
  missing file, or when another skill has a settled term to write down. Owns the format
  and the file. Do NOT use to decide which terms matter, to pin down or settle a
  ubiquitous language, or to judge whether the language is right (use
  `domain-modeling`), or to record a decision (use `decision-record`).
license: MIT
argument-hint: '[the context name, e.g. "Ordering"]'
metadata:
  credits: "Adapted from Matt Pocock's domain-modeling skill, https://github.com/mattpocock/skills (MIT)"
---

# Ubiquitous Language

A glossary is the record of a bounded context's **ubiquitous language**: the
canonical term for each domain concept, what it is, and the words to avoid. It
is a glossary and **nothing else**. Keep it free of implementation detail; it is
not a spec, a scratch pad, or a home for decisions, which are records the
`decision-record` skill owns.

This skill owns the **format and the file**: the file's name and place, its
sections, the map, and keeping links to it intact. It does not decide _which_
terms are worth an entry or when the language is wrong. That judgment is the
`domain-modeling` skill, which loads this one to write the result down.

## Which file

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

`docs/agents/domain.md` names the glossary file, the map file and the layout.
Use the names it gives with the structure below. Without it, resolve the names
in this order:

1. **An existing glossary keeps its name.** A repository may already use
   `CONTEXT.md` and `CONTEXT-MAP.md` for the same two files. When those exist at
   the root, keep using them. Never propose either name for a new glossary, and
   never rename an existing file to match the defaults.
2. **Otherwise the defaults:** `GLOSSARY.md` at the repository root, and for a
   repository with several contexts a root `GLOSSARY-MAP.md` pointing at one
   `GLOSSARY.md` per context.

If both naming schemes exist side by side, ask the user which is current before
writing either: using your structured-question tool if you have one; otherwise
list numbered options in plain text and stop until they reply.

**Single or multi-context** is decided by whether the map exists:

- If the map exists, read it to find the contexts, then the glossary for the
  context the current topic belongs to. When that is unclear, ask.
- If only a root glossary exists, the repository has a single context and needs
  no map.
- If neither exists, create a root glossary when there is a first settled term
  to put in it, or when the user asks for one. Never scaffold an empty one
  ahead of need.

```
/                          ← single context (most repos)
├── GLOSSARY.md
├── docs/adr/
└── src/
```

```
/                          ← several contexts
├── GLOSSARY-MAP.md        ← indexes them; defines no terms
├── docs/adr/              ← system-wide decisions
└── src/
    ├── ordering/
    │   └── GLOSSARY.md
    └── billing/
        └── GLOSSARY.md
```

**When a second context appears**, the repository moves to multi-context: a root
map, and the existing root glossary either moves to its context's folder or
stays at the root as one listed context. That move restructures the repository,
so put it to the user as a proposal and make it only on their yes.

## Never overwrite a glossary

Both files accumulate authored judgment, and both are singletons: one glossary
per context, one map per repository. Before creating either, check whether it
exists. If it does, open it and edit it in place. Starting one over silently
discards the thinking that produced it, and nothing else in the repository
records that thinking.

## Glossary format

```md
# {Context name}

{One or two sentences: what this context is, and the line separating it from
its neighbours.}

## Language

**Order**:
A customer's request to buy, once submitted and accepted.
_Avoid_: purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: bill, payment request

## Relationships

- **Order to Invoice**: an accepted **order** is billed by one **invoice** per delivery.

## Open questions

- A question whose answer would change a definition above.
```

`## Language` is required. `## Relationships` holds how this context's terms
relate to each other; `## Open questions` holds what is not settled yet, so a
definition is not written as if it were. Leave either out until it has a first
line.

Rules for an entry:

- **Be opinionated.** When several words exist for one concept, pick the best as
  the term and list the rest under `_Avoid_`.
- **Keep definitions tight.** One or two sentences. Define what the thing IS,
  not what it does or how the code handles it.
- **`_Avoid_` is for rejected synonyms only**, the other words for this same
  concept. A neighbouring concept that is genuinely different is not a synonym:
  it belongs in the definition, as the distinction it is not.
- **Link rather than restate.** Where another document in the repository already
  defines the term authoritatively (a spec, a standard), give its sense in one
  line and link that document.
- **Group terms under `###` subheadings** inside `## Language` when natural
  clusters emerge; a flat list is fine when they all belong to one area.

Which terms earn an entry at all is `domain-modeling`'s judgment. Called on your
own, admit only terms the people working in this domain actually speak: never
general programming concepts, never shorthand coined during one session.

## Map format

```md
# Glossary Map

## Contexts

- [Ordering](./src/ordering/GLOSSARY.md): receives and tracks customer orders
- [Billing](./src/billing/GLOSSARY.md): generates invoices and processes payments

## Relationships

- **Ordering → Billing**: Ordering emits `OrderPlaced`; Billing consumes it to invoice
- **Ordering ↔ Billing**: shared types for `CustomerId` and `Money`
```

The map **defines no terms**. It lists each context, where its glossary lives,
and what the context owns, then how the contexts relate. Its file name is
load-bearing: this skill and `domain-modeling` decide single versus
multi-context by testing whether it exists.

## Links change together

Adding, moving, renaming or removing a glossary changes, in the same commit:

1. the glossary itself;
2. its row in the map, when the repository has one;
3. every pointer at it: `docs/agents/domain.md` when it names the path or the
   layout, and the agent instructions file (`AGENTS.md` or its equivalent) of the
   owning folder when that file points at the glossary.

Nothing else checks this. Skip one and the glossary still reads as correct while
no agent can reach it, or a pointer leads to a file that is gone.

**Done when** every link you added or touched resolves, and the reverse holds
too: every row already in the map still points at a file that exists.

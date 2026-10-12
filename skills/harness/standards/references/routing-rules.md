# Routing rules

A routing rule is a file a harness loads on its own when a file matching its glob
is read. It is optional, harness-specific, and only ever a pointer: the
convention is stated once, in the conventions folder, and the rule delivers a
link to it at the moment it applies.

## A rule is a pointer

The frontmatter carries a glob and a description, and nothing else that changes
how the rule loads. A key beyond those means the rule is doing more than
routing.

Claude Code, `.claude/rules/<topic>.md`:

```markdown
---
description: Error handling in TypeScript sources
paths:
  - 'src/**/*.ts'
---

# Error handling

- [code § Error handling](../../docs/standards/code.md#error-handling)
```

Cursor, `.cursor/rules/<topic>.mdc`:

```markdown
---
description: Error handling in TypeScript sources
globs: src/**/*.ts
alwaysApply: false
---

- [code § Error handling](../../docs/standards/code.md#error-handling)
```

A Claude Code rule with no `paths:`, or a Cursor rule with `alwaysApply: true`,
loads in every session. That turns a router into an always-on cost and routes
nothing by file; what every session needs belongs in `AGENTS.md` instead. Other
harnesses have equivalents (path-scoped instruction files); the same contract
applies to each.

The body is a heading, an optional trigger line, and one pointer line per section
routed, each labelled `doc § Section` so a reader can tell what it reaches
without following it.

**The trigger line is the only sentence a rule may contain.** It names the moment
the obligation fires ("adding a migration means adding its row to the index, in
the same change"), because a rule that only links cannot tell an agent that
opening this file created an obligation at all. It never states what the rule
says: that is the pointer's job, and a second statement of the rule is exactly
the drift this layer exists to prevent.

Keep rules small. A rule that needs more pointers than fit on a screen is
routing too much, and splits by glob. A rule that fires on every markdown or
every source file is the one most likely to grow into an always-on cost: if it
needs more surface, split it into narrower globs instead of growing it.

## Glob syntax

Use `**`, `*`, `?` and `[abc]` only. Braces, negation and extended globs are
not supported the same way everywhere, and a pattern a harness cannot read
simply matches nothing, which is indistinguishable from a healthy rule.

Write a folder glob as `**/<folder>/**/*.md` so it matches wherever the folder is
nested. **A folder name that occurs at more than one depth is root-anchored
instead**, as `<folder>/**/*.md`: the leading `**` spans intermediate folders,
so an unanchored glob written for one of them also reaches the other. That
failure is worse than a dead glob, because a glob that matches too much routes
the wrong rule at a file and reads as healthy.

Renaming a folder obligates rewriting every glob that names it, in the same
change.

## Glob the trigger, not the target

A rule fires when a file matching its glob is **read**. It cannot fire on a file
that should have been touched and was not, so a glob aimed at the file needing
the edit routes nothing at the moment it matters.

Aim it at the file the agent has open when the obligation arises. If adding a
migration obligates a row in the migrations index, the rule globs the migration
files, where the author is standing when the duty arises, not the index, which
nobody opens until they already remember it.

The test: **name the file an agent must have open for this rule to help.** If
that file is not matched by the glob, the rule is decoration. If no such file
exists, no glob can serve, and the convention belongs under the index's
`## Intentionally unrouted`, with the skill or template that reaches it named as
its consumer.

This is why a convention that fires as a folder is created cannot be routed by
a glob over that folder. The decision is made before there is anything inside it
to read, so the glob fires only after the moment it governs.

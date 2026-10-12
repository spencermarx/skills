# Recording rejections

When an **enhancement** is rejected as `wontfix`, the decision and its reasoning
must outlive the closed issue, for two reasons:

1. **Institutional memory**: why it was rejected, so the reasoning isn't lost
   when the issue is closed.
2. **Deduplication**: when a new issue matches a prior rejection, surface the
   previous decision instead of re-litigating it.

Rejections are recorded in one of **two lanes**, split by the ground of the
rejection, not by who asked.

## The tie-breaker

> **If the technical constraints vanished tomorrow, would we still say no?**

- **Yes**: a **scope** rejection. The project simply isn't this, whatever the
  feasibility. Record it in the out-of-scope folder.
- **No**: an **engineering** rejection. We would build it, but the
  architecture, the cost, or a chosen alternative forbids it. Record it as a
  decision record.
- **Both grounds**: the out-of-scope file is the outward face, and it links the
  decision record that holds the technical grounds.

## Scope lane: the out-of-scope folder

The folder is `.out-of-scope/` at the repository root unless the agent
instructions name another. One file per **concept**, not per issue: several
issues requesting the same thing group under one file.

```
.out-of-scope/
├── dark-mode.md
├── plugin-system.md
└── graphql-api.md
```

Name the file in short kebab-case that someone browsing the folder recognizes
without opening it. Write it in a relaxed, readable style, more like a short
design note than a database entry: paragraphs, and a code sample where it makes
the reasoning clearer.

```markdown
# Dark Mode

This project does not support dark mode or user-facing theming.

## Why this is out of scope

The rendering pipeline assumes a single color palette defined in
`ThemeConfig`. Supporting multiple themes would require a theme provider
wrapping the whole component tree, per-component theme-aware styles, and a
persistence layer for user preferences. That is a significant architectural
change that doesn't serve the project's focus on content authoring; theming is
a concern for downstream consumers who embed the output.

## Prior requests

- #42: "Add dark mode support"
- #87: "Night theme for accessibility"
```

The reason must be substantive and durable: project scope or philosophy,
technical constraints, a strategic choice. Never a temporary circumstance ("we're
too busy right now"): a temporary "no" is a **deferral**, roadmap material, and
is not recorded here.

## Engineering lane: decision records

An engineering-grounded rejection settles an "X versus Y" choice and sets
precedent, so it is a decision record, titled as the decision ("Do not adopt X;
use Y instead"), in the decision folder `docs/agents/domain.md` names (default
`docs/adr/`). Write it through the `decision-record` skill when it is installed
(through your skill tool, `/decision-record`, or by reading its SKILL.md);
otherwise one short file: the decision as its title, then a paragraph giving the
context, the decision, why, and the alternative rejected.

When a duplicate request arrives later, close it pointing at the record, and
append the new issue's link to the record as a one-line amendment.

## The dedup pass

During triage's Gather context step, before recommending, check all of:

- The out-of-scope folder: read every file.
- The decision records, in two passes: titles first, then bodies. A rejection
  often lives inside an adoption record's context ("build X **instead of**
  adopting Y"), so titles alone under-match. Read any hit before surfacing it.
- Closed issues carrying the `wontfix` label, searched by concept. These are
  precise by construction, because the label is applied to genuine rejections
  only: built, underway and deferred work closes without it.

Match by **concept similarity, not keyword**: "night theme" matches
`dark-mode.md`. On a match, surface it to the maintainer: "This resembles
[record]; we ruled it out because [reason]. Do you still feel the same way?"

The maintainer may:

- **Confirm**: append the new issue to the record's prior requests, then close
  it.
- **Reconsider**: the record is updated or retired (the out-of-scope file
  deleted, or the decision record superseded), and the issue proceeds through
  normal triage.
- **Disagree**: related but distinct; proceed with normal triage.

## When to write

Only when an **enhancement** (not a bug) is _rejected_ as `wontfix`. This
applies to enhancement PRs exactly as to issues: a rejected PR is recorded so
the same request doesn't return as fresh code.

Do **not** write a rejection record when something closes because it is
**already implemented** (point at the spec or the code), **already underway**
(point at the PR or change), or **deferred** (point at the roadmap). Recording
built or postponed work as rejected poisons the dedup pass with false
rejections.

The flow:

1. The maintainer decides the request is out of scope; apply the tie-breaker to
   pick the lane.
2. Run the dedup pass for an existing record.
3. If one exists, append the new issue to its prior requests.
4. If not, write the record: an out-of-scope file, or a decision record.
5. Post a comment on the issue explaining the decision and linking the record.
6. Close it as not planned, with the `wontfix` label.

## Changing course

If the maintainer reverses a prior rejection, retire the record: delete the
out-of-scope file, or supersede the decision record. Old issues stay closed as
historical record; the new issue that triggered the reconsideration proceeds
through normal triage.

---
name: clean-comments
description: >-
  Audit and repair EXISTING code comments so each says what the code cannot (intent,
  rationale, invariants, units, gotchas) and none restates it: delete restatement, banners
  and commented-out code, fix stale or wrong comments, sharpen bloated ones. Use whenever
  the user asks to clean up, audit, review or fix comments, remove redundant or obvious
  comments, tidy doc comments or docstrings, strip commented-out code, "make comments
  follow Ousterhout", or improve comment quality across a file, a directory, or a
  changeset (staged diff, commit range, PR), even if they only say "the comments need
  work". Do NOT use for comments on code you are writing right now (use `write-comments`).
license: MIT
argument-hint: '[optional: files, a directory, or "staged" / a commit range / a PR to scope to]'
metadata:
  credits: "Ideas from John Ousterhout's A Philosophy of Software Design"
---

# Clean Comments

Clean up code comments so each one earns its place. The standard is John
Ousterhout's, from _A Philosophy of Software Design_: code is the description of
_what happens_; a comment exists to capture the things the code **cannot** say.
A comment that just restates the code adds reading cost and zero information, and
drifts out of date. Removing it is an improvement, not a loss.

This is the audit-time half of the contract; `write-comments` is the write-time
half. This skill changes comments (and, when low-risk, names). It must not change
behavior.

## House conventions, if the repository has them

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Conventions folder** (`docs/agents/workspace.md`). Default: none. If one is
  configured and holds a comment or code-style convention, read it first: where
  it is stricter or more specific than this skill, it wins.

## The one test for every comment

> Does this comment tell a competent reader something the code itself does not
> already make obvious?

If yes, keep it (sharpen it if it is verbose or pitched too low). If no, delete
it. "Obvious" is judged against the actual code in front of you and a reader
fluent in the language, not against a beginner.

## What good comments carry (KEEP / SHARPEN these)

These hold information that is genuinely absent from the code:

- **Why, not what.** The reason a thing is done this way: the tradeoff, the
  constraint, the bug being avoided, the spec or rule being honored.
- **Intent at a higher abstraction.** One line that says what a block
  accomplishes, so a reader does not have to reverse-engineer it from the
  statements. Comments should sit _above_ the code's level of abstraction.
- **Interface contracts.** For an exported function or type: what it does for
  the caller, the meaning of params and return, side effects, thrown errors, and
  preconditions. Written for someone who will not read the body.
- **Invariants, units, ranges, and non-obvious consequences.** "milliseconds",
  "caller must hold the lock", "must stay in sync with X", "0 means unbounded".
- **Gotchas and cross-references.** "load-bearing: removing this breaks Y",
  "mirrors the values in Z", links to a ticket, spec or decision record.

When such a comment is correct but bloated, repeats the code partway, or narrates
line by line, **SHARPEN** it: keep the signal (the why, intent, contract), cut the
restatement, raise it to the right abstraction level.

## What to REMOVE

- **Restatement of the code.** `// increment i` over `i++`; `// the user` over a
  `user` variable; `// loop over items` over an obvious `for (const item of …)`;
  a JSDoc `@param userId The user id` that adds nothing past the typed signature.
- **Name-echo doc comments.** A doc comment that only re-says the identifier it
  sits on: `/** Smooth-scroll configuration. */` over `const SMOOTH_SCROLL = …`,
  `/** The locale list. */` over `LOCALES`, `/** scrub */` over `scrub: 0.6`. The
  name already says it. Keep only if the comment adds a contract, units, range,
  or why the value is what it is.
- **Decorative banners and section dividers.** `/* ---- Colors ---- */`,
  `// ===== Helpers =====`, box-drawing separators. They are navigation noise;
  structure and grouping should carry this, not ASCII art.
- **Commented-out code.** Version control already remembers it.
- **Changelog and attribution narration in code.** "Added by … on …",
  "TODO(2019): refactor" with no actionable content. Keep actionable TODOs that
  name a real follow-up; consider tightening them.
- **Stale or wrong comments** that no longer match the code. They mislead human
  readers and derail agents that act on them. Removing a lie beats keeping it;
  replace it with a correct comment only if the corrected version passes the one
  test above.

## Be thorough, not timid

Ousterhout is _pro_ good comments (especially interface comments and "why"); the
goal is not the fewest comments, it is comments that all pull their weight. But do
not let "it might be useful" preserve noise. Two specific habits to correct:

- **Trim multi-line headers to the signal.** A 5-line file or function header
  that carries one real idea should become 1-2 lines. Keep the why and the
  contract; cut the wind-up, the restatement of the name, and the "this file
  contains…" preamble. A header is not a place to relax the one test.
- **Default to REMOVE for the name-echo and banner patterns above.** These are
  the comments that most often survive a timid pass. If your summary shows almost
  nothing removed across many files, re-read with a sharper eye: real codebases
  written quickly almost always carry some restatement and some banners.

The bar is unchanged (does it say something the code does not), but apply it
without flinching.

## Never touch these (load-bearing, machine-read, or legal)

Treat as untouchable even when they look like "just a comment":

- Linter and tool directives: `eslint-disable*`, `// @ts-expect-error`,
  `// @ts-ignore`, `// @ts-nocheck`, `biome-ignore`, `prettier-ignore`,
  `// istanbul ignore`, `/* c8 ignore */`, `# type: ignore`, `# noqa`,
  `# pragma`, `// deno-lint-ignore`, and the like.
- Codegen and tooling markers: `@generated`, region markers a tool consumes,
  OpenAPI or JSDoc annotations a build step reads.
- Shebangs (`#!/usr/bin/env node`), license and copyright headers, SPDX tags.
- JSX comments `{/* … */}` that affect what renders, and HTML conditional
  comments.
- Anything whose removal could change compilation, linting, bundling, or output.

If unsure whether a comment is load-bearing, keep it: the cost of a wrong
deletion here far exceeds the cost of a surviving comment.

## Names over comments

When a comment exists only to explain what an unclear name means
(`// elapsed time in ms` over `let t`), the better fix is the name itself
(`let elapsedMs`). Prefer the rename when it is local and low-risk (a local
variable, a private helper, a parameter), apply it, and drop the crutch comment.
For anything exported or widely referenced, do **not** rename silently: flag it
as a suggested rename in the report and leave the comment until the rename is
made deliberately, because the blast radius is the user's call. A rename is the
only non-comment edit this skill may make, and only when it is safe and
behavior-preserving.

## Workflow

1. **Resolve the target.** One of:
   - a changeset: `git diff --staged --name-only` (or `git diff --name-only`, a
     commit range, or a PR the user names);
   - an explicit list of files; or
   - a directory (walk it for source files).

   With no scope given, ask the user which, using your structured-question tool
   if you have one; otherwise list numbered options in plain text and stop until
   they reply. Review only source files with comment syntax. Skip lockfiles,
   generated output, vendored code, binaries, and dependency folders such as
   `node_modules`. Review only the files in scope, not the whole repository,
   unless asked.

2. **Read each file fully before editing.** Context decides whether a comment is
   obvious or load-bearing. Be language-aware about comment syntax:
   `//` and `/* */` (TS/TSX/JS/CSS/Java/Go/Rust/C), `#` (YAML/Python/shell/TOML),
   `<!-- -->` (Markdown/HTML), `{/* */}` (JSX), `--` (SQL/Lua). In CSS, `/* */`
   is the only form; in Markdown, prose is the content, so only touch HTML-comment
   cruft, not the document body.

3. **Classify every comment** as KEEP, SHARPEN, or REMOVE using the rules above.
   For name-compensating comments, decide RENAME (safe and local) or FLAG
   (exported).

4. **Apply the edits.** Comments only, plus safe local renames. Make minimal,
   surgical changes; do not reflow unrelated code. Preserve the file's existing
   comment style and indentation.

5. **Verify you changed nothing that runs.** Read the diff back: it should be
   comments and, at most, safe renames. If a "comment" turned out to be a
   directive, revert it.

## Style for any comment you write or sharpen

- Plain, direct, lower-jargon. Say the why in as few words as carry it.
- No false precision; use ranges where uncertainty is real.
- Match the file's existing comment style, and the conventions folder where one
  is configured.

## Report

After editing, output a concise summary so the user can see what changed and why.
End with this structure:

```
## Comment cleanup summary

| File | Kept | Sharpened | Removed | Renames |
|------|-----:|----------:|--------:|--------:|
| path/to/file.ts | 4 | 1 | 3 | 1 |
| ... | | | | |
| Total | N | N | N | N |

### Notable changes
- path/to/file.ts: removed 3 restatement comments; sharpened the header to state
  the "why" and dropped the line-by-line narration.

### Suggested renames (not applied: exported / wide blast radius)
- path/to/api.ts:42 `t` -> `elapsedMs` (exported; rename deliberately)

### Untouched directives (left intact on purpose)
- path/to/config.ts: `@ts-expect-error` on the untyped plugin import
```

If there were no comments worth changing in a file, say so rather than inventing
work. The goal is comments that pull their weight, not the fewest comments.

---
name: atomic-commits
description: >-
  Split a mixed changeset into a sequence of atomic conventional commits, present the plan,
  then make the commits. Use whenever someone says commit this, split this into atomic
  commits, break these changes up, tidy my commit history, or asks for conventional commit
  messages across work touching several concerns. Do NOT use when one cohesive change needs
  one message; write that message directly.
license: MIT
---

# Atomic commits

Turn what is staged into an ordered series of commits that each carry a single
cohesive change, named by [Conventional Commits](https://www.conventionalcommits.org).

Committing is the user's call. This skill runs because they asked, so it plans
first, shows the plan, and commits only once they agree. It stays on the current
branch, and it does not push, amend, or rebase.

## Read the index

1. Run `git status --porcelain` and `git diff --staged --name-only`. An empty
   index ends the run: report it and offer to stage, rather than staging.
2. A file in both lists is **partially staged**, and re-adding it later would
   sweep unstaged hunks into a commit nobody reviewed. Name those files and ask
   the user whether to commit them whole or hold them back, using your
   structured-question tool if you have one; otherwise list numbered options in
   plain text and stop until they reply.
3. Run `git diff --staged > "$(git rev-parse --git-dir)/atomic-commits.patch"`.
   If the sequence goes wrong, `git apply --cached` on that file restores the
   index.

## Plan

1. Read `git diff --staged` in full. Group hunks by concern rather than by
   directory: one commit per thing a reviewer would want to read on its own.
2. Order them so each commit leaves the tree buildable. Dependencies first, the
   change that consumes them second, tests and cleanup last.
3. Show the user a numbered list of subject lines with the files under each,
   and get their agreement before executing. A file under two commits, or under
   none, is a planning defect: resolve it first.

## Execute

Per commit, in order: `git reset`, then `git add -- <explicit paths>` (`-A` and
`.` defeat the plan), then `git diff --staged --name-only` to confirm the match,
then `git commit`.

Afterwards, restage anything the plan excluded so the index ends where the
user left it, and read the sequence back with `git log --oneline`.

## Message form

```
<type>(<scope>)!: <description>

<body>

BREAKING CHANGE: <what breaks and what to do instead>
```

- **Types**: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`,
  `style`, `chore`, `revert`. `feat` and `fix` are the only two the spec defines;
  the rest are the Angular set that everything downstream expects.
- **Scope** names the affected area (`scheduler`, `api`, `ui`), in parentheses,
  and is omitted when the change is repository-wide.
- **Description** is imperative mood, lowercase, no trailing period, under about
  50 characters: "add address autocomplete", not "added" or "adds".
- **Body** is optional and explains why, not what. The diff already says what.
- **Breaking changes** take `!` before the colon, a `BREAKING CHANGE:` footer, or
  both. A breaking change is never left to the body to imply.

Where the repository's history uses a different vocabulary, follow the history.
`git log --oneline -n 30` shows what is already in use, and a sequence that
disagrees with everything above it reads as a mistake. The same goes for any
trailers the repository asks commits to carry: follow its instructions.

## A worked sequence

```
feat(scheduler): add address autocomplete to new customer form
fix(scheduler): resolve phone validation edge case
refactor(scheduler): extract address validation utility
test(scheduler): cover address validation
```

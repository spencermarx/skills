---
name: scratchpad
description: >-
  Create, find, and reclaim ephemeral, git-ignored working artifacts in the repository's
  one scratch folder (`.scratchpad/` by default): handoffs, research dumps, generated
  reports, debug output. Reach for it WHENEVER you are about to write a temporary file that
  must not be committed, instead of an ad-hoc `tmp/` or a stray `notes.md`. Also to list
  prior entries or clean up old ones. Do NOT use for durable tracked artifacts (docs,
  decision records, source): those belong under version control.
license: MIT
compatibility: Requires bash and git. Works on macOS (BSD) and Linux (GNU) userlands.
argument-hint: '[new|place|list|clean|root] <args>'
---

# scratchpad

A domain-opaque primitive that owns one thing: where ephemeral, git-ignored
working artifacts live. It answers *where* a piece of scratch goes, *how* it is
named, and *when* it is reclaimed. It knows nothing about what any artifact
means.

It exists because sessions constantly produce working files, and left to habit
those scatter into `tmp/` and stray notes at the repository root, where they
land in search results and editors' file trees, and scratch becomes
indistinguishable from the project's real documents.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

## Where the scratch folder is

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Scratch folder:** the one `docs/agents/workspace.md` names. Default:
  `.scratchpad/` at the repository root.

When the configured folder is anything other than `.scratchpad/`, pass it as
`--dir '<folder>'` ahead of the verb on **every** call (or export
`SCRATCHPAD_DIR` once). The folder is relative to the repository's top; the
script refuses an absolute path or one that climbs out of the tree. Below,
`.scratchpad/` means whichever folder that resolves to.

## The one rule: it returns a directory, you write the file

`scratchpad new` creates and prints a **directory**. The caller writes its own
files inside.

The primitive never authors the document, so it can never drift as document
formats evolve, and each caller pins its own discoverable filename. The
`handoff` skill writes `HANDOFF.md`; a research burst writes `00-summary.md` and
its receipts.

When you cannot write into the entry directly, `place` moves in a file you
authored elsewhere. It never looks inside the file, so the rule above still
holds. You need it more often than you would expect: some harnesses lock a
background session out of the main checkout, and every entry lives there. See
[references/writing-into-a-locked-entry.md](references/writing-into-a-locked-entry.md).

`<domain>` is an opaque label you choose: `handoffs`, `research`, `reports`,
`debug`. Keep it `[a-z0-9][a-z0-9-]*`.

## One root

There is exactly one scratch folder, at the top of the main checkout. Calling
from a linked worktree writes to that same root rather than a worktree-local
copy, for two reasons learned the hard way: `git worktree remove` deletes ignored
files without complaint, so worktree-local scratch dies when its branch merges;
and per-worktree roots partition `list`, which defeats the one job this exists to
do.

## Usage

No build step and no dependencies beyond bash and git. Two rules, both because
the obvious form fails.

**Call it by absolute path.** Resolve this skill's directory and run
`<skill dir>/scripts/scratchpad.sh`, pasting the path literally in single
quotes. A path relative to the repository resolves only from the repository
root, so the same command fails from a subdirectory or from a subagent whose
working directory is pinned elsewhere.

**One plain command at a time. Never wrap a call in `$(…)`.** Some sandboxed
sessions refuse any shell command they cannot statically verify, and command
substitution is exactly that, so the tidy `dir="$(… new …)"` form fails outright
there. Read the absolute path the verb prints out of the command output and
paste it literally into the next call. That works in every session, so there is
one form to remember rather than two.

```bash
bash '<skill dir>/scripts/scratchpad.sh' new research 'competitor pricing sweep'
#   -> <root>/.scratchpad/research/20260818-143512-competitor-pricing-sweep

# Write 00-summary.md into the directory it printed. If that write is refused,
# author the file outside the repo and move it in:
bash '<skill dir>/scripts/scratchpad.sh' place \
  '<the printed directory>' 00-summary.md /abs/path/to/drafted-summary.md

bash '<skill dir>/scripts/scratchpad.sh' list research  # newest-first; omit for all
bash '<skill dir>/scripts/scratchpad.sh' root           # name the root
bash '<skill dir>/scripts/scratchpad.sh' clean research --older-than 14d  # --force deletes

# A repository configured with another scratch folder:
bash '<skill dir>/scripts/scratchpad.sh' --dir '.scratch' new research 'pricing sweep'
```

- **`new <domain> <slug>`** creates `<root>/.scratchpad/<domain>/<UTC-YYYYMMDD-HHMMSS>-<slug>/`
  and prints its absolute path. The slug is slugified and capped around 50
  characters; exact collisions get a numeric suffix. Guarantees the scratch
  folder is git-ignored, through the repository's own `info/exclude` rather than
  the tracked `.gitignore`.
- **`place <entry-dir> <filename> <source-file>`** moves an already-written
  `<source-file>` into `<entry-dir>` under `<filename>`, and prints the final
  absolute path. `<entry-dir>` must be a directory `new` printed. It refuses a
  filename that is not bare, an entry that is the root or a bare domain or
  outside the root entirely, a symlinked source, and any write that would
  overwrite what is already there.
- **`list [<domain>]`** prints entry directories newest-first, one absolute path
  per line. The timestamp prefix makes this a plain reverse sort.
- **`root`** prints the root. It names, it never creates. Use it to tell a human
  or a subagent where scratch lives. Entries still come from `new`, which owns
  the timestamp, the slug, and collision handling. Do not hand-build a path from
  `root`.
- **`clean [<domain>] --older-than <age> [--force]`** reclaims entries older than
  `14d`, `12h`, `30m`, or `0d` for everything. Dry-run unless `--force`. Never
  runs automatically.

Outside a git repository every verb refuses with a message rather than guessing
a location.

## Use the path the script printed

Every verb prints absolute paths, and each of these has already produced a
wrong-place write somewhere. **Never write a bare `.scratchpad/...` path**: it
resolves against the current directory, so from any subdirectory it silently
creates a second orphaned pile. **Report the absolute path back**, and **pass it
to subagents**, whose working directory may be pinned somewhere else entirely.

Quote every path: a repository path may contain spaces. Entry names are
slug-safe, so newline-delimited pipelines over `list` stay correct.

## What belongs here

Local, disposable, never committed: handoffs, research dumps, generated reports,
debug output. Because it is git-ignored it is also the right place for working
material carrying sensitive context.

Local also means local to this machine. Scratch survives reboots but never
reaches a teammate or another checkout, so it can hold working content but never
the authority for resuming work. Anything durable belongs under version control.

## Composed by other skills

This is a substrate. `handoff` calls `scratchpad new handoffs` and owns the file
it writes inside; `create-report` opens `reports` entries the same way. When you
build a flow that emits working artifacts, compose this rather than inventing
another location.

## Maintaining it

`scripts/scratchpad.sh` is bash: pure filesystem plumbing, portable across BSD
and GNU userlands, zero dependencies. Its smoke suite lives in this skill's
source repository, not in the installed skill: a create-list-clean roundtrip,
every `place` guard, the rooting guarantees and the configurable folder. Keep
both shellcheck-clean where shellcheck is installed; `bash -n` is the floor when
it is not.

When you add a check, mutate the code to prove it fails before trusting it. The
bug that suite was extended for survived eighteen green checks, because none of
them could see it.

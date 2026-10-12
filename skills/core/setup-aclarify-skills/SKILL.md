---
name: setup-aclarify-skills
description: "Configure this repository for the Aclarify skills: where issues, the glossary, decision records and scratch files live, then check and install the tools some skills need, such as the ocr CLI for code review. Run once per repository before first use, and again with `check` to re-verify the tooling."
disable-model-invocation: true
argument-hint: "[check]"
license: MIT
metadata:
  credits: "Adapted from Matt Pocock's setup-matt-pocock-skills, https://github.com/mattpocock/skills (MIT)"
---

# Setup Aclarify Skills

Writes the per-repository configuration the other skills read, and gets the
tools they depend on installed:

- **Issue tracker:** where issues live (GitHub by default; GitLab and local markdown supported).
- **Triage labels:** the label string for each triage role, when `triage` is installed.
- **Domain docs:** the glossary file and layout, and where decision records go.
- **Workspace:** the scratch folder, an optional conventions folder, eval cases, code review.
- **Tools:** the `ocr` CLI and its per-repository init, plus `gh`/`glab` where the tracker needs them.

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything. Commands that inspect the repository run from the
repository root.

This is a prompt-driven skill. Explore, present what you found, confirm with the
user, then write. With the argument `check`, run only step 1's tooling check and
step 2's Section E, and change nothing else.

## 1. Explore

Read what exists; assume nothing.

- `git remote -v`: GitHub, GitLab, another host, or none?
- `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` at the root: which exist, whether one
  is a symlink to another, whether `CLAUDE.md`/`GEMINI.md` already import
  `@AGENTS.md`, and whether an `## Agent skills` section exists in any of them.
- `docs/agents/`: this skill's earlier output.
- Glossary files at the root: `GLOSSARY.md`, `GLOSSARY-MAP.md`, `CONTEXT.md`, `CONTEXT-MAP.md`.
- Decision folders: `docs/adr/`, `docs/decisions/`, `decisions/`, and `src/*/docs/adr/`.
- Scratch folders: `.scratchpad/`, `.scratch/`; whether `.gitignore` covers them.
- `.ocr/` and `.evals/`.
- Which of this catalog's skills are installed, by name in your available skills
  or as sibling skill folders: in particular `triage`, `wayfinder`,
  `ocr-review-loop`, `harness-eval`, `watch-ci`. A section for an uninstalled
  skill is skipped.
- Monorepo signals: `pnpm-workspace.yaml`, a `workspaces` field in
  `package.json`, `nx.json`, or a populated `packages/*` with its own sources.
- Tooling: run `scripts/doctor.sh` from the repository root and keep its output.

## 2. Present findings and ask

Summarise what is present and what is missing, then take the sections in order:
one section, one answer, then the next. Lead each with the recommended answer so
the user can accept it in a word. Skip a section when exploration already
settled it. To ask, use your structured-question tool if you have one;
otherwise list numbered options in plain text and stop until the user replies.

**Section A: Issue tracker.** Skills such as `wayfinder`, `triage` and
`to-questionnaire` read from and write to it, so they need to know whether to
call `gh issue create`, `glab issue create`, write a markdown file, or follow
another workflow. Propose GitHub when the remote is GitHub and GitLab when it is
GitLab. Otherwise offer:

- **GitHub:** issues in the repository's GitHub Issues, through `gh`.
- **GitLab:** issues in GitLab Issues, through `glab`.
- **Local markdown:** issue files under `.scratch/<feature>/`, committed with the
  repository so the whole team sees them. This is not the git-ignored scratch
  folder of Section D, which holds one person's working files.
- **Other** (Jira, Linear, …): the user describes the workflow in a paragraph,
  recorded as prose.

The GitHub and GitLab templates carry a "PRs as a request surface" flag,
defaulted off. Leave it off and don't raise it.

**Section B: Triage labels.** Only when `triage` is installed. Ask exactly one
question: keep the default labels (`needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`)? Recommended: yes. On no,
collect the overrides so `triage` applies existing labels rather than creating
duplicates.

**Section C: Domain docs.** Default to single-context: one glossary file at the
root and one decision folder. If a glossary or decision folder already exists,
propose keeping its name and location (a repository with `CONTEXT.md` keeps
`CONTEXT.md`); otherwise `GLOSSARY.md` and `docs/adr/`. Offer multi-context (a
root map file pointing at one glossary per context) only when exploration found
monorepo signals.

**Section D: Workspace.** Propose, in one message:

- Scratch folder `.scratchpad/` (or the one that exists), added to `.gitignore`.
- Conventions folder: none, unless one exists (`docs/standards/`,
  `docs/engineering/standards/`, `CONVENTIONS.md`).
- Eval cases `.evals/cases/`, only when `harness-eval` is installed.
- Checks before commit: the command `AGENTS.md`, the contributing guide or CI
  already runs (`npm test`, `make check`, …), if exactly one is evident.
- Code review: Open Code Review, only when `ocr-review-loop` is installed.

**Section E: Tools.** From the doctor output, list each `missing` or `outdated`
tool that an installed skill needs, with the reason and the exact install
command. Ask once which to install. Then, for each the user agreed to:

- `ocr`: run `scripts/doctor.sh install ocr`.
- OCR in this repository (`ocr-init` missing): ask which agent tools to
  configure, recommending the one you are running in plus any whose config
  folder exists (`.claude/`, `.codex/`, `.cursor/`, `.gemini/`, `.github/`,
  `.opencode/`, `.windsurf/`). Run `scripts/doctor.sh init-ocr <ids>` with the
  comma-separated ids the doctor output lists.
- `gh`, `glab`, Node.js: show the install line; the user runs it. `gh auth login`
  is always the user's to run.

If an install fails, print the command for the user to run and carry on with
the rest. Re-run `scripts/doctor.sh` at the end and show the result.

## 3. Confirm

Show the user a draft of:

- the `## Agent skills` block (step 4);
- `docs/agents/issue-tracker.md`, `docs/agents/domain.md`,
  `docs/agents/workspace.md`, and `docs/agents/triage-labels.md` when Section B ran.

Let them edit before anything is written.

## 4. Write

**The instructions file.** `AGENTS.md` holds the block, because every harness
reads it or can import it.

- If `AGENTS.md` exists, edit it.
- If only `CLAUDE.md` exists, ask whether to create `AGENTS.md` (recommended)
  or put the block in `CLAUDE.md`. Codex and Cline do not read `CLAUDE.md`.
- If neither exists, ask which to create; recommend `AGENTS.md`.
- When `AGENTS.md` holds the block and `CLAUDE.md` exists but neither is a
  symlink to the other nor imports it, add a line `@AGENTS.md` to `CLAUDE.md`.
  Do the same for `GEMINI.md`.

If an `## Agent skills` section exists, update it in place. Never touch the
surrounding sections.

```markdown
## Agent skills

### Issue tracker

[one line: where issues are tracked]. See `docs/agents/issue-tracker.md`.

### Triage labels

[one line: the label vocabulary]. See `docs/agents/triage-labels.md`.

### Domain docs

[one line: single- or multi-context, glossary file, decision folder]. See `docs/agents/domain.md`.

### Workspace

[one line: scratch folder, conventions folder, code review]. See `docs/agents/workspace.md`.
```

Include `### Triage labels` only when Section B ran.

**The docs files.** Write them from the seed templates, adjusting names and paths
to the answers:

- `templates/issue-tracker-github.md`, `templates/issue-tracker-gitlab.md`,
  `templates/issue-tracker-local.md`: the chosen tracker. For "other", write
  `docs/agents/issue-tracker.md` from the user's description.
- `templates/triage-labels.md`: only when Section B ran.
- `templates/domain.md`: replace `GLOSSARY.md`, `GLOSSARY-MAP.md` and
  `docs/adr/` with the chosen glossary file, map file and decision folder.
- `templates/workspace.md`: drop the lines for skills that are not installed.

When Section B ran on GitHub or GitLab, create each configured label the tracker
lacks (`gh label create` / `glab label create`).

Add the scratch folder to `.gitignore` when it is not covered.

## 5. Done

Tell the user which skills now read which file, the final tooling status, and
anything left for them to run themselves. They can edit `docs/agents/*.md`
directly later; re-running this skill is only needed to switch trackers, install
tools, or start over.

---
name: ocr-review-loop
description: >-
  Drive a pull request to an approved code review by looping Open Code Review's review
  and address steps until the verdict is APPROVE, posting every round to the PR as
  comments. Use when someone says review and address in a loop, iterate review until
  approved, auto review-and-fix this PR, loop the OCR review and address, or take a
  changeset all the way to a clean APPROVE. Needs a feature branch with an open GitHub PR.
  Do NOT use for a single review with no fixing (run OCR's review directly), or to
  address one existing review (run OCR's address directly).
license: MIT
argument-hint: '[pr] [--team <spec>] [--max-rounds N] [--no-final-suggestions] [--no-post]'
compatibility: Requires git, the Open Code Review CLI (ocr, Node.js 22.5 or later) initialised in the repository, and, unless --no-post, an authenticated gh CLI.
---

# OCR Review-to-Approval Loop

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

Orchestrates an autonomous **review → address → re-review** loop on a pull
request, using Open Code Review's multi-agent review pipeline, until the review
reaches an **APPROVE** verdict, then runs one final address pass for leftover
suggestions. Every review and every address round is posted to the PR as a
comment, producing a transparent, reviewable audit trail.

```
OCR review  →  post review to PR  →  verdict?
                                       ├─ APPROVE          → final OCR address (suggestions) → done
                                       ├─ NEEDS DISCUSSION → stop, ask the user
                                       └─ REQUEST CHANGES  → OCR address (fix + verify + commit + push)
                                                             → post address comment → re-review
```

It is a thin **orchestrator** over two OCR steps it does not reimplement:

- **Review**: the 8-phase multi-agent review that emits a verdict.
- **Address**: corroborate a review's feedback against the code, then implement.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Code review** (`docs/agents/workspace.md`). Default: Open Code Review, with
  reviewer teams in `.ocr/config.yaml`. Run OCR's review as the `/ocr:review`
  command, or, in a harness without that command, by reading
  `.ocr/commands/review.md` and following it. OCR's address step is the matching
  `/ocr:address`, or `.ocr/commands/address.md`. If the configured system is not
  OCR, this loop does not apply: tell the user and stop.

## Check the dependencies first

1. **The `ocr` CLI.** Run `command -v ocr` and check `.ocr/` exists in the
   repository root. If either is missing, ask the user before installing, using
   your structured-question tool if you have one; otherwise list numbered options
   in plain text and stop until they reply. Offer:
   1. Load the `setup-aclarify-skills` skill (through your skill tool,
      `/setup-aclarify-skills`, or by reading its SKILL.md), which installs and
      initialises the tools these skills use.
   2. Install directly: `npm i -g @open-code-review/cli`, then `ocr init` in the
      repository (pass `--tools <your agent's id>` to skip its prompt).

   Run the commands only after the user agrees. If a command fails, print it for
   the user to run. When setup looks off, `ocr doctor` diagnoses it.
2. **The `gh` CLI**, unless `--no-post`: `gh auth status` must pass. If `gh` is
   missing, ask before installing it (`brew install gh`, or
   https://cli.github.com); the user runs `gh auth login` themselves.

## Arguments

```
ocr-review-loop [pr] [--team <spec>] [--max-rounds N] [--no-final-suggestions] [--no-post]
```

- `pr` (optional): PR number. Default: the open PR for the current branch.
- `--team <spec>` (optional): reviewer team override (`reviewer-id:count,...`),
  forwarded to the review; it replaces the default team for this run.
  **Default: the project's default team** (`ocr team resolve`). The catalog's
  default, which `setup-aclarify-skills` writes, is one principal and one
  architect, at most two reviewers.
- `--max-rounds N` (optional): safety cap on review rounds. **Default: 5.** The
  loop never runs forever.
- `--no-final-suggestions` (optional): stop at APPROVE; skip the final
  suggestions pass.
- `--no-post` (optional): run locally; do not post to GitHub. Present the trail
  in the conversation instead.

---

## The loop

> Execute this inline, to completion, in the conversation. Do not schedule across
> turns or background the work. Drive each review's phases 4→7 within one turn
> (OCR's "don't strand the pipeline" rule). Read `references/loop-mechanics.md`
> for the exact CLI and session details and the PR comment templates.

**0. Preconditions.** Resolve the PR and branch; refuse to run on the default
branch. Confirm the dependencies above. Resolve the reviewer team (default unless
`--team`).

**1. Review-address loop.** Starting at `round = 1`, while the verdict is not
`APPROVE` and `round <= max-rounds`:

1. **Review**: run OCR's review (default team, or `--team`). It runs the full
   pipeline and finalizes `rounds/round-{round}/final.md` and `round-meta.json`
   with a `verdict`. From round 2, brief it as a re-review (see the guardrails).
2. **Post the review** to the PR, headed `OCR review, round {round}`. _(skip if
   `--no-post`)_
3. **Gate on the verdict** (read it from `round-meta.json`, or `final.md`):
   - **`APPROVE`**: exit the loop (go to step 2 below).
   - **`NEEDS DISCUSSION`**: **stop the loop.** This is a human gate: surface the
     clarifying questions to the user and await direction. Do **not** fabricate a
     fix.
   - **`REQUEST CHANGES`**: continue.
4. **Address**: run OCR's address step on `rounds/round-{round}/final.md`.
   Corroborate every item against the actual code; implement the **blockers and
   should-fixes** (these clear the gate); decline incorrect feedback with
   evidence; you MAY defer pure **suggestions** to the final pass. **Verify** with
   the repository's checks until green, then **commit** (atomic, conventional) and
   **push**.
5. **Post the address round** to the PR: what was addressed, declined (with
   reasoning), and deferred. _(skip if `--no-post`)_
6. `round += 1`; loop.

**2. Final suggestions pass** (only after `APPROVE`, unless
`--no-final-suggestions`): run OCR's address step once more to clear remaining
**suggestions**, verify, commit, push, and post a final address comment that
includes a **loop-summary table** (round → verdict → outcome).

**3. Stop conditions.** If `round` exceeds `max-rounds` without `APPROVE`,
**stop** and report the outstanding blockers; never loop indefinitely. If APPROVE
was reached on round 1, skip the loop body and go straight to the final
suggestions pass.

---

## Guardrails (critical, do not skip)

- **Bounded.** Honor `--max-rounds` (default 5). If not approved by then, stop and
  surface why.
- **`NEEDS DISCUSSION` is a human gate.** Pause and ask; never invent a resolution
  for genuine ambiguity.
- **Corroborate, don't obey.** Per OCR's address step: verify each finding against
  the code; implement valid items; **decline wrong feedback with evidence**.
  Don't gold-plate: fix only what the review actually raised.
- **Prefer the structural fix** that makes a defect unrepresentable over
  correcting the instance. Correcting the instance is what feeds the next round a
  new blocker.
- **From round 2, brief the re-review as a re-review.** Tell the reviewers that
  the previous round's fix is the most likely source of this round's defect, and
  require a claim-by-claim table (claim → TRUE/FALSE → `file:line`) rather than a
  fresh prose read.
- **Never push red.** Before every commit, run the repository's own checks: the
  done-bar its agent instructions (`AGENTS.md` or equivalent) or contributing
  guide name, or else what its CI runs on a pull request (typically lint,
  typecheck, test, build), scoped to the change where the tooling can scope it.
  Fix failures before pushing. **A passing check is not coverage:** where a
  finding is about what code or a document _says_, corroborate it by reading it,
  not by re-running the checks.
- **Never force-push.** A shared PR keeps its history; corrections go on top.
- **Branch safety.** Refuse to run on the default branch; this skill commits and
  pushes.
- **Faithful reporting.** Report verdicts and outcomes honestly. If a blocker
  genuinely can't be fixed (it needs a product or architecture decision), stop
  and say so rather than forcing APPROVE.
- **New round, same session.** Each iteration is a new OCR review round in the
  same session (a closed session starts `round-{n+1}`), reusing
  `discovered-standards.md` and `context.md`.

## Reference

- `references/loop-mechanics.md`: per-round mechanics, verdict gating, session
  and round handling, the re-review brief, and the PR comment templates.

# Loop mechanics

Read this when executing the review-to-approval loop. It captures the exact
session and round handling, how to read the verdict, the address-pass policy, and
the PR comment templates. OCR's review and address steps own their own internals;
this file only covers the **orchestration** around them.

In the steps below, "run OCR's review" means the `/ocr:review` command (or reading
`.ocr/commands/review.md` and following it),
and "run OCR's address step" means `/ocr:address`, or `.ocr/commands/address.md`.

---

## 0. Preconditions (resolve once, up front)

```bash
BRANCH="$(git branch --show-current)"
# Refuse to run on the default branch: this skill commits and pushes.
DEFAULT="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
[ "$BRANCH" = "${DEFAULT:-main}" ] && { echo "Refusing to run on the default branch."; exit 1; }

# Resolve the PR (the argument wins; else the open PR for this branch).
PR="${ARG_PR:-$(gh pr view --json number -q .number 2>/dev/null)}"   # needs gh unless --no-post
```

- If posting is requested but no PR exists, ask the user whether to open one first
  (`gh pr create`), or fall back to `--no-post` (local only).
- Confirm OCR is set up (`.ocr/` present, `ocr` on PATH). Run `ocr doctor` if
  unsure.
- Resolve the team: the default is `ocr team resolve --json`; with `--team`,
  forward the spec verbatim to the review (it calls
  `ocr team resolve --team "<spec>" --json`).
- A clean working tree: any uncommitted changes become part of what is reviewed.
  If the tree is dirty, say so and ask whether to include those changes.

---

## 1. Per-round mechanics

### a. Review

Run OCR's review (pass `--team <spec>` only if the user supplied one). It runs the
full 8-phase pipeline and finalizes the round, writing:

- `.ocr/sessions/{YYYY-MM-DD}-{branch}/rounds/round-{n}/final.md`
- `.ocr/sessions/{YYYY-MM-DD}-{branch}/rounds/round-{n}/round-meta.json` (verdict
  and counts)

**Round and session handling across iterations.** Every loop iteration is a **new
round in the same session**:

- Round 1 creates the session (`ocr state begin`) and walks `context → … →
  synthesis → complete-round → finish`.
- After a round finalizes, the review's Phase 8 calls `ocr state finish` (session
  `closed`). For the next round, `ocr state begin` again on the **same**
  `--session-id` starts `round-{n+1}` and resets the phase to `context`; then
  **advance the phase graph one step at a time** (`context → change-context →
  analysis → reviews …`): the CLI rejects illegal jumps. Reuse the existing
  `discovered-standards.md` and `context.md`; only the `rounds/round-{n+1}/`
  artifacts are new.
- Regenerate the diff each round (the branch has new commits from the prior
  address pass).

### b. Brief every round after the first as a re-review

From round 2 onward, add to each reviewer's brief, explicitly:

- The previous round's fix is the **most likely source of this round's defect**.
  Two recurring shapes: _a claim broader than what it enforces_, which climbs a
  level of abstraction each round, and _an invented fact_, where each correction
  is more specific and more confident than the falsehood it replaced.
- Return a **claim-by-claim table** (claim → TRUE/FALSE → `file:line`), not a
  fresh prose read. A prose re-read misses the same line round after round; a
  table forces each claim to be checked.

### c. Read the verdict (the loop gate)

Read `verdict` from `.ocr/sessions/{id}/rounds/round-{n}/round-meta.json`. It is
one of `APPROVE`, `REQUEST CHANGES`, or `NEEDS DISCUSSION`.

The verdict is the **merge gate** and the loop condition:

| Verdict            | Blockers | Loop action                                            |
| ------------------ | -------- | ------------------------------------------------------ |
| `APPROVE`          | 0        | **Exit loop** → final suggestions pass                 |
| `REQUEST CHANGES`  | ≥1       | **Address**, then re-review                            |
| `NEEDS DISCUSSION` | n/a      | **Stop and ask the user** (human gate, don't resolve) |

### d. Address (only on `REQUEST CHANGES`)

Run OCR's address step on `rounds/round-{n}/final.md`. Its own guardrails apply:
corroborate every item against the actual code, implement valid findings, decline
incorrect ones with evidence, propose a better fix when the suggested one is
suboptimal.

**Loop-specific address policy:**

- **Always** address **blockers** and **should-fixes** this round: they're what
  clears the gate to APPROVE.
- You **may defer pure suggestions** to the final pass (keeps each round focused
  on the gate). This is a judgment call; addressing a cheap suggestion inline is
  fine too.
- **Prefer the structural fix** that makes the defect unrepresentable over
  correcting the instance.
- **Verify before committing** (§ 2). Fix until green.
- **Commit** atomically with conventional messages. If the `atomic-commits` skill
  is installed, load it (through your skill tool, `/atomic-commits`, or by reading
  its SKILL.md) for the split; otherwise one conventional commit per concern.
  Then **push**. Never force-push.

---

## 2. Verification expectations

Never push red. Before each commit, run the repository's own checks:

1. The done-bar its agent instructions (`AGENTS.md` or equivalent) or
   contributing guide name, if any.
2. Otherwise, what its CI runs on a pull request (read the CI config), typically
   lint, typecheck, test and build, plus any end-to-end suite covering what the
   change touches.

Scope them to the change where the tooling can (an "affected" or changed-files
mode), rather than running everything. Run them again after every address round.

**A passing check is not coverage.** A claim that has drifted from what it
enforces, a comment or doc that now describes the wrong behavior: both pass
clean. Where a finding is about what something _says_, corroborate it by reading
it, not by re-running the checks.

---

## 3. Final suggestions pass (after APPROVE)

Once a round returns `APPROVE`, run OCR's address step **one more time** against
the approving round's `final.md` to clear remaining **suggestions** (the items
deferred during the loop). Verify, commit, push. Then post the final comment with
the loop-summary table (template below).

Skip this pass if `--no-final-suggestions` was given.

---

## 4. PR comment templates

Post with `gh pr comment <PR> --body-file <file>`. Write bodies to a temporary
file rather than passing them inline, to avoid shell-escaping trouble with
backticks and `$()`.

### Review comment (each round)

```markdown
**OCR multi-agent review, round {n}** ({team summary, e.g. principal×2, quality×2}, independent parallel reviewers)

{paste the round's final.md verbatim}
```

### Address comment (each round)

```markdown
## OCR address, round {n} response (commit {sha})

Addressed the round-{n} review. Each point corroborated against the code before acting.

### Blockers: fixed

{per blocker: what was wrong, the fix, the verification}

### Should-fix: {fixed / partially}

{per item}

### Declined / deferred

{declined items with evidence; suggestions deferred to the final pass}

### Verification

{check results}
```

### Final comment (after APPROVE)

```markdown
## OCR address, final pass (commit {sha})

Cleared the remaining suggestions from the approving review:
{list}

Left as-is by reviewer consensus: {items the reviewers explicitly said to leave}

**Verification:** {results}

---

### Loop summary

| Round | Verdict                          | Outcome    |
| ----- | -------------------------------- | ---------- |
| 1     | **REQUEST CHANGES** (… blockers) | {one-line} |
| -     | address                          | {one-line} |
| 2     | **APPROVE**                      | {one-line} |
| -     | final address                    | {one-line} |
```

---

## 5. Stop conditions and edge cases

- **Approved on round 1**: skip the loop body; go straight to the final
  suggestions pass.
- **`max-rounds` reached without APPROVE**: stop, post or print the outstanding
  blockers, and hand back to the user. Do not loop indefinitely.
- **`NEEDS DISCUSSION`**: stop; present the review's clarifying questions and
  await the user.
- **A blocker that can't be auto-fixed** (it needs a product or architecture
  decision): stop and say so; do not force an APPROVE by mis-categorizing it.
- **`--no-post`**: run the whole loop locally and present the review and address
  trail (and the summary table) in the conversation instead of on the PR.
- **Convergence sanity**: if a re-review reintroduces the _same_ blocker the prior
  address claimed to fix, treat the fix as unverified: re-open it, don't just
  loop.

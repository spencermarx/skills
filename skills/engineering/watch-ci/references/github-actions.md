# GitHub Actions, for watchers

What you need to interpret _what_ you're watching: which run you actually mean,
which jobs gate a merge and which are advisory, why a run you expected might be
absent, and why the watch's exit code is not a verdict. The repository's
`.github/workflows/` files are the source of truth for its own workflows; read
them rather than predicting.

## Learn the repository's workflows

```bash
ls .github/workflows/
gh workflow list
```

For each workflow that matters, read its file for:

- **Triggers** (`on:`): `push` to which branches, `pull_request`,
  `workflow_dispatch` (with which inputs), `release`, `schedule`. A
  push-to-default-branch-only job never appears on a PR.
- **Path filters** (`paths:` / `paths-ignore:`): a workflow filtered out by the
  changed paths legitimately produces no run at all. Its absence is not a failure
  and not a pass.
- **Jobs and their conditions** (`if:`), matrices (one check per leg), and
  reusable workflows (`workflow_call`): you watch the caller, not the reusable
  workflow.
- **Concurrency** (`concurrency:` with `cancel-in-progress: true`): a newer push
  cancels the older run, so a `cancelled` conclusion is often your own next push.

## Gate vs. advisory

Only required checks block a merge. Find them rather than assuming:

```bash
gh pr checks <pr> --required                      # the checks that gate this PR
gh api repos/{owner}/{repo}/branches/<base>/protection/required_status_checks
```

Some repositories can't mark checks required (branch protection is unavailable on
some private-repository plans). Then the gate is whatever the repository's own
docs or agent instructions name; if they name none, say which job failed and that
nothing marks it required, rather than calling the merge blocked or clear.

**Which jobs run on a PR depends on what it touches**, so do not assume one job
is the whole story. Read the run's job list; reporting "CI is green" having
watched only one job is how a red gate goes unmentioned.

**A green job does not mean it tested anything.** A job that always starts and
then decides internally whether to do work (steps gated on what changed) shows
green even when every meaningful step was skipped. Read the step conclusions
before reporting such a job as coverage:

```bash
gh run view <run-id> --json jobs \
  -q '.jobs[] | select(.name=="<job>") | .steps[] | "\(.conclusion)  \(.name)"'
```

`skipped` on the steps that matter means the gate inside the job said no.

## Correlating a run: the gotchas

- **`databaseId` is the only unique run handle.** Names and SHAs collide; ids
  don't. Always resolve to an id before `gh run watch`.
- **Pin `--workflow`.** A single default-branch SHA can carry runs from several
  workflows: the push run plus any `workflow_dispatch` run, which reuses the tip
  as its `headSha`. Filtering by branch or SHA alone is ambiguous.
- **PR runs test a _merge ref_, not the head commit.** For a `pull_request` run
  the reported `headSha` is the PR's head commit, but the workflow checks out
  `refs/pull/<n>/merge` (head merged into base), so the tree that ran is not the
  tree at `headSha`. Don't equate them when reasoning about what code was tested.
  `--branch` filters on the PR's head ref (the source branch), not the base.
- **Dispatched runs need time correlation.** `workflow_dispatch` runs share the
  default branch's `headSha` and don't expose their inputs in
  `gh run list --json`. Capture a timestamp before dispatching and take the newest
  run created after it; narrow with `--user <you>` if several people dispatch at
  once.
- **Status vs. conclusion.** `status` moves `queued` → `in_progress` →
  `completed`; `conclusion` is null until `completed`, then `success` /
  `failure` / `cancelled` / `skipped` / `timed_out`.
- **`gh run watch --exit-status` is the right thing to BLOCK on and the wrong
  thing to READ A VERDICT from.** Its exit code has been observed wrong in both
  directions, so never let it stand in for the conclusion; always resolve the
  verdict with `gh run view <id> --json status,conclusion`:
  - exits **0** on a **cancelled** run: the false green, and a likely one, since
    workflows with `cancel-in-progress` cancel superseded PR runs. Your own next
    push manufactures it.
  - exits **0** while the run is still **`in_progress`**. So exit 0 does not even
    establish that the run reached a conclusion; check `status` is `completed`
    before believing `conclusion`.
  - exits **1** on a run that **succeeded**: the watch itself can error (auth, or
    watching an already-finished run), and that is indistinguishable from a
    failure by exit code alone.

## A trigger-then-watch flow (deploys)

To dispatch a deploy _and_ durably watch it to completion:

```bash
before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run <deploy-workflow-file> -f <input>=<value>
# give GitHub a moment to register the run, then resolve its id:
run_id=$(gh run list --workflow <deploy-workflow-file> --event workflow_dispatch \
  --created ">=$before" --json databaseId --jq '.[0].databaseId')
# then watch it as a tracked process, so its exit reaches you:
gh run watch "$run_id" --exit-status --compact
```

Run that final watch the way SKILL.md describes (a background command whose exit
wakes you, a monitor, or a foreground block): the point of the whole exercise is
that its end is a signal you receive. Then read the verdict with `gh run view`.

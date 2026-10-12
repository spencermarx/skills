---
name: watch-ci
description: >-
  Watch a pull request's or branch's CI run, or a deploy run, to its conclusion and report
  the verdict; on a failure, triage it and, once the user agrees, fix, push and watch again
  until green. Use whenever someone wants to monitor, watch, track or wait on CI, a
  pipeline, a workflow run, a PR's checks or a staging or production deploy: "watch ci",
  "is CI green yet", "did the run pass", "wait for the deploy to finish", "tell me when the
  build is done", "get this PR's checks green". Especially when a background or
  orchestrated agent must block on a run: the tracked wait here is what keeps it from
  silently stalling. GitHub Actions through the `gh` CLI by default; other CI providers by
  the same method. Do NOT use to kick off a deploy from scratch, or to triage test
  failures that are not tied to a CI run.
license: MIT
argument-hint: '[branch | PR | run-id | workflow file]'
compatibility: Defaults to GitHub Actions through an authenticated gh CLI; another CI provider needs its own CLI.
---

# Watch CI

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

Watching CI is deceptively simple: kick off the wait, and report the verdict when
the run lands. The trap is in the word "wait." A CI run happens on the provider's
servers, not in your process, and **nothing about an external run reaches back
into your session on its own.** How you wait decides whether you reliably wake up
when the run finishes or silently stall until someone comes looking for you.

This skill is a small toolkit plus one load-bearing idea about waiting. It does
not script your every move: you know your context (a PR check vs. a forced
staging deploy, one run vs. a fan-out, foreground vs. a background lane) far
better than any fixed procedure could. Take the pieces you need.

## Check the tools first

Identify the provider from the repository: `.github/workflows/` means GitHub
Actions, the default this skill is written for. Another provider (a
`.gitlab-ci.yml`, a CircleCI or Buildkite config) takes its own CLI or API with
the same method: resolve one unique run, wait on a tracked process, read the
verdict from the API rather than from the wait's exit code.

For GitHub, run `gh auth status`. If `gh` is missing, ask the user before
installing it, using your structured-question tool if you have one; otherwise
list numbered options in plain text and stop until they reply. Show the exact
command (`brew install gh`, or the instructions at https://cli.github.com); if it
fails, print it for the user to run. If `gh` is installed but not authenticated,
the user runs `gh auth login` themselves; it is interactive.

## The one idea that matters: wait on something the harness tracks

Your session only continues when something _wakes_ it: a background command your
harness tracks exits, a subagent you started finishes, a scheduled wake-up fires,
or the user speaks. An external CI run is **none of those**: the provider never
notifies your session, so a run reaching `completed` produces no wake by itself.

That single fact is the whole reason CI-watching goes wrong. If you "wait" by
sleeping in a loop and then letting the turn end, hoping to resume when CI is
done, you will not resume, because there is no tracked signal tied to that run.
The agent looks dead; the run finished fine; the two never met.

So the durable move is to **make your wait a process the harness is watching**:

```bash
# Blocks until the run reaches a terminal state, then exits. Run it so that its
# exit wakes you (see the three ways below).
gh run watch <run-id> --exit-status --compact
```

Pick the strongest of these your harness offers:

1. **A background command whose exit wakes you.** If you can run a shell command
   in the background and be re-invoked when it exits, run the watch that way. No
   polling from your side, no turn that ends into silence.
2. **A monitor that streams a polling command's output to you.** For many checks
   at once, a run that may outlive one background command, or an environment
   where `gh run watch` can't run (see the auth caveat below), poll and emit on
   _every_ terminal conclusion (`success`, `failure`, `cancelled`, `timed_out`),
   never only on success: a monitor that speaks only good news is
   indistinguishable from one watching a crashed run in silence.

   ```bash
   run=<run-id>
   until [ "$(gh run view "$run" --json status -q .status 2>/dev/null)" = "completed" ]; do
     sleep 20
   done
   echo "run $run concluded: $(gh run view "$run" --json conclusion -q .conclusion)"
   ```
3. **A foreground command.** With neither, run the watch in the foreground: it
   holds your turn until the run lands, which is slow but never silent. If your
   shell calls time out, give the command the longest timeout allowed and
   re-issue it until the run is `completed`.

**Never wait by ending your turn and hoping.**

**Auth caveat.** `gh run watch` cannot authenticate with a fine-grained personal
access token (it needs the `checks:read` scope, which fine-grained tokens can't
carry). If the environment's `gh` uses one, the watch exits non-zero
**immediately**, which looks exactly like a failed run. If a watch returns almost
instantly, suspect auth, not CI: confirm with `gh auth status` and fall back to
the poll above (it reads `conclusion` directly and doesn't need that scope).

## Resolve the run before you watch it

`gh run watch` needs a **run id** (`databaseId`). Watching a _workflow name_
instead risks latching onto a stale previous run, so resolve the specific run you
mean first. The right query depends on how the run was triggered.

**A push or PR run**: match the commit you care about.

```bash
gh run list --branch <branch> --workflow <workflow-file> \
  --json databaseId,headSha,event,status,conclusion,createdAt --limit 10
```

Take the newest run whose `headSha` is the commit you pushed. `databaseId` is the
only unique handle. Pin `--workflow`, because one SHA can carry several runs (a
dispatched run reuses the default branch's tip, so it collides with the push run).
For a PR, `gh pr checks <pr>` lists every check at once, and `--required` narrows
it to the ones that gate the merge.

**A dispatched run** (`workflow_dispatch`): it carries no commit you chose, and
the dispatch inputs aren't in the list output. Correlate by **time**: capture a
timestamp _before_ you dispatch, then take the newest run of that workflow
created after it.

```bash
before=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run <workflow-file> -f <input>=<value>     # your dispatch
gh run list --workflow <workflow-file> --event workflow_dispatch \
  --created ">=$before" --json databaseId,createdAt,status --limit 5
```

There's a brief registration lag: the run may not appear the instant
`gh workflow run` returns. If the list comes back empty, give it a few seconds and
re-list before concluding the dispatch failed.

The repository's own workflows are the source of truth for what you're watching:
read `.github/workflows/`. The correlation gotchas, the exit-code traps, and how
to tell a merge gate from an advisory job are in `references/github-actions.md`.
Read it when you need to interpret _what_ you're looking at; you don't need it
just to watch a run to completion.

## When the run lands: read the verdict, then triage

On a terminal conclusion, say what happened plainly: which run, which workflow,
`success` / `failure` / `cancelled` / `timed_out`. **Never read the verdict off
`gh run watch`'s exit code**: it has been observed wrong in both directions (0 on
a cancelled run, 0 while still `in_progress`, 1 on a run that passed; see
`references/github-actions.md`). Block on the watch, then always resolve the
verdict with `gh run view <run-id> --json status,conclusion`; `status` must be
`completed` before `conclusion` means anything.

**If it is not `completed`, the watch returned early: go back and block again.**
One watch is not a wait; the wait is the loop. A single watch treated as a wait
makes falling through and succeeding indistinguishable. Re-issue the watch
(tracked, as above) until `status` is `completed`, **at most three times**; past
that, report the run as unresolved with its id and last-seen status rather than
looping. A fourth early return means something other than a slow run.

On a real failure, pull the failing detail directly:

```bash
gh run view <run-id> --log-failed          # the failed steps' logs
gh run view <run-id> --json jobs           # per-job status to locate the break
```

Summarize the failing job and step so the reader knows what broke. Not every red
check blocks a merge: say whether the failing job is a required gate or advisory
(`references/github-actions.md`), because reporting an advisory failure as a
blocked merge misleads.

## Fixing what broke

What to do next is the user's call: fix it, rerun it, or escalate. Ask the user,
using your structured-question tool if you have one; otherwise list numbered
options in plain text and stop until they reply. Recommend one, from the
evidence:

- **Fix.** The logs point at a defect in the change. If the cause is not obvious
  from them, investigate before editing: load the
  `first-principles-investigation` skill (through your skill tool,
  `/first-principles-investigation`, or by reading its SKILL.md); if it is not
  installed, reproduce the failing step locally and trace it to its cause
  yourself. Make the fix, run the failing check locally where you can, commit,
  push, resolve the new run's id, and watch it as above.
- **Rerun.** Only when the evidence says flake (a network timeout, a runner that
  died), not because a rerun is cheaper than a fix: `gh run rerun <run-id>
  --failed`, then resolve and watch the new attempt.
- **Escalate.** The fix needs a decision you can't make, or access you don't
  have. Report what broke and what is needed.

Never auto-apply a fix or rerun blindly. If a fix does not hold (the same job
fails the same way on the next run), stop and report rather than looping: a
second identical failure means the cause is not the one you fixed.

## If you're a background or orchestrated agent

Everything above matters more, not less, when you're a background lane in a larger
workstream: that's exactly where the silent stall bites and where a coordinator
is counting on you to report.

- **First, check where you can wait.** The harness only re-wakes the lane it owns.
  Tell which lane you're in by **capability, not environment**: if you can launch
  a tracked background command (or a monitor), you can watch inline. If you can't,
  you're a nested lane that can neither launch the watch nor be re-woken when one
  finishes, so a wait there just stalls. Prefer handing the whole task back up so
  the watch runs at the top level; if you truly can't, hand the watch up: give
  whoever started you the run id, ask them to watch it and tell you the verdict,
  then yield. Their reply is your wake, but only while they stay alive and act; a
  top-level watch depends on no such thing, which is why it's preferred.
- **Never wait by ending your turn and hoping.** Your wait must be a tracked
  process so a real signal brings you back. A bare sleep-then-poll that ends the
  turn can look fine in an interactive session, but a background lane's turn ends
  into silence with no signal to resume it, which is why the trap is easy to fall
  into and hard to notice.
- **When the run lands, close the loop out loud.** Send the result to whoever is
  waiting through whatever channel your harness gives you, and make it your final
  message too. A verdict you observed but never voiced is the same stall wearing a
  different mask.

## Reporting the verdict

Keep the close-out short and self-contained; someone reading only your last line
should know the outcome and the one next step, if any:

```
[watch-ci] CI on <branch> (<workflow>, run <id>): <conclusion>.
<one line: green → done / next step, or the failing job+step, gate or advisory, and your read on it>
```

## Before you call it done

- Did you watch a **specific run id**, not a workflow name that could resolve to a
  stale run?
- Was your wait a **tracked process** (background command, monitor, or a
  foreground block), so the conclusion actually reaches you, rather than a turn
  that ends into silence?
- Did you resolve the verdict with `gh run view --json status,conclusion`, and, if
  `status` came back anything but `completed`, **watch again** rather than
  reporting what the early return implied?
- Does your report cover the **actual terminal state**, including failure and
  cancellation, and say whether a failing job gates the merge?
- Did any fix or rerun happen **after the user agreed**, and did you watch the new
  run to its own verdict?
- If a coordinator is waiting, did you **voice** the result, not just observe it?

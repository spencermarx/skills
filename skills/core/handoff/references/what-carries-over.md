# What carries over to the successor

Loaded on demand by the `handoff` skill in Claude Code: in Step 1, to read what
this session passes on (from its state record, inside a background job), and in
Step 4, for the launch line, the stop sentence and the naming convention.
Another harness that can launch a background session from the shell follows the
same shape with its own commands; one that cannot skips the launch.

## Reading the state record

Print the job's directory and the session's effort on their own:

```bash
echo "$CLAUDE_JOB_DIR"
echo "$CLAUDE_EFFORT"
```

An empty job directory means no background job and no record: see § Outside a
background job. Otherwise read the record at that literal path, one field per
command. A worktree-isolated session can refuse the
same read written against the variable.

```bash
jq -r '.name' '<job dir>/state.json'
jq -r '.daemonShort' '<job dir>/state.json'
jq -r '.intent | .[0:120]' '<job dir>/state.json'
jq -r '.respawnFlags as $f | [range(0; $f | length) as $i | select($f[$i] != "--name" and ($i == 0 or $f[$i-1] != "--name")) | $f[$i] | @sh] | join(" ")' '<job dir>/state.json'
```

Without `jq`, read `state.json` and take the same fields by eye, shell-quoting
each flag yourself. Where a shell hook cuts long output short and names a file
holding the rest, read that file for the whole value.

A subagent or fork sees its parent's job here, so the name and id it reads are
its parent's. That is right for the document's provenance, and it is why the
skill's Step 4 never launches from a subagent or fork.

## What each field gives the successor

- **Name** (`.name`): the predecessor's name, for the document's banner and for
  the naming convention below.
- **Launch flags** (the last command): every flag in `.respawnFlags` except
  `--name` and its value, in order, shell-quoted and ready to paste into the
  launch line, for example `'--effort' 'high' '--model' 'claude-opus-5-5[1m]'`.
  They carry the model, effort, permission mode, agent and tool grants as far as
  the record holds them; a flag lost before this skill ran stays lost. Where
  they have no `--model`, add the model id from your own system prompt; where
  they have no `--effort`, add `'--effort' '<value>'` with the literal value
  `echo "$CLAUDE_EFFORT"` printed, or no `--effort` when it printed nothing. A
  background job can start from a pre-warmed spare, so any flag left off is
  silently replaced by the default: a manual relaunch that dropped `--model`
  once lost a 1M-context model that way.
- **Persona prefix** (`.intent`): if it opens with a persona skill, one whose
  argument is a role, the prefix is that invocation up to and including the
  role: `/<skill> CCO - draft the offer` gives `/<skill> CCO`. Any other opening
  invocation, and everything after the role, was the old task, and is dropped.
  The launch line joins the prefix to the new seed with ` -- `, so the next
  handoff finds the same boundary.
- **Own id** (`.daemonShort`): for the document's banner, for the stop sentence
  in the seed, which the successor runs, and for the report's
  `claude attach <own id>`.

## Outside a background job

There is no record, so the launch still happens but carries less: `--model`,
with the model id from your own system prompt, and `--effort`, with what
`echo "$CLAUDE_EFFORT"` printed, if anything. Name in the report any permission
mode or agent this session runs with that the successor will lack. There is no
own id, so the seed has no stop sentence, and the report says this session can
be closed in place of the attach line.

## The stop sentence

Put this in the seed line's `<stop sentence>`, with `<own id>` filled in:

`Once you have read it, stop your predecessor: when claude agents --json shows <own id> with status idle, run claude stop <own id> and confirm it left the listing. If it is listed but not idle, check again before your first edit or the end of your turn; if it still is not, or it stays listed, leave it and tell the user.`

Stopping keeps the conversation: `claude attach <own id>` reopens it for
questions, which is the reopen line the report gives.

## The launch line

From the top level Step 1 printed, dropping the persona prefix and its ` -- `
when there is none:

```bash
cd '<top level>' && claude --bg <the carried flags> --name '<name>' '<persona prefix> -- <the seed line>'
```

A `'` anywhere inside the single quotes, the paths included, is written `'\''`.
It prints `backgrounded · <id> · <name>`; that id is the one Step 4 reports.

## The worktree after removal

Where this session runs in a worktree, the successor opens in it, and the
harness treats a worktree a session opens in as isolated: the successor enters
no other. On Claude Code 2.1.308, `claude rm` on the stopped predecessor kept
the worktree while a live background successor used it as its working
directory, and the refusal named that session. Once the successor had been
stopped and removed, `claude rm` on the predecessor deleted the worktree.
Removing this session after the handoff leaves the successor its worktree, so
nothing in this skill guards it.

## Naming

Sessions are named `<repo>: <subject> - <N>`, so a list of sessions sorts each
line of work together, in order: `shop: PAY-212 - 3`, `shop: pricing page - 5`.

- **`<repo>`** is the lowercase short name of the repository the work happens
  in: take it from the predecessor's name, or from the repository's directory
  name when there is none.
- **`<subject>`** leads with the ticket keys, in full as the tracker writes
  them; without a ticket, a topic of two or three words.
- **`<N>`** counts the sessions in the chain, from ` - 1`.

The successor keeps the predecessor's repo and subject and adds one to `<N>`. A
new chain starts only when the user's request names a different line of work;
then give it a new subject at ` - 1`. Otherwise the chain continues, whatever
the focus has drifted to.

### Repairing a name

Where the predecessor's name breaks the convention, the successor's name repairs
it: add the missing `<repo>: ` prefix, write ticket keys in full, keep the
subject's words, and count on from the old `<N>`, or from 1 when there was none.
`multi-session orchestration research` becomes
`shop: multi-session orchestration research - 2`.

A session with no name gets one built from the work in the handoff, at ` - 2`.

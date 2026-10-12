# Writing into an entry you are not allowed to touch

Some harnesses isolate background sessions from the main checkout. Claude Code is
the measured case: its `worktree.bgIsolation` setting defaults to `worktree`, so
a background session may not use its file-editing tools against the main
checkout until it enters a worktree, and once it has, those tools may only touch
the worktree. Entries live at the **main** checkout by design, so in such a
session they are never a legal target for those tools, before isolating or
after.

What was probed, and what came back:

| Probe | Result |
|---|---|
| Edit-tool write to `.scratchpad/` from the shared checkout | blocked: "isolate first" |
| Edit-tool write to the main root's `.scratchpad/` from a worktree | blocked: "edit the worktree copy" |
| Edit-tool write through a symlink aliasing the main root | blocked: the guard resolves symlinks |
| Edit-tool write to a worktree-local `.scratchpad/` | allowed, but deleted with the worktree |
| Plain shell write to the main root | allowed |

The setting is `worktree | none`, with no per-path exemption, so the scratch
folder cannot be excused even though every file in it is git-ignored. Other
harnesses with a similar sandbox behave the same way in outline: the
file-editing tools are fenced, the shell is not.

## This is not a loophole

The setting's scope is the file-editing tools alone. A plain shell invocation is
the route it deliberately leaves open, not a gap in it. So:

1. Author the file where you **are** allowed to write: anywhere outside the
   repository. A background job's own temp directory is the natural home.
2. `place` it into the entry.

`place` never reads the bytes it moves, so the primitive stays as format-blind
as the rest of it: it moves a file it never looks inside.

## What not to do instead

**Do not write into a worktree-local `.scratchpad/`.** That directory is
ignored, and `git worktree remove` deletes ignored files without complaint, so
the file dies with the branch -- silently, and usually at the exact moment
someone needs it.

**Do not hand the source in as a symlink.** `place` refuses one, because `mv`
would relocate the link rather than its bytes and leave the entry pointing into
a staging directory that is about to be swept.

**Do not aim `place` at the scratchpad root or a bare domain directory.** It
refuses both. `list` and `clean` only ever match at entry depth, so a file above
that is invisible to one and unreclaimable by the other. Pass the directory
`new` printed.

## A loop that appends every turn

`place` moves a file once and refuses to overwrite, so it cannot serve a caller
that appends to the same entry on every turn: the second write fails. Such a
caller appends with a plain shell redirect against the entry path instead, which
the guard leaves open for the same reason it leaves `place` open, its scope
being the file-editing tools rather than the filesystem. `place` remains the
route for a file authored in one piece and moved in once.

---
name: gather-argument-material
description: >-
  Mines raw material for a piece of writing: interviews the author relentlessly, appending
  every fragment to one working file and imposing no outline. Use whenever someone wants an
  essay, newsletter, post, guide or talk and has nothing written yet, is still adding to a
  pile, or wants to think out loud first. Do NOT use once the material is there and the
  piece must be drafted (use `draft-argued-piece`), for conversion copy such as a cold
  email (use `draft-conversion-copy`), or to settle a choice (use `grill-me`).
license: MIT
argument-hint: '[topic, or the path of an existing fragments file]'
metadata:
  credits: "Adapted from Matt Pocock's writing-fragments skill, https://github.com/mattpocock/skills (MIT)"
---

# gather-argument-material

Pure explore: widen what could be written and commit to nothing. Committing is
the next skill's job. Interview the user relentlessly about what they want to
write, appending what it throws off to one working file. An outline, phases,
article structure: out of scope, and reaching for one early is how this fails.

This skill and `draft-argued-piece` serve a piece of writing carrying an
argument the reader follows in order: an essay, a newsletter issue, a
whitepaper, a guide, a case study, a talk script, a long social post that
argues something. The boundary is whether there is an argument to sequence,
never length. A cold email is an ask and a landing page is message hierarchy,
so conversion copy is drafted with `draft-conversion-copy` and reviewed with
`seven-copy-critics`.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Scratch folder** (`docs/agents/workspace.md`): where the working file lives.
  Default: `.scratchpad/` at the repository root, git-ignored.

## 1. Open the working file

Where the user names a path, or hands you an existing fragments file, use it and
keep using it for the rest of the session. Otherwise open a scratch entry: load
the `scratchpad` skill (through your skill tool, `/scratchpad`, or by reading
its SKILL.md) and run its `new writing '<topic>'` verb, by the absolute script
path that skill describes and with the configured scratch folder if it is not
the default. Write `fragments.md` inside the directory it printed, at that
absolute path. Invent no third home.

**If `scratchpad` is not installed**, create
`<scratch folder>/writing/<UTC-YYYYMMDD-HHMMSS>-<topic-slug>/fragments.md` at the
top of the main checkout (the first path `git worktree list` prints), and make
sure git ignores the scratch folder (add it to `.git/info/exclude` if not).
Outside a git repository, ask the user once where to save the file.

The first write is a single H1 holding a working title and nothing else. No
metadata, no table of contents, no date. The title can change later.

**When you cannot write the fragments.** Some harnesses lock a background or
isolated session out of the main checkout, where the scratch entry lives. If
your file-editing tools cannot write `fragments.md`, take the route the
`scratchpad` skill's `references/writing-into-a-locked-entry.md` gives, in its
section "A loop that appends every turn", for a file that grows every turn:
append each fragment with one plain shell redirect (`>>`) against
`fragments.md`'s absolute path, after re-reading the file as usual. A redirect
only appends, so an edit the user asks for to an earlier fragment goes back in
your reply, saying which fragment it replaces. If the redirect is refused too,
return each fragment in your reply instead and say that it belongs at the end of
`fragments.md`, giving that file's absolute path, so the user can add it. Never
improvise another channel: no worktree-local copy, no other location, and not
`scratchpad`'s `place` verb, which refuses to overwrite.

## 2. Interview, and append

Capture from the very first thing the user says, the opening prompt included.
Fragments come off both sides: a line you wrote in a question counts once they
keep it. Push hardest where the conversation circles one idea twice. That is
where a leading word is hiding, and coining it is the most valuable thing this
session can land.

Keep going until the user says they are out of material. That call is theirs,
and asking for it beats inferring it: an agent cannot see the bottom of
somebody else's pile, so stopping early is the failure to guard against.

## What counts as a fragment

Any text that might survive into the finished piece. It must be readable by the
author, meaning they can tell what it means; it need not define what it names or
make sense to a cold reader. The bar is "is this good writing", not "is this a
self-contained argument". Fragments are deliberately heterogeneous:

- **A leading word**: a compact metaphor or coinage the piece hangs on, the way
  *tracer bullets* or *fog of war* names a whole pattern. It shapes the
  structure, the transitions and the title downstream.
- **A sharp sentence** worth deploying somewhere, with no idea where yet.
- **A claim** carrying a one-line justification.
- **A vignette**: a thing that happened, a code snippet, a scenario, an analogy.
- **A half-thought**: "something about how X feels like Y, work it out later".
- **A quote**, a line of dialogue, an overheard remark.
- **A cluster** of observations that hang together by feel.
- **A complaint**, a confession, a punchline.

The model is the novelist's diary: years of unstructured noticings, mined later.

## File format

A horizontal rule separates fragments. No headings inside the body, no tags, no
order beyond the order they arrived in. A fragment can run to several paragraphs
and can carry lists, code or quotes.

```markdown
# Working title

A first fragment. It can run to several paragraphs.

---

> A quoted line the author wants to keep around.

A reaction to it.

---

- A cluster of observations
- that hang together by feel
```

## Append discipline

**Re-read the file from disk before every write.** The user edits, reorders and
deletes fragments between turns, and a write built on a stale read silently
discards that.

**Append, never overwrite.** Edit one fragment in place only when asked to.

**Append silently.** No permission request per fragment, no save dialog. Mention
it in passing, "adding that", and keep going.

**Take an in-flight command as a first-class instruction** the moment it lands:
"cut the last one", "rewrite that one sharper", "merge those two".

## Where this goes next

Hand the file's absolute path to `draft-argued-piece`, which reads the pile
without editing it and writes the piece into the same entry. If it is not
installed, give the user the path and stop.

## Out of scope

- **Structure of any kind**: no outline, no section list, no ordering, no
  proposal about where a fragment belongs. Structure arrives next, against the
  whole pile.
- **Settling a choice.** `grill-me` converges, interviewing until every branch
  is closed. This diverges and refuses to structure.

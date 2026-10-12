# Drafting a section

How to get from what the user said to a heading and a body worth handing to the
`standards` skill. This is the judgment half. The mechanics of siting, routing
and validating are that skill's, not this file's.

## Interrogate the sentence first

"We should always use ISO dates" is a wish. A standard has to survive being read
by a session that was not in the room. Ask four things, and expect the user to
answer at least the first three.

1. **What exactly is governed?** Every file, or every dated file, or every file
   under `db/migrations/`. The answer becomes the glob of a routing rule or,
   where none can serve, the reason the section is declared unrouted.
2. **When does the obligation fire?** Name the moment: creating the file,
   renaming a heading, adding a dependency. A convention nobody can locate in
   time is one nobody acts on.
3. **What breaks when it is ignored?** One sentence. This is the part a future
   session needs in order to apply the rule to a case you did not anticipate,
   and it is the part most often left out because it feels obvious today.
4. **What is the permitted exception?** If there is none, say so. An unstated
   exception gets invented locally by whoever hits the first hard case.

If question 2 has no answer, you are holding a preference rather than a
standard. Go back to the triage table in the skill body.

## Name a heading nobody will rename

The heading becomes the anchor every pointer aims at, so renaming it later
obligates rewriting each of those pointers in the same change.

Name the convention, not the artifact it currently applies to. "Migrations are
reversible" survives a change of migration tool. "Every Knex migration exports
`down`" does not, because the tool is in the heading and the tool is the thing
most likely to change.

Sentence case, and short enough to read inside a link label.

## Write the statement, not the procedure

A section states what is true and why. The steps for complying with it belong to
whatever skill, script or template does the work, and a section that grows a
numbered procedure has started competing with it.

The test: if the team changed how the work is done tomorrow, would this
paragraph need editing? If yes, it is procedure, and it belongs somewhere else.

If the conventions folder states rules for its own prose (voice, length, link
style), the section follows them like any other document there.

## When no document owns the subject

The index lists the documents. One of them owns the subject, or none does, and
none is a real signal: it usually means the convention is narrower than it
sounds and belongs inside an existing document, or that the repository has
grown a concern nobody has named.

Raise it with the user with both readings on the table. Adding a document is
theirs to decide, and it is the kind of change that quietly reshapes what every
future standard gets filed under.

## Worked example

Invented for illustration; the shape is the point rather than the content.

Said: "people keep leaving TODOs that nobody ever comes back to."

The four answers: governed, every `TODO` comment in source. Fires, at the moment
of writing one. Breaks, a `TODO` with no tracked issue has no owner and no date,
so it outlives everyone who knew what it meant, and reads as a plan while being
none. Exception, none, because a `TODO` too small to track is one to do now or
delete.

Drafted:

> ## A TODO names the issue that removes it
>
> Every `TODO` comment names the tracked issue that will remove it. An untracked
> `TODO` reads as a plan while carrying none: nobody owns it, nothing dates it,
> and it survives everyone who knew what it meant.

Note what the draft leaves out. It does not say how to file the issue, what the
comment syntax looks like in each language, or which linter flags violations.
Those are procedure, and they belong to whatever does the work.

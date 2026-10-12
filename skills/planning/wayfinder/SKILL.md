---
name: wayfinder
description: Plan a huge chunk of work (more than one agent session can hold) as a shared map of decision tickets on your issue tracker, and resolve them one at a time until the way to the destination is clear.
disable-model-invocation: true
argument-hint: "[a loose idea to chart, or a map to work through]"
metadata:
  credits: "Adapted from Matt Pocock's wayfinder skill, https://github.com/mattpocock/skills (MIT)"
---

A loose idea has arrived, too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** (questions whose resolution is a decision, not slices of a build to execute) one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting: it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic: engineering work, course content, whatever fits the shape.

Paths below are relative to this skill's directory; resolve them to absolute paths before reading.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear, with nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes**, carrying execution into the map itself, but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name**: its title. In everything the human reads (narration, the map's Decisions-so-far), refer to it by that name, never by a bare id, number, or slug. A wall of `#42, #43, #44` is illegible; names read at a glance. The id and URL don't vanish: a name wraps its link, but they ride _inside_ the name, never stand in for it.

The same instinct governs **vocabulary**: a name made of private jargon is no more legible than a number. Everything a human reads on the map or its tickets (bodies, titles, resolution comments, Decisions-so-far gists) is written in plain words, the project glossary's language, or with each coined term glossed inline at first use. Load the `conveying-clearly` skill (through your skill tool, `/conveying-clearly`, or by reading its SKILL.md) before writing any of it; if it is not installed, hold to that rule yourself. Shorthand coined while working the map is private until translated; persisted ungrounded, it becomes the canonical text the next session inherits and re-offends with.

## Where the map lives

This repository's agent configuration should have been provided to you (the `## Agent skills` block pointing at `docs/agents/`). If it is missing, use the defaults below and suggest the user run the `setup-aclarify-skills` skill.

`docs/agents/issue-tracker.md` says where issues live; its **Wayfinding operations** section says how this repo expresses the map, child tickets, blocking, the frontier query, claiming and resolving. Default, when no tracker is configured: local markdown files under the scratch folder that `docs/agents/workspace.md` names (default `.scratchpad/`), as set out in [references/local-tracker.md](references/local-tracker.md).

## The map document

The map's format, the ticket types, and the fog-of-war and out-of-scope tests are in [references/map-format.md](references/map-format.md). Read it before charting a map or adding a ticket to one.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session**, with the exception of research tickets.

### Chart the map

The user invokes with a loose idea.

1. **Name the destination.** Load the `grill-me` and `domain-modeling` skills (each through your skill tool, `/grill-me` and `/domain-modeling`, or by reading its SKILL.md) and run a session to pin down what this map is finding its way to: the spec, decision, or change. The destination fixes the scope, so it's settled first. If either skill is not installed, interview the user yourself, one round of questions at a time, each with your recommended answer.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** (the way to the destination is already clear, the whole journey small enough for one session), you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map** (label `wayfinder:map`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now** as child issues of the map, then wire blocking edges in a **second pass** (issues need ids before they can reference each other). Write cross-references in that pass too, with real ids: a placeholder like `#<n>` auto-links to an unrelated issue. Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog: the **Not yet specified** section.
5. **Start the research.** For each **unblocked** `research` ticket you just created, **claim it first** (the same claim rule every session follows: an in-progress ticket must not look takeable on the frontier). If you can dispatch subagents, run one per research ticket in the background, in parallel; each resolves its own ticket per the Research lifecycle in [references/map-format.md](references/map-format.md). Otherwise release the claims and leave the research tickets on the frontier for the next session, which may sweep several of them. Blocked research tickets wait for their blockers like any other ticket. Concurrent subagents editing the map body can collide: re-read the map immediately before appending to Decisions-so-far, and re-apply on conflict.
6. Stop. Charting is one session's work; it hand-resolves nothing itself (research subagents from step 5 resolve their own tickets).

### Work through the map

The user invokes with a map (URL, number, or path). A ticket is **optional**: without one, you pick the next decision, not the user.

1. Load the **map**: the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: assign it to yourself before any work.
3. Resolve it as the type its `wayfinder:<type>` label names (see the ticket types in [references/map-format.md](references/map-format.md)). Read the label, not just the body: the body never states the type. **Zoom as needed**: fetch the full body of any related or closed ticket on demand; load whichever skills the `## Notes` block names. If in doubt, use `grilling` and `domain-modeling`.
4. Record the resolution: post the answer as a **resolution comment**, **close** the issue, and **append a context pointer** to the map's Decisions-so-far. Write the resolution decision first, then the why as its consequences, every term grounded. A resolution comment is the canonical text future sessions inherit, so it earns the strictest reading of the vocabulary rule above. If the resolution leaned on a coined term that now recurs across tickets, add its one-line gloss to the map's Working vocabulary.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals that a ticket (this one or another) sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.

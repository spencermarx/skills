---
name: prototype
description: >-
  Builds a throwaway prototype that answers one design question: a single-file HTML demo
  driving a state model, or radically different UI variants on one route, then folds only
  the validated decision into real code. Use whenever someone wants to try something out
  before committing to it: "prototype this", "mock it up", "spike it", "does this logic
  feel right", "will this state machine hold up", "try a few layouts", "show me options
  before we build", "a throwaway demo a non-developer can drive", even when they don't say
  "prototype". Do NOT use to build or polish the real thing for keeps, or to settle a
  choice by interview (use `grill-me`).
license: MIT
argument-hint: '[the design question to answer]'
metadata:
  credits: "Adapted from Matt Pocock's prototype skill, https://github.com/mattpocock/skills (MIT)"
---

# Prototype

Paths below are relative to this skill's directory; resolve them to absolute
paths before running anything.

A prototype is **throwaway code that answers a question**, and **the question
decides the shape**. You are not building the thing: you are buying an answer as
cheaply as possible, then keeping only what you learned.

## Configuration

This repository's agent configuration should have been provided to you (the
`## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
defaults below and suggest the user run the `setup-aclarify-skills` skill.

- **Scratch folder** (`docs/agents/workspace.md`). Default: `.scratchpad/`,
  git-ignored. Single-file prototypes with no code home go here.
- **Issue tracker** (`docs/agents/issue-tracker.md`). Default: the repository's
  GitHub issues through `gh`, if it has a GitHub remote. The verdict is recorded
  there.
- **Glossary** (`docs/agents/domain.md`). Default: `GLOSSARY.md` at the
  repository root. A logic demo speaks its terms, where one exists.

## Pick a branch

Name the question first, from the user's prompt, the surrounding code, or by
asking if the user is around:

- **"Does this logic / state model / data shape feel right?"** → read
  `references/logic.md`. Build a single shareable HTML file (free-play buttons
  plus tabbed guided walkthroughs) that pushes the state machine through cases
  that are hard to reason about on paper, and that a non-developer can drive.
- **"What should this look like?"** → read `references/ui.md`. Generate several
  radically different UI variations, switchable via a URL search param and a
  floating bottom bar, as close to the real app as fidelity allows.

The two branches produce very different artifacts, so the wrong branch wastes the
whole prototype. When the question is genuinely ambiguous, ask the user which
branch, recommending the one the surrounding code suggests (a backend module →
logic; a page or component → UI). Ask using your structured-question tool if you
have one; otherwise list numbered options in plain text and stop until they reply.
If the user is unreachable (you are running unattended), default to the branch
the surrounding code suggests and **write the assumption at the top of the
prototype** so a reader can correct it.

## Rules for both branches

1. **Throwaway from day one, and marked as such.** Put the code close to what it's
   prototyping, so context is obvious, but name it so nobody mistakes it for
   production: `prototype` in the path or filename. For throwaway UI routes,
   follow the routing convention the project already uses; don't invent new
   top-level structure.
   - **A single-file prototype with no code home** goes in the scratch folder.
     Load the `scratchpad` skill (through your skill tool, `/scratchpad`, or by
     reading its SKILL.md) to place it; if it is not installed, write it under the
     scratch folder yourself and make sure that folder is git-ignored.
   - **An in-repository prototype** (an app route, a component story) lives on a
     branch named **`proto/<slug>`** that is **never merged** into the default
     branch. If the work needs to be seen, hand off a URL or a screenshot, not a
     pull request. The branch is a dead end: if a ticket drove you here, what the
     ticket ships is the fold-in rewrite, never this branch. The `proto/` prefix
     makes "never merged" checkable at a glance instead of a hope.
2. **Trivial to run.** A UI prototype starts from one command in the project's
   task runner (`npm run <name>`, `python <path>`, `bun <path>`, and so on). A
   logic demo is a single HTML file the user double-clicks. Either way, starting
   it takes no thought.
3. **No persistence by default.** State lives in memory. Persistence is usually
   the thing the prototype is _checking_, not something to depend on. If the
   question really is about stored data, point at a scratch database or local
   file clearly named to be wiped ("PROTOTYPE, wipe me"), never real data.
4. **Skip the polish.** No tests, no error handling beyond what makes it
   _runnable or drivable_ (the variant switcher is drivability, not polish), no
   abstractions, no "what if we later want X". The point is to learn something
   fast. A prototype is exempt from the project's done-bar (its test, lint,
   localisation and coverage rules): write copy inline in plain domain language
   rather than through the project's i18n layer, for instance. The floor stays: it
   must still run (rule 2) and never touch real data (rule 3).
5. **Surface the state.** After every action (logic) or on every variant switch
   (UI), render the full relevant state plainly, so what changed is impossible to
   miss.
6. **Capture it when done**, as below.

## Fold-in is a rewrite, not a promotion

Prototype code was built under relaxed rules, so the validated decision gets
rebuilt properly through the project's real path: its components and tokens, its
i18n, its tests, its full done-bar. The prototype is a faithful starting point
and a reference, never the production artifact. Do not carry the prototype's
exemptions into the real code.

## Capture: fold in the answer, archive the code

1. **Fold the validated decision into real code**, as a rewrite: the validated
   reducer or machine becomes its module's starting point; the winning UI variant
   is rebuilt with the project's real components.
2. **Archive the prototype as a primary source.** Losing variants, the switcher
   and the HTML shell go to the `proto/<slug>` branch: durable in git and
   reachable by others, never in the default branch. The scratch folder is fine
   for a genuinely disposable single-file demo, but it is git-ignored, so it is
   scratch, not an archive anyone else can find; commit a demo worth keeping to
   the `proto/<slug>` branch.
3. **Record the verdict where it will outlive the code**: the question it
   settled, the answer, and a pointer to the `proto/<slug>` branch. The verdict,
   not the code, is the real deliverable. If an issue drove this, it goes there;
   if you were invoked with no issue, open one in the configured tracker, or put
   it in the commit message on the `proto/` branch, rather than leaving the
   learning in a session about to end. A decision that sets precedent or is hard
   to reverse is a candidate for the `decision-record` skill, if it is installed;
   propose it, and let the user say yes.

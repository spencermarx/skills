# Whiteboard design notes

Maintainer material for the incubating `whiteboard` skill
(`skills/_incubating/whiteboard/`). None of it ships with the skill, and an agent
running a board never needs it.

- `SPEC.md`: the design spec and its decision log. The skill's code comments cite
  it as `SPEC §n` and `decision #n`.
- `skill-arch.tldr`: the skill's architecture as a tldraw board. Open it in the
  whiteboard itself (`/whiteboard open docs/whiteboard/skill-arch.tldr`) or at
  tldraw.com.

The server and app tests live in `tests/whiteboard/`, with the manual acceptance
runbook for what needs a person at the browser.

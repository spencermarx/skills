# Whiteboard design notes

Maintainer material for the `whiteboard` skill
(`skills/visual/whiteboard/`). None of it ships with the skill, and an agent
running a board never needs it.

The skill is ported from the Aclarify Workspace's own whiteboard skill and tracks
its upstream commit `5e8a16c1` (spec v9.13: one boards folder from every checkout,
and a board's name backed by one file). The spec's §9 "Port decisions" records
every place this port departs from upstream: where boards live, how the runtime is
installed, the detached boot and pull delivery
for harnesses other than Claude Code, and the hardening re-applied on top.

- `SPEC.md`: the design spec and its decision log. The skill's code comments cite
  it as `SPEC §n` and `decision #n`.
- `skill-arch.tldr`: the skill's architecture as a tldraw board. Open it in the
  whiteboard itself (`/whiteboard open docs/whiteboard/skill-arch.tldr`) or at
  tldraw.com. It is upstream's diagram and still draws the background poller that
  decision #64 retired; upstream has redrawing it parked.

The server and app tests live in `tests/whiteboard/`, with the manual acceptance
runbook (`acceptance-runbook.md`) for what needs a person at the browser.

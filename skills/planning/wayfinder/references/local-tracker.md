# Default tracker: local markdown

Used by the `wayfinder` skill when the repository has no issue tracker
configured. The map and its tickets are markdown files under the scratch folder
(`<scratch>` below), which `docs/agents/workspace.md` names; default
`.scratchpad/`.

The scratch folder is usually git-ignored, so a map kept here is local to one
checkout. If the effort needs collaborators, say so when charting and suggest
configuring a shared tracker.

- **Map**: `<scratch>/<effort>/map.md`, holding the map body (Destination, Notes, Decisions so far, Not yet specified, Out of scope, Working vocabulary). Its first line under the title is `Label: wayfinder:map`.
- **Child ticket**: `<scratch>/<effort>/issues/NN-<slug>.md`, numbered from `01`, one file per ticket, with the question in the body. Near the top: a `Type:` line (`research`, `prototype`, `grilling` or `task`, standing in for the `wayfinder:<type>` label) and a `Status:` line (`open`, `claimed` or `resolved`).
- **Name**: the ticket's `# ` heading is its name; link to it by relative path.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `<scratch>/<effort>/issues/` for files that are `open` and unblocked; the lowest number wins.
- **Claim**: set `Status: claimed` and save before any other work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (the ticket's name as a link, plus a one-line gist) to Decisions so far in `map.md`.
- **Rule out of scope**: set `Status: resolved`, add a line `Out of scope: <why>` under the heading, and add the one-line entry to the map's Out of scope section instead of Decisions so far.

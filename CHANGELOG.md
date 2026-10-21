# aclarify-skills

## 0.3.0

### Minor Changes

- [#3](https://github.com/spencermarx/skills/pull/3) [`e681a61`](https://github.com/spencermarx/skills/commit/e681a61125ae00280870de055611a2911cba7f5f) Thanks [@spencermarx](https://github.com/spencermarx)! - `whiteboard` (incubating) is re-ported from its upstream doorbell redesign. The lead no longer runs a background poller. In Claude Code the board's server is the foreground of a background job and stops when the session ends. It rings the session's inbox when you Send, the lead fetches `GET /pending`, and a canary at boot proves the ring arrives. In harnesses without an inbox, the server runs detached until you close the board, and the lead listens by long-polling `GET /pending?wait=`. Boards keep their port across reopens. Each Send shows whether the lead has fetched it ("rung", "working", "not heard"). The panel holds and retries Sends the board did not receive. The boot and listening steps changed: `whiteboard.sh start` runs the server in the foreground, `start --detach` runs it detached, and exit 3 now means the board is held by a live server and exit 5 that the runtime is not installed. Room ids are now the board's file name.

### Patch Changes

- [#5](https://github.com/spencermarx/skills/pull/5) [`ebd52f7`](https://github.com/spencermarx/skills/commit/ebd52f70aae24f1f6ab112db5a4fcc269145a7b0) Thanks [@spencermarx](https://github.com/spencermarx)! - The README is rebuilt around the skills: a new 1-bit wordmark for light and dark themes, install routes per harness, a "Start here" table, skills that work together, and a catalog that links every skill to its folder and marks the ones that start only when you type them.

- [#6](https://github.com/spencermarx/skills/pull/6) [`903b0a8`](https://github.com/spencermarx/skills/commit/903b0a8ebdaa578b8d702e26712b672593f348a0) Thanks [@spencermarx](https://github.com/spencermarx)! - `whiteboard` (incubating): a recovery whose time ran out no longer begins a reload with a millisecond left and then reports "the canvas was reloaded". Its waits now end no earlier than their deadline by the clock the deadline is measured in, so the panel says the recovery's time ran out.

## 0.2.0

### Minor Changes

- [#1](https://github.com/spencermarx/skills/pull/1) [`5e5a96d`](https://github.com/spencermarx/skills/commit/5e5a96d1ade2765115e72ce3676229de594801d3) Thanks [@spencermarx](https://github.com/spencermarx)! - OCR reviews now default to two reviewers, one principal and one architect. `setup-aclarify-skills` offers this team in every repository it configures, as its own question, and sets it on a yes (`scripts/doctor.sh set-ocr-team`). The config comment it writes keeps OCR from adding a third reviewer for auth, API or logic-heavy changes: a better-fitting lens is swapped in instead. A team the repository already customised, including pinned models or named instances, is kept unless the user agrees to replace it. `ocr-review-loop` documents the new default.

- [#1](https://github.com/spencermarx/skills/pull/1) [`78794e7`](https://github.com/spencermarx/skills/commit/78794e7a8c943bb1229760b103a140cb7bb61323) Thanks [@spencermarx](https://github.com/spencermarx)! - Twenty-two skills join the catalog, and `whiteboard` arrives in incubation.

  - **Engineering:** `arch-board`, `tdd`, `triage` and `ubiquitous-language`. `ubiquitous-language` now owns the glossary format; `domain-modeling` keeps the judgment of which terms matter and writes through it.
  - **Writing** (new family): `gather-argument-material`, `draft-argued-piece`, `draft-conversion-copy`, `humanize` and `seven-copy-critics`. House rules come from the conventions folder in `docs/agents/workspace.md`; without one, each skill writes plainly. `seven-copy-critics` also checks its rebuild against five review constraints, each with its reason, and a conventions folder can override any of them.
  - **Strategy** (new family): `strategic-brief`, `ceo-review`, `rice-prioritization`, `campaign-brief` and `brand-review`.
  - **Visual** (new family): `design-expert`, `get-brand-kit` (a single source of truth for a repository's brand, shipped as a placeholder to replace) and `create-html-slides`.
  - **Harness:** `skill-builder`, `standards`, `add-standard`, `writing-for-agents` and `session-retro`.
  - **Incubating:** `whiteboard`, a live tldraw board you and your agents draw on together. It installs its runtime only after you agree: the npm packages (tldraw, Vite, Playwright) into its own folder or, when that is read-only, the scratch folder, and Chromium into Playwright's per-user browser cache. A bare `npx skills add` leaves it out; install it by name with `--skill whiteboard`. It is not in the plugin yet.

  `setup-aclarify-skills` can now record a brand kit folder in `docs/agents/workspace.md`.

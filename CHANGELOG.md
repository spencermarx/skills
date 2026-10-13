# aclarify-skills

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

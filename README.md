# Aclarify skills

Agent skills for real work: interviewing a plan until it holds, investigating a
failure to its root cause, recording decisions, handing a session off, and
measuring whether your own harness works. Written once, for any agent that reads
`SKILL.md`.

## Install

Pick **one** route per agent. Installing the same skills through two routes
loads every skill twice.

**Claude Code**

```bash
claude plugin marketplace add spencermarx/skills
claude plugin install aclarify-skills@aclarify
claude plugin install ocr@aclarify          # optional: Open Code Review
```

If you added the Open Code Review marketplace before (also named `aclarify`),
remove it first: `claude plugin marketplace remove aclarify`.

**Codex**

```bash
codex plugin marketplace add spencermarx/skills --ref stable
codex plugin add aclarify-skills@aclarify
```

**Copilot CLI and VS Code** read the same marketplace: add
`spencermarx/skills` as a plugin marketplace and install `aclarify-skills`.

**Cursor, OpenCode, Gemini CLI, Windsurf, Amp, Cline and everyone else**

```bash
npx skills@latest add spencermarx/skills#stable -a <agent>
```

`#stable` follows releases; `#v0.1.0` pins one.

### Then run setup

In each repository, run the `setup-aclarify-skills` skill once (`/setup-aclarify-skills`, or ask your agent to
"set up the Aclarify skills"). It asks where your issues, glossary, decisions
and scratch files live, writes the answers to `docs/agents/`, and offers to
install the tools some skills need (the `ocr` CLI for code review). Every
skill works without it, on stated defaults.

## Catalog

### Core

- `setup-aclarify-skills`: configure a repository for these skills and install the tools they use.
- `scratchpad`: one git-ignored home for working files: research dumps, reports, debug output.
- `create-report`: turn a markdown record into a self-contained visual HTML report.
- `conveying-clearly`: the contract for anything a colleague reads once and acts on.
- `handoff`: compact a session into a document a fresh agent can resume from.

### Planning

- `grill-me`: interview the user one round of questions at a time until every branch of a plan is settled.
- `grill-with-docs`: grill, and record what it settles as glossary entries and decisions.
- `domain-modeling`: pin down a project's language and the decisions behind it.
- `decision-record`: propose, then record, a settled choice so nobody relitigates it.
- `wayfinder`: plan work bigger than one session as a shared map of decisions and tickets.
- `to-questionnaire`: turn a decision you can't answer alone into a questionnaire for someone who can.
- `teach`: teach the user a skill or concept, at their pace, with checks for understanding.

### Engineering

- `first-principles-investigation`: competing hypotheses, tested against the real system, until one survives.
- `atomic-commits`: split a mixed changeset into atomic conventional commits.
- `clean-comments`: audit comments so they say what the code cannot.
- `write-comments`: write comments that capture intent, invariants and gotchas.
- `watch-ci`: watch a pull request's CI to green, fixing what breaks.
- `ocr-review-loop`: drive a pull request to an approved Open Code Review, round by round.
- `prototype`: build a throwaway prototype that answers one design question.
- `arch-board`: convene a board of expert personas that investigates a design fork, debates it and returns a cited verdict with dissents kept.
- `tdd`: a test-first red-green loop at agreed seams, producing behaviour tests that survive refactors.
- `triage`: move issues and outside pull requests through triage states to an agent-ready brief.
- `context`: write and maintain a repository's glossary files and their map, without ever overwriting one.

### Writing

- `gather-argument-material`: interview the author and pile up raw fragments for a piece, before any structure.
- `draft-argued-piece`: grow an argued piece from that pile, block by block, grounding each idea before it is used.
- `draft-conversion-copy`: draft an ask (cold email, sequence, landing page, ad) from a fixed four-part frame.
- `humanize`: rewrite existing text so it reads as its author wrote it: profile its cadence and AI tells, rewrite by tier, check it blind.
- `seven-copy-critics`: put marketing copy through hostile reader personas at three layers, with a failure report and a tighter rebuild.

### Strategy

- `strategic-brief`: test demand for an idea before anything is drafted, write the brief, challenge it, and call go or no-go.
- `ceo-review`: commit to one stance (expand, cherry-pick, hold, cut) and review a drafted plan on eight business dimensions.
- `rice-prioritization`: rank candidates with RICE through a deterministic calculator, then pressure-test the scores.
- `campaign-brief`: an adversarial pre-launch review of a campaign brief on six dimensions, with a rewritten brief and a go/no-go.
- `brand-review`: score finished marketing creative against the brand, separating mechanical fixes from judgment calls.

### Visual

- `design-expert`: audit, redesign and polish a product interface with senior UX and UI craft, on the brand kit and the repository's design system.
- `get-brand-kit`: the single source of truth for a repository's brand (colours, type, logos, design system, voice), shipped as a placeholder to replace.
- `create-html-slides`: a branded, animated 16:9 slide deck as one self-contained HTML file, with optional PDF export.

### Harness

- `harness-eval`: measure whether your skills fire when they should: static checks for any harness, and routing evals that measure Claude Code (Node 22.22+, paid API runs).
- `wizard`: generate an interactive shell wizard for steps only a human can do.
- `skill-builder`: author, refactor or port a skill so it is atomic, portable and fires when it should.
- `standards`: route, change or retire a written convention and keep every pointer at it in step.
- `add-standard`: turn "we should always X" into one stated, routed convention.
- `writing-for-agents`: the craft of prose agents read: context pointers, progressive disclosure, leading words and pruning.
- `session-retro`: read one agent session back as evidence and propose fixes, by severity, for the layer that owns each.

### Incubating

Public beta: installable by name (`npx skills add spencermarx/skills#stable --skill <name>`), not yet in the plugin.

- `whiteboard`: a live tldraw board you and your agents draw on together, in your browser. It installs tldraw, Vite and Playwright's Chromium on first use, after asking; tldraw is under [its own licence](https://github.com/tldraw/tldraw/blob/main/LICENSE.md), which allows local development use.

## Credits

Several skills are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills)
(MIT), and `humanize`'s tell catalogs from Sergey Bulaev's
[linkedin-skills](https://github.com/sergebulaev/linkedin-skills) (MIT). Each skill says so in
its frontmatter, and `NOTICE` carries the licences.

## Contributing

Read [`SCOPE.md`](SCOPE.md) before proposing a skill, and
[`AGENTS.md`](AGENTS.md) before writing one. MIT licensed.

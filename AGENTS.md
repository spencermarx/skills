# Aclarify skills: working on this repository

This repository publishes agent skills that must work in any harness that reads
`SKILL.md`: Claude Code, Codex, Copilot (CLI and VS Code), Cursor, OpenCode, and
best-effort the rest. Every rule below exists because breaking it silently fails
in at least one of them. `npm run check` enforces what can be enforced.

## Layout

```
skills/<family>/<skill>/SKILL.md     families: core planning engineering writing strategy harness visual
skills/_incubating/<skill>/          public beta: installed only by name (--skill), not in the plugin
.claude-plugin/plugin.json           one plugin; "skills" lists every promoted skill path
.claude-plugin/marketplace.json      the "aclarify" marketplace: this plugin + ocr
evals/cases/                         routing evals for this repo's own skills (harness-eval's promptfoo format)
tests/                               *.test.mjs suites; tests/<skill>/ holds a skill's tests and fixtures
scripts/                             sync-manifests (plugin.json), validate (the contract below)
```

Families are folders for people. Installs are flat, so **a skill name is global
across all families** and must equal its folder name.

Never edit the `skills` array or `version` in `plugin.json` by hand: run
`npm run sync`. CI fails when it is stale.

## The portability contract

Write every skill so it reads correctly in a harness that has never heard of
Claude Code.

1. **Frontmatter.** Use the Agent Skills spec fields: `name`, `description`,
   `license`, `compatibility`, `metadata`, `allowed-tools`. The only extras
   allowed are `disable-model-invocation`, `user-invocable` and `argument-hint`,
   which other harnesses ignore. `description` is at most 1024 characters with
   the trigger first. Every backticked kebab-case name in a `description` is a
   route to another skill, so it must be one (the CLI names `check` and `gh` are
   the allowed exceptions). `metadata` values are strings, with one exception:
   every skill under `skills/_incubating/` sets `internal: true`, a boolean,
   which the `npx skills` installer reads as "install only when named with
   `--skill`". No skill elsewhere may set it.
2. **User-invoked skills** (`disable-model-invocation: true`) also ship
   `agents/openai.yaml`, which is how Codex learns the same thing:

   ```yaml
   interface:
     display_name: "Setup"
     short_description: "Configure this repo for the skills"
   policy:
     allow_implicit_invocation: false
   ```
3. **Describe actions, never name tools.** Write "read the file", "run in the
   shell", "edit the file", "search the codebase", "fetch the page". Tool names
   differ in every harness.
4. **Loading another skill.** Name it and give every route:

   > Load the `scratchpad` skill (through your skill tool, `/scratchpad`, or by
   > reading its SKILL.md), then …

   The typed route `/scratchpad` names the same skill as the sentence; `/<name>`
   stands in only when the sentence loads each skill of a list. Say what to do
   when it is not installed. Never write `Skill(...)`, a `plugin:` prefix, or a
   `../other-skill/` path.
5. **Bundled files.** Reference them relative to the skill's own folder, one
   level deep (`scripts/x.sh`, `references/y.md`), and say once near the top:

   > Paths below are relative to this skill's directory; resolve them to
   > absolute paths before running anything.

   Harnesses run commands from the workspace, not the skill folder. Scripts
   find the repository they work on from the working directory (`git rev-parse
   --show-toplevel`) and their own bundled files by locating themselves
   (`$(dirname "${BASH_SOURCE[0]}")`, `__file__`, `import.meta.url`). They never
   prompt, and they print a usable error. Never use `${CLAUDE_SKILL_DIR}` or
   `${CLAUDE_PLUGIN_ROOT}`.

   Tests and eval fixtures never ship inside a skill folder, where installers
   would copy them to every user and agents could read them as instructions:
   tests go in `tests/<skill>/`, routing cases in `evals/cases/`.
6. **Asking the user.**

   > Ask the user, using your structured-question tool if you have one;
   > otherwise list numbered options in plain text and stop until they reply.
7. **Subagents are optional.**

   > If you can dispatch subagents, run these in parallel; otherwise do them
   > one after another yourself.

   A persona a skill dispatches lives inside that skill as a prompt template
   (`references/<persona>.md`), not in a harness-specific agents folder.
8. **Dependencies on installed software** (a CLI, `node_modules`, a venv) are
   checked first, and installed only after the user confirms. Show the exact
   command; if it fails, print it for the user to run.

## The configuration contract

No skill hardcodes where a repository keeps things. The `setup-aclarify-skills` skill writes
`docs/agents/` in the consuming repository and an `## Agent skills` block in its
`AGENTS.md` pointing there, so every harness sees it.

| File | Holds | Read by |
|---|---|---|
| `docs/agents/issue-tracker.md` | where issues live and how to create, read and label them | triage, wayfinder, to-questionnaire, handoff, prototype, arch-board, ceo-review, strategic-brief, session-retro |
| `docs/agents/triage-labels.md` | the label string for each triage role | triage |
| `docs/agents/domain.md` | glossary file name and layout, decision-record folder | ubiquitous-language, domain-modeling, decision-record, grill-with-docs, conveying-clearly, handoff, prototype, arch-board, tdd, triage, standards, add-standard |
| `docs/agents/workspace.md` | scratch folder, conventions folder, brand kit, eval cases folder, code review, checks before commit | most skills: every skill that writes scratch files, follows house rules or reads the brand. `grep -rl docs/agents/workspace skills` lists them |

The first three use the file names and formats of
`mattpocock/skills`' setup skill, so a repository can run both catalogs.

Skills read configuration this way:

> This repository's agent configuration should have been provided to you (the
> `## Agent skills` block pointing at `docs/agents/`). If it is missing, use the
> defaults below and suggest the user run the `setup-aclarify-skills` skill.

Each skill states its own defaults, so it works before setup has run. The shared defaults: glossary `GLOSSARY.md` at the root (a
multi-context repository adds `GLOSSARY-MAP.md`), decision records in
`docs/adr/`, scratch folder `.scratchpad/` (git-ignored), eval cases in
`.evals/cases/`, no issue tracker until one is configured.

## Credits

Credit what a skill draws on, even when it has been rewritten, in one of two
frontmatter keys. When text was copied or adapted, even in paraphrase, the
credit goes in `metadata.credits`, naming the project's URL, and that project's
licence goes in `NOTICE`, in a section whose header line ends with the same URL:

```yaml
metadata:
  credits: "Adapted from Matt Pocock's grill-me skill, https://github.com/mattpocock/skills (MIT)"
```

A credit for ideas alone (a book, a method, a skill read but not adapted) goes
in `metadata.ideas` and needs no `NOTICE` section:

```yaml
metadata:
  ideas: "John Ousterhout's A Philosophy of Software Design"
```

A skill that has both carries both keys; one string never mixes them.
`npm run check` fails a `credits` value that names no URL, names a URL with no
`NOTICE` section, or opens with `Ideas from `, and an `ideas` value that says
text was adapted or copied.

## Lifecycle

New skills start in `skills/_incubating/`, with `metadata.internal: true`, so a
bare `npx skills add` leaves them out and `--skill <name>` installs one; the
plugin does not list them. A skill moves into a family once it has been used for
real and its routing cases in `evals/cases/` show it fires when it should and
stays quiet when it should not. Promote one by moving its folder into a family,
deleting `internal`, and running `npm run sync`. A skill ported from an
established source (a maintained public catalog, or a skill long in use in
another repository) may enter a family directly, but it still carries routing
cases in `evals/cases/`: a should-fire case and the near miss most likely to
steal it. `npm run check` fails an `_incubating/` skill without `internal: true`,
and `npm test` fails a promoted skill with no `skill-used` case, apart from a
named list of older skills in `tests/routing-coverage.test.mjs` that is only
allowed to shrink.

A retired skill is deleted; its changeset names the replacement. A skill that
does not meet `SCOPE.md` belongs in `.out-of-scope/` as a reasoned note, not in
the tree.

## Checks and releases

- `npm run check`: manifest sync plus the contract above.
- `npm test`: the checks plus every suite in `tests/`, including a real
  `npx skills` install into a temp folder.
- Routing evals cost money and never run in CI. Run them on demand:
  `bash skills/harness/harness-eval/scripts/run.sh --skills skills evals/cases/<file>.yaml`.
- Every user-visible change carries a changeset (`npx changeset`). Releases tag
  `v<version>` and fast-forward `stable`, which installs track.

<!-- OCR:START -->
## Open Code Review Instructions

These instructions are for AI assistants handling code review in this project.

Always open `.ocr/skills/SKILL.md` when the request:
- Asks for code review, PR review, or feedback on changes
- Mentions "review my code" or similar phrases
- Wants multi-perspective analysis of code quality
- Asks to map, organize, or navigate a large changeset

Use `.ocr/skills/SKILL.md` to learn:
- How to run the 8-phase review workflow
- How to generate a Code Review Map for large changesets
- Available reviewer personas and their focus areas
- Session management and output format

Keep this managed block so `ocr init` can refresh the instructions.
<!-- OCR:END -->

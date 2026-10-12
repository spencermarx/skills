# Portability

A skill should read correctly in a harness that has never heard of the one you
wrote it in: Claude Code, Codex, Copilot, Cursor, OpenCode, Gemini CLI and the
rest all read `SKILL.md`, and each differs in its tools, its variables and what
it does with frontmatter it does not recognise. Every item below exists because
breaking it silently fails in at least one of them. Work through all of them.

## Frontmatter

- **Use the Agent Skills spec fields:** `name`, `description`, `license`,
  `compatibility`, `metadata`, `allowed-tools`. Three extras are safe because
  other harnesses ignore them: `disable-model-invocation`, `user-invocable` and
  `argument-hint`. Any other key may be rejected or quietly dropped.
- **`name`** is lowercase kebab-case, at most 64 characters, and equal to the
  folder name. Some harnesses rename a mismatched skill and others reject it.
  Avoid the names of harness built-ins (`review`, `init`, `plan`, `help`,
  `config`, `status` and the like): a bare-name install shadows the built-in or
  is shadowed by it.
- **`description`** is at most 1024 characters, trigger first
  ([descriptions.md](descriptions.md)).
- **`metadata`** is a map of strings to strings. A number or a list there fails
  validation in strict harnesses.
- **`compatibility`** says what the skill needs to run (a CLI, a runtime
  version, a login), so a person can tell before installing.

## A skill a person starts

A skill that sets `disable-model-invocation: true` must also ship
`agents/openai.yaml`, which is how Codex learns the same thing:

```yaml
interface:
  display_name: "Setup"
  short_description: "Configure this repo for the skills"
policy:
  allow_implicit_invocation: false
```

## Describe actions, never name tools

Write "read the file", "edit the file", "run in the shell", "search the
codebase", "fetch the page". Tool names differ in every harness, so a body that
names one harness's file-reading or shell tool misleads every other agent that
reads it. The same goes for a harness's own variables, such as Claude Code's
`CLAUDE_SKILL_DIR` or `CLAUDE_PLUGIN_ROOT`: only one harness substitutes them,
and everywhere else they arrive as literal text.

## Loading another skill

Name the skill and give every route:

> Load the `scratchpad` skill (through your skill tool, `/scratchpad`, or by
> reading its SKILL.md), then …

Then say what to do when it is not installed. A required skill: say so and stop.
An optional one: do the step yourself from stated defaults.

Never write a call syntax for one harness's skill tool, a plugin prefix
(`plugin:skill`), or a relative path into a sibling skill's folder: installs do
not keep skills side by side, so the path points nowhere.

## Bundled files and scripts

Reference bundled files relative to the skill's own folder, one level deep
(`scripts/check.py`, `references/topic.md`), and say once near the top of the
body:

> Paths below are relative to this skill's directory; resolve them to absolute
> paths before running anything.

Harnesses run commands from the workspace, not from the skill folder, so a
script must find its way on its own:

- **The repository it works on** comes from the working directory:
  `git rev-parse --show-toplevel`.
- **Its own bundled files** come from locating itself: `$(dirname
  "${BASH_SOURCE[0]}")` in bash, `__file__` in Python, `import.meta.url` in
  JavaScript.
- **It never prompts.** Many harnesses run commands with no terminal attached,
  so a script waiting for input hangs or fails. Take everything as arguments.
- **It prints a usable error**: what was missing and what to do about it, never
  a bare stack trace.

## Asking the user

> Ask the user, using your structured-question tool if you have one; otherwise
> list numbered options in plain text and stop until they reply.

## Subagents are optional

> If you can dispatch subagents, run these in parallel; otherwise do them one
> after another yourself.

A persona the skill dispatches lives inside the skill as a prompt template,
`references/<persona>.md`, not in one harness's agents folder.

## Installed software

A skill that needs a CLI, a package install or a virtual environment checks for
it first and installs it only after the user says yes. Show the exact command
before running it; if it fails, print it so the user can run it themselves. Say
what is needed in `compatibility` too.

## Where a repository keeps things

Never hardcode where a repository keeps its issues, glossary, decision records,
scratch files or house rules. Read them from the repository's agent
configuration when it has one (a catalog often ships a setup skill that writes
it, for example as files under `docs/agents/` linked from `AGENTS.md`), and state
a default for every value in the skill itself, so it works before setup has run.

House rules (voice, writing standards, coding standards) come from the
repository's own conventions, never from the skill. A skill whose value is one
organisation's house style belongs to that organisation, not to a public
catalog.

Remove everything that only made sense where the skill was first written:
absolute paths, people's names and email addresses, client and product names,
ticket ids, internal folder names. Replace each with the generic concept it stood
for: a configured folder, the scratch folder, "the user".

## Tests and fixtures

Tests, fixtures and routing cases never ship inside the skill folder, where
installers would copy them to every user and an agent could read them as
instructions. See [anatomy.md](anatomy.md#tests).

# The routing engine

How `scripts/run.sh` turns case files into a promptfoo run, and the failure modes
each step exists to prevent. Read this when a run errors, or when every case
fails the same way.

## What a run does

1. `engine.sh path` finds the install: this skill's `engine/` folder, or
   `<scratch folder>/harness-eval-engine/` when `engine/` was read-only. An
   install whose lockfile no longer matches `engine/package-lock.json` does not
   count, so a skill update that moves the pins asks for a fresh install.
2. Case paths resolve against the current directory first, then the repository
   root. A folder expands to every `*.yaml` and `*.yml` under it, skipping
   `*.config.yaml`. A file not in the case format (no `assert:`, or a
   `should_trigger:` list from another eval tool) is refused before anything
   is spent.
3. With `--skills`, every folder holding a `SKILL.md` under each given folder is
   copied, minus `node_modules/`, into a fresh temporary sandbox's
   `.claude/skills/`. Two skills with one folder name are refused: installs are
   flat, so the second would shadow the first.
4. A promptfoo config is written to `<install>/runs/`. It names one provider,
   `anthropic:claude-agent-sdk`, with:
   - `working_dir`: the repository, or the sandbox;
   - `setting_sources`: `project` by default, so `.claude/skills/` in the working
     directory is discovered the way a live session discovers it;
   - `apiKeyRequired: false`, so a local Claude Code login works without an API
     key;
   - `append_allowed_tools: [Skill, Read, Grep, Glob]`.
5. `PROMPTFOO_CONFIG_DIR` is set to `<scratch folder>/harness-eval/promptfoo/`
   and promptfoo runs from the install.

## Why each step is there

**The config lives under the install.** promptfoo resolves
`@anthropic-ai/claude-agent-sdk` from the directory of the config it is handed.
A config anywhere else cannot find `node_modules` and fails naming the package
rather than the missing step.

**`Skill` is in the allowed tools, and it is not optional.** Without it the agent
has no way to invoke a skill: it falls back to opening `SKILL.md` by reading the
file, every `skill-used` assertion becomes unpassable, and every
`not-skill-used` passes for the wrong reason. The suite still prints a plausible
rate. In the repository this engine comes from, one suite scored 35.7 percent
without `Skill` and 85.7 percent with it, with nothing about the skill changed.
The other tools are read-only on purpose: a case that edits the repository while
measuring it cannot be re-run against the same baseline.

**`PROMPTFOO_CONFIG_DIR` points into the scratch folder.** Without it promptfoo
keeps its results database in the user's home directory, outside the repository,
and a later run compares against nothing. That failure is silent: the suite
still runs and still prints a number.

**The sandbox copies rather than links.** Copies remove any question of whether
the harness follows a symlinked skill folder. The sandbox sits in the system
temporary directory, outside the repository, so no parent folder's instructions
or skills leak into the run.

**No judge model.** Routing is read straight off the trajectory: promptfoo's
`skill-used` assertion reads the `Skill` tool calls the agent made. A judge would
add cost, calibration and an API key requirement to a question already answered
exactly. Output quality is a different tier and a different question.

## When every case fails the same way

Read the case's transcript in the viewer before changing anything.

- **No `Skill` call anywhere, the agent read `SKILL.md` files instead:** `Skill`
  is missing from the allowed tools. Check `--print-config`.
- **No skill seems to exist:** the working directory has no `.claude/skills/`.
  The repository keeps its skills elsewhere: rerun with `--skills <that folder>`.
- **The skill fired under another name** (`plugin:skill`): it was loaded from a
  plugin through `--setting-sources user`. Assert the full name, or measure the
  skill folder directly with `--skills`.
- **The SDK cannot be resolved:** the config was run by hand from outside the
  install. Go through `run.sh`.
- **Authentication errors:** log in to Claude Code on this machine, or export
  `ANTHROPIC_API_KEY`.

## Reading the raw results

The viewer is for reading transcripts. For arithmetic, especially the split
between "nothing fired" and "the wrong skill fired" that
[interpreting.md](interpreting.md#report-two-numbers-never-the-blend) asks for,
write the results to a file with `-- --output <scratch folder>/<name>.json`: both
failures fail `skill-used` identically, and only the recorded skill calls tell
them apart.

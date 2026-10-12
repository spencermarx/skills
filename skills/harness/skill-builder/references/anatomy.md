# Anatomy of a skill

## Layout

```
<name>/
├── SKILL.md              the only file a harness registers: frontmatter plus instructions
├── references/<topic>.md depth, read when the body points at it and the task needs it
├── scripts/<name>.<ext>  deterministic helpers, run rather than read
├── assets/               files used in the output: images, fonts, boilerplate
├── templates/            files the skill copies and fills in
└── agents/openai.yaml    only for a skill a person starts (see portability.md)
```

Bundled files sit **one level deep** under those folders. The folder name is the
skill's name, lowercase kebab-case, and installs are flat, so a name is global
across every family or folder a catalog groups its skills into.

**Never nest a second `SKILL.md`** inside a skill. Installers and harnesses
register every `SKILL.md` they find, so a nested one becomes a separate skill
whose description is paid for in every session. A procedure needed only in one
scenario is a reference file, linked from the body.

## Three loads, and only the third is cheap

1. **Always loaded:** every installed skill's name and description. This is the
   budget that decides whether any skill fires.
2. **Loaded on trigger:** the whole `SKILL.md` body, for the rest of the
   session.
3. **Loaded on demand:** bundled files the body links. A script can run without
   ever being read.

Depth belongs in the third tier. Keep the body under 500 lines; when it
approaches that, move a section into a reference and leave one line saying when
to read it.

- **Link every reference from the body**, with the condition under which it is
  needed. A file nothing links is never read.
- **Give a long reference (over about 300 lines) a contents list** at the top,
  so the agent can jump to the part it needs.
- **Organise references by variant** when a skill covers several platforms or
  frameworks (`references/aws.md`, `references/gcp.md`), so only the relevant
  one loads.

## Scripts

Use a script for anything mechanical and keep the model for judgment: counting,
parsing, resolving links, diffing and formatting are cheaper and more reliable as
code. A strong signal to bundle one is a trial run in which every test prompt
made the agent write the same helper for itself.

- **Skills invoke scripts; scripts never invoke skills.** The skill is the
  interface and the script is the execution layer. A script that reaches back
  into a skill, its own or another's, inverts that and makes both hard to
  change.
- How a script finds its files, reports errors and handles dependencies is
  covered in [portability.md](portability.md#bundled-files-and-scripts).
- **Exit codes carry the result.** A clear convention for checks: 0 clean,
  1 with findings printed one per line, and a precondition that could not be met
  (no git, a missing folder) explained on stderr with nothing on stdout, so an
  empty result is never mistaken for a pass.

## Tests

Tests and fixtures never ship inside the skill folder: installers copy the whole
folder to every user, and an agent may read a fixture as an instruction. Keep
them wherever the repository keeps tests.

A test of a check proves two things, and both are load-bearing:

- **It bites.** Inject a real defect for every finding the check can report and
  assert it is caught. A check nobody has watched fail is indistinguishable from
  one that never ran.
- **It stays quiet.** Apply each legitimate shape the check must accept and
  assert it says nothing. A check nobody has watched stay silent is one that will
  start crying wolf.

Then break the script on purpose and watch the suite fail before you trust a
green run.

## Stated once

A skill that depends on a convention links to where the convention is stated
rather than restating it. Two copies diverge the first time one changes, and the
copy inside the skill is the one an agent reads first.

## Credits

A skill adapted from another project says so in its frontmatter, under
`metadata`, naming the source and its licence. When text was copied or adapted,
the source's licence travels with it, in whatever file the catalog keeps for
third-party notices. Credit what the skill draws on even when it has been
rewritten.

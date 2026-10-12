# harness-eval fixtures

Synthetic skills that prove a routing eval discriminates. They are deliberately
defective; none is a real skill, and none is listed in the plugin manifest.

`widget-forge.yaml` is their case file. `test_checks.py` uses both to check
`run.sh --print-config` for free; a real discrimination run costs money:

```bash
bash skills/harness/harness-eval/scripts/run.sh \
  --skills tests/harness-eval/fixtures/skills \
  tests/harness-eval/fixtures/widget-forge.yaml --repeat 3
```

`--skills` copies the three fixtures into a throwaway sandbox's `.claude/skills/`,
the folder Claude Code discovers project skills from, so the agent under test sees
exactly these three and nothing else.

## The pair

`skills/widget-forge-a/` and `skills/widget-forge-b/` cover one capability
between them. Their bodies are the same stub and their names carry no signal, so
the frontmatter description is the only place they differ. That is what makes a
difference in trigger rate attributable to the description.

**`widget-forge-a` carries the weak description.** It names what the skill *is*,
as a noun phrase, rather than the moments it should fire, and its nouns
("operations and transformations") are not words anyone types when they want
something done to a widget. It routes away from nothing. It exists so a trigger
eval can be watched failing on purpose before anyone believes it passing, which
means it must be left exactly as it is. Improving it destroys the specimen.

**`widget-forge-b` carries a strong description**: capability first, then
triggers in the words a person actually types, pushy verbs, and explicit negative
routing to a named sibling.

Which arm is the weak one is stated here rather than in either `SKILL.md`,
because this file is not copied into the sandbox, while the skill folders are. A
fixture that tells the agent under test which arm is meant to win answers the
question the cases are asking it.

## `skills/widget-inspect/`

The sibling `widget-forge-b` routes away from by name. It inspects and reports on
a widget without modifying it, a genuinely different capability, described
normally rather than weakly or pushily.

It exists because negative routing to a skill that is absent tests nothing: the
query lands nowhere and the case passes on the model doing no work at all. With
this fixture present, the near-miss case in `widget-forge.yaml` can assert that
the query reached the right place, not merely that it missed the wrong one.

## Reading a run

If the eval cannot tell `widget-forge-a` from `widget-forge-b`, it is measuring
nothing, and that is the finding rather than any number it reports about a real
skill.

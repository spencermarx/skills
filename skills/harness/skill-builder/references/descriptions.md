# Writing the description

Every installed skill's name and description sit in the agent's context in every
session, for everyone who installs it. The agent reads that list, and nothing
else, when it decides whether to open a skill. The description is therefore the
whole dispatch mechanism, and it is written for a dispatcher choosing among
dozens of entries, not for a person browsing a catalog.

## The shape

Three parts, in this order:

1. **The capability, in one clause.** What the skill does, concretely enough to
   tell it apart from its neighbours. "Compact the current session into a
   handoff document a fresh agent can resume from", not "Helps with
   documentation".
2. **The triggers, in the words a person actually types.** Not the concept
   they are an instance of. "Use whenever someone says hand this off, write a
   handoff, I am running out of context, or pick this up in a new session"
   reaches prompts that "use for session continuity" never will. Include the
   cases where the user does not name the skill or its artifact but clearly
   needs it.
3. **The negative routing.** Wherever a sibling could plausibly capture the
   same prompt, say so and name it: "Do NOT use to record a settled decision
   (use `decision-record`)." Name only skills that are installed alongside this
   one or ship in the same catalog; an optional sibling is named as optional.

Write it in the third person or as a bare description, never as "I" or "you".

## Be pushy

Agents tend to under-use skills: they consult one only when a task looks too
large or too specialised to handle with plain tools. A description that merely
permits ("Can be used for…") loses to the agent's own confidence. Write "Use
whenever…", "Always use before…", "Invoke when…".

The same tendency shapes which triggers are worth listing. A one-step request
("read this file") will not reach a skill however well it matches, because the
agent does it directly. List the substantive, multi-step, or specialised
requests where consulting the skill pays.

## Length

The Agent Skills maximum is 1024 characters, and some harnesses truncate there.
Under that, shorter is better for as long as every trigger survives: a bloated
description dilutes its own triggers, so the skill fires less often. A catalog
may set a tighter house cap; follow it when it does.

Put every "when to use" in the description and none in the body. The body is
read only after the decision is made, so a trigger written there routes nothing.

## YAML

A description containing a colon, a quote or a `#` can break the frontmatter,
and a frontmatter that fails to parse silently drops the skill in most
harnesses. Write it as a folded block scalar and none of those characters
matter:

```yaml
description: >-
  First line of the description,
  continued here.
```

## A skill a person starts

A skill with `disable-model-invocation: true` is reached by someone typing its
name. Its description is not a dispatch surface, no routing eval can test it,
and its length says nothing about routing. Write it for the person scanning a
list of commands: what it does, in one line, and what it needs.

## When it does not fire

Read the failure in this order:

1. **The intended skill never fired.** The description was not recognised as
   matching. Rewrite the triggers in the user's words before touching the body.
2. **A sibling fired instead.** The two descriptions overlap. Add negative
   routing to both, naming each other.
3. **The right skill fired and the work was poor.** Routing is fine; the problem
   is in the body.

Whether a rewrite worked is measurable rather than a matter of opinion. Load the
`harness-eval` skill (through your skill tool, `/harness-eval`, or by reading
its SKILL.md): it runs the description against balanced should-fire and
near-miss prompts and reports a delta against the old wording.

## Examples

Weak:

```yaml
description: A skill for working with spreadsheets and data analysis tasks.
```

It names a topic, not a request, and says nothing about its neighbours.

Strong:

```yaml
description: >-
  Add, fix or explain formulas and pivot tables in an existing spreadsheet file.
  Use whenever someone shares an .xlsx or .csv and asks for a new column, a
  margin, a lookup, a total that does not add up, or why a formula returns an
  error, even if they never say "formula". Do NOT use to build a chart from the
  data (use `make-chart`) or to load it into a database.
```

(The skill names here are invented for the example.)

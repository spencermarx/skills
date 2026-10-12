# Integrating a consumer skill with `create-report`

Read this when you are authoring or extending a skill that ends by handing a human a report - it
is everything you need to call `create-report` and to build a component of your own, without
opening the skill's internals.

## The split: presentation is the skill's, content is yours

`create-report` owns the presentation foundation and the flow that turns content into a delivered
report:

- the flow itself - establish what the report covers and who reads it, plan, generate, deliver;
- the base stylesheet, its themes, and its tokens;
- the format reference (scaffold, layout and diagram patterns, style and tone);
- the standard components, plus a worked sample built from them;
- the reader check, a cold read of the assembled page before anyone sees it;
- the delivery step, including the publish question and the local file it produces.

You own everything the report is about: the sections and their order, the entries inside them, the
vocabulary, what gets emphasis, which claims are worth a diagram. Subject matter never enters the
skill, so there is no schema to satisfy and no per-consumer file to check in anywhere. Invoking the
skill injects its instructions into your agent's context, and your agent is already the one holding
the content - an earlier design asked each consumer to register a checked-in contract file, which
added a thing to maintain without adding a guarantee, so it was retired.

## Calling it

At the point in your flow where your agent holds the content, load the `create-report` skill
(through your skill tool, `/create-report`, or by reading its SKILL.md). Everything after that runs
in your agent's own context, so it can keep reaching for the material as the report takes shape.
Say in your own `SKILL.md` what to do when it is not installed: usually, deliver the record as
markdown.

Reach that call holding five things:

| What you hold          | Why it is needed                                                      |
| ---------------------- | --------------------------------------------------------------------- |
| What the report covers | Fixes the scope and the title                                         |
| Who reads it           | Sets the depth, the vocabulary, and how much context each entry needs |
| What they must answer  | The questions the reader check asks of the finished page              |
| The entries, ordered   | Becomes the sections and the repeating units inside them              |
| The destination        | Where the record and the page are written                             |

For the destination, hand it the scratch directory you opened for this run: the absolute path the
`scratchpad` skill's `new <domain> '<slug>'` verb printed. Keeping the record beside the rest of
your run's artifacts is what lets a later revision find it.

A paragraph like this, adapted to your subject, is enough to put in your own `SKILL.md`:

> Once the material is settled, invoke the `create-report` skill to assemble the report. Tell it
> what the report covers, who reads it and the questions they must be able to answer from it, hand
> it the entries in the order they should appear, and give it this run's scratch directory as the
> destination. Take its offer to publish to the human.

## What comes back

- **A record** - the markdown source of the report, written before the page, at your destination.
  Every claim on the page traces to it.
- **A page** - the report's content, rendered against the foundation, at the same destination.
- **`report.html`** - a standalone local document you can point a human at directly. This alone is
  a finished report.
- **A published URL** - if the harness can publish and the human says yes to the publish question.
  It goes into the record with the icon the page was published under, which is what lets a later
  revision return to the same URL wearing the same tab icon.

To revise, run the flow again against the same destination: the record updates, the page
regenerates, and a published report returns to its original URL rather than minting a new one.

## Adding a component of your own

Start from the standard components; reach for your own only when your material has a shape they do
not carry. `components.md` has the worked example to build from - anatomy, markup, and
the CSS pattern.

Four things make a component conform:

1. **It draws from the foundation's tokens** - `--r-ink`, `--r-surface`, `--r-rule`, `--r-accent`,
   the spacing and type steps - rather than literal colors and pixel values. The tokens are what
   redefine themselves per theme, so a component built on them stays correct in light, in dark, and
   in the viewer's system default.
2. **It uses `r-` naming with BEM-ish parts** - `.r-thing`, `.r-thing__part`,
   `.r-thing--variant` - so it sits in one namespace with everything else on the page. Give it a
   segment of its own after the prefix - `.r-audit-rail`, `.r-drift-band` - and it clears the
   foundation's own names without you having to read the stylesheet to learn which are taken.
3. **It meets the same accessibility floor** as the rest of the page: semantic elements, headings
   in order under the page's single `<h1>`, a visible focus ring from `--r-focus`, contrast that
   holds in both themes, and a text equivalent for anything a diagram states.
4. **It is self-contained.** Every byte the component needs is in the page: colors from the tokens,
   type from the system stacks the foundation already sets, any image as a `data:` URI. The
   published page blocks requests to every external host, so a CDN stylesheet, a web font, or a
   remote image renders as an unstyled or missing element with nothing on screen to explain why.

Your CSS goes in a single `<style>` block at the top of the page content, defining only your new
classes on top of the tokens already there. That block is carried verbatim into both the local file
and the published page, so there is nothing else to wire up.

## Before your first real run

- Your `SKILL.md` says where in your flow the `create-report` call happens, and what your agent will
  be holding when it gets there.
- Any component you added draws its colors and spacing from the tokens rather than literals.

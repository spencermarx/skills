---
name: create-report
description: >-
  Assemble a rich visual HTML report, rendered from a markdown record as a self-contained
  local file, with an optional publish as a shareable page. Use WHENEVER work deserves a
  report, briefing, or visual write-up rather than chat prose, and whenever another skill
  needs its results rendered and delivered. Do NOT use to write prose a stranger reads
  straight through (an essay, post, guide or case study), or for an interactive page or
  app.
license: MIT
compatibility: Requires bash. The reader check uses python3.
---

# Create report

A report here is one self-contained page, rendered from a markdown record and built on a shared
presentation foundation, so two reports from two different callers read as the same publication.

Subject, vocabulary, ordering and emphasis stay with the caller - a consumer skill knows its
material, and a human asking inline knows theirs. This skill supplies the form.

The units this skill speaks in: **report** (the deliverable) · **record** (its markdown source) ·
**page** (the rendered HTML) · **section** · **entry** (the repeating unit inside a section) ·
**component** · **diagram**.

Paths below are relative to this skill's directory; resolve them to absolute paths before running
anything.

## What a report is here

A report presents finished work so a reader can scan it: findings, an audit, a synthesis, a
briefing. Prose a stranger reads straight through, an essay, a blog post, a newsletter issue, a
guide, is a different job: it sequences an argument block by block. A finished piece comes back here
when it deserves a visual write-up.

## Where reports go

This repository's agent configuration should have been provided to you (the `## Agent skills` block
pointing at `docs/agents/`). If it is missing, use the defaults below and suggest the user run the
`setup-aclarify-skills` skill.

- **Scratch folder:** the one `docs/agents/workspace.md` names. Default: `.scratchpad/` at the
  repository root. Reports go in a `reports` entry inside it unless the caller hands you a
  destination.

## Process

### 1. Establish what the report covers and who reads it

A consumer skill arrives holding this already. A human asking inline usually has not said it, so
settle three things in one exchange before planning:

- what the report covers,
- who reads it, what they will do with it, and the questions they must be able to answer from it,
- where `record.md` and `content.html` go. A consumer skill hands you the directory it opened for
  its run. Otherwise open one: load the `scratchpad` skill (through your skill tool,
  `/scratchpad`, or by reading its SKILL.md) and run its `new reports '<slug>'` verb, then use the
  absolute path it prints. A hand-built `.scratchpad/…` path resolves against whatever the
  working directory happens to be, and fails silently.

  If `scratchpad` is not installed, create `<scratch folder>/reports/<UTC-YYYYMMDD-HHMMSS>-<slug>/`
  at the repository's top yourself, confirm git ignores the scratch folder (add it to
  `.git/info/exclude` if not), and work from that directory's absolute path.

  When your session cannot write into that entry with its file-editing tools, keep both files in a
  working directory outside the repository and, after every write to either, copy it in with a
  plain shell `cp`. The `scratchpad` skill's `references/writing-into-a-locked-entry.md` explains
  why this happens and why the shell route is the sanctioned one.

When nobody is there to answer - a background run, an unattended consumer - take what the caller
gave you, open the destination yourself, and record the assumptions you made rather than stopping.

### 2. Plan the report

Sketch the shape before writing any of it: the sections and their order, the entries in each, the
diagram each entry carries, and what the closing section should leave the reader with. Order and
emphasis follow whatever the caller says matters.

The plan is worth the minute because of the discipline the page holds to - diagrams carry the
weight and prose is sparse. An entry that reaches this stage with no diagram beside it is usually
an entry whose point has not been made visual yet.

### 3. Write the record

Write `record.md` first, in markdown, by step 1's route. The page renders from it, and every claim
on the page traces back to it - that is what makes a report checkable, because a reviewer reads
the record rather than the markup.

Head it with what the report covers, who it is for, the date, and, once the report has been
published, its URL and the icon it went out under. An unattended run heads it with the assumptions
it had to make, so the reader can overturn them.

### 4. Generate the page

Read [`references/report-format.md`](references/report-format.md) for the page's shape, its
patterns and its tone, and [`references/components.md`](references/components.md) for the markup of
every standard component. [`assets/sample/`](assets/sample) is a worked report - read it to see
the standard end to end, or when a pattern reads better as an example than as a rule.

Write `content.html` by step 1's route: page content only, the elements that live inside `<body>`.
Both delivered files are derived from it.

### 5. Assemble and deliver

Run the assembly script by its absolute path, so it works whatever directory your shell or a
consumer's subagent is pinned to:

```bash
bash '<skill dir>/scripts/assemble-report.sh' '<destination>/content.html' '<destination>'
```

It writes two files and prints both paths: `report.html`, the standalone local document to open and
to hand a human by absolute path, and `report.page.html`, the publish source (the title, the
inlined stylesheet and the content, with no document wrapper). It also flags any subresource that
loads from another host, since those render locally and go missing once published.

Before the human sees it, run the cold read in [`references/reader-check.md`](references/reader-check.md):
a reader with none of your context reads the page as the step-1 reader, and that file says when the
page is done.

Then, if your harness can publish an HTML page as a shareable link (Claude's artifacts, for
example), put the publish question to the human: a published page is a link they can open anywhere
and pass to someone else, while a local-only report is already a finished report. Ask the user,
using your structured-question tool if you have one; otherwise list numbered options in plain text
and stop until they reply. When nobody is there to answer - a background run, an unattended
consumer - or the harness cannot publish, deliver the local report and note in the record that
publishing was not offered.

To publish, give the publishing surface `report.page.html` when it supplies its own document
wrapper (Claude's artifacts do), or `report.html` when it hosts a whole file, with a one-sentence
description and an icon if it asks for one; the file already carries its `<title>`. The page's
design arrives from this foundation, so publishing is a delivery step, not a design step. Record
the returned URL **and the icon** in `record.md`: a reader finds the page by its tab icon, so a
revision that picks a fresh one reads to them as a different page.

### 6. Revise

Update the record, regenerate `content.html`, and re-run the script. Republish to the URL recorded
in `record.md`, under the icon recorded beside it, so the link a reader already holds keeps working
and the tab icon they find it by does not change. A later session updates that existing page by its
URL rather than publishing a new one.

## Reference files

| File                                                                           | Read it when                                                                       |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`references/report-format.md`](references/report-format.md)                   | generating a page - scaffold, layout and diagram patterns, style and tone          |
| [`references/components.md`](references/components.md)                         | writing markup - the catalogue of standard components and their accessibility      |
| [`references/reader-check.md`](references/reader-check.md)                     | the page is assembled - the cold read that runs before the publish question        |
| [`references/cold-reader.md`](references/cold-reader.md)                       | the reader check - the prompt the cold reader receives                             |
| [`references/integrating-a-consumer.md`](references/integrating-a-consumer.md) | wiring a new consumer skill to call this one, or giving it components of its own   |
| [`assets/report-base.css`](assets/report-base.css)                             | a component needs a token, or a consumer's own CSS has to match the foundation     |
| [`assets/sample/`](assets/sample)                                             | the standard is easier to see than to describe - a record and its page, end to end |

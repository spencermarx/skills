# Workspace

Where this repository keeps the working material the skills produce and read.
Edit any line; the skills read this file each time.

- **Scratch folder:** `.scratchpad/`. Git-ignored. `scratchpad`, `handoff`,
  `create-report` and investigations write their working files here.
- **Conventions folder:** none. Set a path (for example `docs/standards/`) and
  `write-comments`, `clean-comments` and the review skills follow the house rules
  they find there.
- **Eval cases:** `.evals/cases/`. The routing cases `harness-eval` runs for this
  repository's own skills.
- **Checks before commit:** none set. Skills that commit run what `AGENTS.md`
  or the contributing guide names, else what CI runs on a pull request. Set a
  command (for example `npm test`) to make it explicit.
- **Code review:** Open Code Review. `ocr-review-loop` drives `ocr` review
  rounds; reviewer teams live in `.ocr/config.yaml`.

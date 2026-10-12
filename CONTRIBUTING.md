# Contributing

Thanks for wanting to improve these skills. Three things keep the catalog
coherent.

1. **Open an issue before a pull request** for a new skill or a change in what a
   skill does. Say what failure you observed and in which session or task.
   [`SCOPE.md`](SCOPE.md) is the bar; [`.out-of-scope/`](.out-of-scope/) lists
   what has already been declined and why.
2. **Follow the portability contract** in [`AGENTS.md`](AGENTS.md): no harness
   tool names, the standard phrasing for loading skills and asking the user,
   bundled files relative to the skill, configuration from `docs/agents/`.
3. **Run the checks** before you push:

   ```bash
   npm ci
   npm test
   ```

   and add a changeset describing the change for users:

   ```bash
   npx changeset
   ```

Fixes to wording, broken commands and harness compatibility are welcome as pull
requests without an issue.

New skills start in `skills/_incubating/`. They move into a family once they
have been used for real and the routing evals in `evals/cases/` show they fire
when they should and stay quiet when they should not.

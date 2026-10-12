// Every routing case file must be in harness-eval's promptfoo format, or run.sh
// refuses it, and every skill a case names must exist, or the case measures nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { listSkillPaths } from "../scripts/sync-manifests.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const casesDir = join(repo, "evals", "cases");
const skills = new Set(listSkillPaths(repo).map((p) => basename(p)));

for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".yaml"))) {
  test(`evals/cases/${file} is a valid case list`, () => {
    const cases = parse(readFileSync(join(casesDir, file), "utf8"));
    assert.ok(Array.isArray(cases) && cases.length > 0, "must be a non-empty list of cases");
    cases.forEach((c, i) => {
      const at = `case ${i + 1}`;
      assert.equal(typeof c.vars?.query, "string", `${at}: vars.query must be a string`);
      assert.ok(Array.isArray(c.assert) && c.assert.length > 0, `${at}: assert must be a non-empty list`);
      for (const a of c.assert) {
        if (a.type === "skill-used" || a.type === "not-skill-used") {
          for (const name of [a.value].flat()) assert.ok(skills.has(name), `${at}: names unknown skill "${name}"`);
        }
      }
    });
  });
}

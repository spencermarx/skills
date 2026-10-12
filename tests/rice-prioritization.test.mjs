// Runs rice-prioritization's rice_score.py suite under `node --test tests/`.
// The suite lives beside this file in tests/rice-prioritization/ so it never ships inside the skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suite = join(dirname(fileURLToPath(import.meta.url)), "rice-prioritization", "test_rice_score.py");

test("rice_score.py scores the published examples, flags ties and sensitivity, and refuses bad input", () => {
  const run = spawnSync("python3", [suite], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

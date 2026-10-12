// Runs humanize's cadence.py suite under `node --test tests/`.
// The suite lives beside this file in tests/humanize/ so it never ships inside the skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suite = join(dirname(fileURLToPath(import.meta.url)), "humanize", "test_cadence.py");

test("humanize cadence.py masks, merges overlays, and fails by name", () => {
  const run = spawnSync("python3", [suite], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

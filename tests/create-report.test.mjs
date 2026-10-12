// Runs the create-report skill's shell smoke suite under `node --test tests/`.
// The suite lives beside this file in tests/create-report/ so it never ships inside the skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suite = join(dirname(fileURLToPath(import.meta.url)), "create-report", "assemble-report.smoke.sh");

test("create-report smoke suite", () => {
  const run = spawnSync("bash", [suite], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

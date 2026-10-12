// Runs the standards skill's validate-routing suite under `node --test tests/`.
// The suite lives in tests/standards/ so it never ships inside the skill. It builds
// throwaway git repositories, so it needs python3 and git and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suite = join(dirname(fileURLToPath(import.meta.url)), "standards", "test_validate_routing.py");

test("validate-routing checks bite, stay quiet, and report preconditions", () => {
  const run = spawnSync("python3", [suite], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

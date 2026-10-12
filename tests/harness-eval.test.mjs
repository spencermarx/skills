// Runs harness-eval's script suite under `node --test tests/`.
// The suite and its fixtures live in tests/harness-eval/ so they never ship inside the skill.
// It builds throwaway git repositories and never starts a routing run, so it costs nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suite = join(dirname(fileURLToPath(import.meta.url)), "harness-eval", "test_checks.py");

test("harness-eval checks bite, stay quiet, and discover skills", () => {
  const run = spawnSync("python3", [suite], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

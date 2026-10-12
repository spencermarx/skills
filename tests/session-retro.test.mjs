// Runs session-retro's session-digest.py suite under `node --test tests/`.
// The suite and its synthetic transcript fixture live in tests/session-retro/ so they
// never ship inside the skill. It needs python3 and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const suite = join(dirname(fileURLToPath(import.meta.url)), "session-retro", "test_session_digest.py");

test("session-digest counts calls once, folds subagents, and fails with usable errors", () => {
  const run = spawnSync("python3", [suite], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

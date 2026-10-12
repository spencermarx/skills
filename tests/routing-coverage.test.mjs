// A promoted skill must show it fires: AGENTS.md's lifecycle asks for at least one
// `skill-used` routing case in evals/cases/ before a skill leaves _incubating/.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const casesDir = join(repo, "evals", "cases");

// Promoted before the rule was enforced. Frozen: the grandfather list may only ever
// hold these seven, so growing it means editing this literal, in plain view of review.
const ORIGINAL_GRANDFATHERED = Object.freeze([
  "atomic-commits",
  "clean-comments",
  "write-comments",
  "teach",
  "to-questionnaire",
  "grill-with-docs",
  "setup-aclarify-skills",
]);

// The ones still without a case. Remove a name when its case lands; a name not in
// ORIGINAL_GRANDFATHERED fails the test below.
const GRANDFATHERED = new Set([
  "atomic-commits",
  "clean-comments",
  "write-comments",
  "teach",
  "to-questionnaire",
  "grill-with-docs",
  "setup-aclarify-skills",
]);

const promoted = JSON.parse(readFileSync(join(repo, ".claude-plugin", "plugin.json"), "utf8")).skills.map((p) => basename(p));

const covered = new Set();
for (const file of readdirSync(casesDir).filter((f) => f.endsWith(".yaml"))) {
  for (const c of parse(readFileSync(join(casesDir, file), "utf8")) ?? []) {
    for (const a of c.assert ?? []) if (a.type === "skill-used") for (const n of [a.value].flat()) covered.add(n);
  }
}

test("every promoted skill has a skill-used routing case", () => {
  const missing = promoted.filter((n) => !covered.has(n) && !GRANDFATHERED.has(n));
  assert.deepEqual(missing, [], `promoted skills with no skill-used case in evals/cases/: ${missing.join(", ")}. Add a should-fire case and its nearest near miss`);
});

test("the grandfather list names only promoted skills that still lack a case", () => {
  const stale = [...GRANDFATHERED].filter((n) => !promoted.includes(n) || covered.has(n));
  assert.deepEqual(stale, [], `remove from GRANDFATHERED in tests/routing-coverage.test.mjs: ${stale.join(", ")}`);
});

test("the grandfather list only shrinks: every name is one of the original seven", () => {
  const added = [...GRANDFATHERED].filter((n) => !ORIGINAL_GRANDFATHERED.includes(n));
  assert.deepEqual(added, [], `GRANDFATHERED may not grow; add a skill-used case in evals/cases/ for: ${added.join(", ")}`);
});

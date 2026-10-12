#!/usr/bin/env node
// Stands in for the `ocr` CLI in doctor.sh tests, so they run where ocr is not installed (CI).
// `team resolve --json` expands default_team from .ocr/config.yaml in all three schema forms,
// as ocr does; `reviewers sync` records that it ran. FAKE_OCR_STUCK=1 makes resolve always
// report OCR's stock team, to prove doctor.sh restores the config when an edit does not take.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const args = process.argv.slice(2).join(" ");

if (args === "--version") {
  console.log("0.0.0-fake");
} else if (args === "team resolve --json") {
  const team = process.env.FAKE_OCR_STUCK
    ? { principal: 2, quality: 2 }
    : parse(readFileSync(".ocr/config.yaml", "utf8")).default_team ?? {};
  const instances = [];
  for (const [persona, spec] of Object.entries(team)) {
    const count = Array.isArray(spec) ? spec.length : typeof spec === "object" ? spec.count : spec;
    for (let i = 1; i <= count; i++) instances.push({ persona, instance_index: i, name: `${persona}-${i}`, model: null });
  }
  console.log(JSON.stringify(instances));
} else if (args === "reviewers sync") {
  writeFileSync(".ocr/synced", "");
} else {
  console.error(`fake ocr: unsupported: ${args}`);
  process.exit(2);
}

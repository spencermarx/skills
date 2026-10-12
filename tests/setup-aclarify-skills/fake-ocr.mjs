#!/usr/bin/env node
// Stands in for the `ocr` CLI in doctor.sh tests, so they run where ocr is not installed (CI).
// `team resolve --json` expands default_team from .ocr/config.yaml in all three schema forms,
// as ocr 2.4 does: each instance carries its configured `model` (expanded through
// `models.aliases`, falling back to `models.default`) or null, and its configured `name` or
// `<persona>-<n>`. `reviewers sync` records that it ran. FAKE_OCR_STUCK=1 makes resolve always
// report OCR's stock team, to prove doctor.sh restores the config when an edit does not take.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const args = process.argv.slice(2).join(" ");

if (args === "--version") {
  console.log("0.0.0-fake");
} else if (args === "team resolve --json") {
  const config = process.env.FAKE_OCR_STUCK
    ? { default_team: { principal: 2, quality: 2 } }
    : parse(readFileSync(".ocr/config.yaml", "utf8")) ?? {};
  const aliases = config.models?.aliases ?? {};
  const model = (m) => {
    const id = m ?? config.models?.default ?? null;
    return id === null ? null : (aliases[id] ?? id);
  };
  const instances = [];
  for (const [persona, spec] of Object.entries(config.default_team ?? {})) {
    const list = Array.isArray(spec)
      ? spec.map((s) => s ?? {})
      : typeof spec === "object" && spec !== null
        ? Array.from({ length: spec.count }, () => ({ model: spec.model }))
        : Array.from({ length: spec }, () => ({}));
    list.forEach((s, i) =>
      instances.push({ persona, instance_index: i + 1, name: s.name ?? `${persona}-${i + 1}`, model: model(s.model) }),
    );
  }
  console.log(JSON.stringify(instances));
} else if (args === "reviewers sync") {
  writeFileSync(".ocr/synced", "");
} else {
  console.error(`fake ocr: unsupported: ${args}`);
  process.exit(2);
}

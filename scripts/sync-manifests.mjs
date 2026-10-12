#!/usr/bin/env node
// Keeps .claude-plugin/plugin.json in step with the repository:
//   - "version" mirrors package.json (the single version source, bumped by changesets);
//   - "skills" lists every skills/<family>/<skill>/ folder that holds a SKILL.md,
//     except the _incubating family, which is public but deliberately unlisted.
// The explicit path list is what lets a nested tree install through Claude Code,
// Codex, Copilot and VS Code, none of which scan below one folder per skill.
// With --check it writes nothing and exits 1 when plugin.json is stale.

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const pluginPath = join(repo, ".claude-plugin", "plugin.json");
const check = process.argv.includes("--check");

export function listSkillPaths(root = repo) {
  const skillsDir = join(root, "skills");
  const paths = [];
  for (const family of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!family.isDirectory() || family.name.startsWith("_")) continue;
    for (const skill of readdirSync(join(skillsDir, family.name), { withFileTypes: true })) {
      if (skill.isDirectory() && existsSync(join(skillsDir, family.name, skill.name, "SKILL.md"))) {
        paths.push(`./skills/${family.name}/${skill.name}`);
      }
    }
  }
  return paths.sort();
}

function main() {
  const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const current = readFileSync(pluginPath, "utf8");
  const plugin = JSON.parse(current);
  const wanted = { ...plugin, version, skills: listSkillPaths() };
  const next = JSON.stringify(wanted, null, 2) + "\n";

  if (next === current) {
    console.log(`plugin.json in sync: v${version}, ${wanted.skills.length} skills`);
    return;
  }
  if (check) {
    const listed = new Set(plugin.skills ?? []);
    const missing = wanted.skills.filter((p) => !listed.has(p));
    const extra = [...listed].filter((p) => !wanted.skills.includes(p));
    console.error("plugin.json is stale. Run `npm run sync`.");
    if (plugin.version !== version) console.error(`  version: ${plugin.version} -> ${version}`);
    for (const p of missing) console.error(`  unlisted: ${p}`);
    for (const p of extra) console.error(`  listed but missing: ${p}`);
    process.exit(1);
  }
  writeFileSync(pluginPath, next);
  console.log(`plugin.json updated: v${version}, ${wanted.skills.length} skills`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

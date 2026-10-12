#!/usr/bin/env node
// Lints every skill against the portability contract in AGENTS.md.
// Each rule exists because breaking it silently fails in at least one harness;
// the comment on each check names the harness that breaks.
// Usage: node scripts/validate.mjs [path/to/skill ...]   (default: all skills)

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

// The Agent Skills spec fields, plus the Claude Code extras other harnesses ignore.
const SPEC_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const EXTRA_KEYS = new Set(["disable-model-invocation", "user-invocable", "argument-hint"]);

// Names a bare `npx skills` install would shadow or be shadowed by (harness built-ins).
const RESERVED = new Set(readFileSync(join(repo, "scripts", "reserved-names.txt"), "utf8")
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));

// Harness-specific tool names and variables. Every harness names its tools differently,
// so a body that says "use the Bash tool" misleads Codex, Gemini, Cursor and Copilot.
const BODY_BANS = [
  [/\$\{CLAUDE_[A-Z_]+\}/, "Claude-only variable; only Claude Code substitutes it. Say \"this skill's directory\"."],
  [/\b(AskUserQuestion|TodoWrite|TaskCreate|TaskUpdate|NotebookEdit|ExitPlanMode|EnterWorktree)\b/, "Claude Code tool name; describe the action instead."],
  [/\b(Skill|Bash|Read|Edit|Write|Agent|Task|Grep|Glob|WebFetch|WebSearch) tool\b/, "harness tool name; describe the action instead."],
  [/\bSkill\(\s*["']?[a-z]/, "Skill(...) call syntax; name the skill and give the three ways to load it."],
  [/\.\.\/[a-z0-9-]+\/SKILL\.md/, "sibling path; installs do not keep skills side by side."],
  [/\.(claude|agents)\/skills\/[a-z0-9-]+\/(scripts|references|assets|templates)\//, "hardcoded install path to a skill's files; the skill may be installed anywhere. Resolve against this skill's directory."],
];

// Workspace couplings that must become docs/agents/ configuration before a skill ships.
const COUPLINGS = [
  /Workspace\/Standards/, /\.workspace\//, /\bParking Lot\b/, /\bPaperclip\b/i, /\.credentials\//,
  /\bspencer@/i, /\/Users\//, /\bACL-\d+/, /\bbizkit\b/i, /\bWrkbelt\b/i, /\bOperators\//,
];

const errors = [];
const fail = (file, msg) => errors.push(`${relative(repo, file)}: ${msg}`);

function skillDirs() {
  const out = [];
  const root = join(repo, "skills");
  for (const family of readdirSync(root, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const skill of readdirSync(join(root, family.name), { withFileTypes: true })) {
      if (skill.isDirectory()) out.push(join(root, family.name, skill.name));
    }
  }
  return out;
}

function splitFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : null;
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const seen = new Map();
const targets = process.argv.slice(2).length ? process.argv.slice(2).map((p) => join(process.cwd(), p)) : skillDirs();

for (const dir of targets) {
  const file = join(dir, "SKILL.md");
  const folder = basename(dir);
  if (!existsSync(file)) { fail(dir, "no SKILL.md"); continue; }

  const parts = splitFrontmatter(readFileSync(file, "utf8"));
  if (!parts) { fail(file, "missing or malformed --- frontmatter ---"); continue; }

  let fm;
  try { fm = parse(parts.fm) ?? {}; } catch (e) { fail(file, `frontmatter is not valid YAML (a parse failure silently drops the skill): ${e.message}`); continue; }

  // Spec: name equals folder; VS Code renames on mismatch, Cline and Kilo reject.
  if (fm.name !== folder) fail(file, `name "${fm.name}" must equal folder "${folder}"`);
  if (typeof fm.name === "string" && (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(fm.name) || fm.name.length > 64)) {
    fail(file, "name must be lowercase kebab-case, at most 64 characters");
  }
  if (RESERVED.has(fm.name)) fail(file, `name "${fm.name}" collides with a harness built-in`);
  if (seen.has(fm.name)) fail(file, `name "${fm.name}" duplicates ${seen.get(fm.name)}; installs are flat, so names are global`);
  else seen.set(fm.name, relative(repo, file));

  // Copilot and VS Code truncate descriptions at 1024 characters.
  if (typeof fm.description !== "string" || !fm.description.trim()) fail(file, "description is required");
  else if (fm.description.length > 1024) fail(file, `description is ${fm.description.length} chars; the cap is 1024`);

  for (const key of Object.keys(fm)) {
    if (!SPEC_KEYS.has(key) && !EXTRA_KEYS.has(key)) fail(file, `frontmatter key "${key}" is neither spec nor an allowed extra`);
  }
  // Spec: metadata is a string-to-string map.
  if (fm.metadata !== undefined) {
    if (typeof fm.metadata !== "object" || Array.isArray(fm.metadata)) fail(file, "metadata must be a map");
    else for (const [k, v] of Object.entries(fm.metadata)) if (typeof v !== "string") fail(file, `metadata.${k} must be a string`);
  }

  // Codex reads its implicit-invocation policy from agents/openai.yaml, not frontmatter.
  if (fm["disable-model-invocation"] === true) {
    const oa = join(dir, "agents", "openai.yaml");
    if (!existsSync(oa) || !/allow_implicit_invocation:\s*false/.test(readFileSync(oa, "utf8"))) {
      fail(file, "user-invoked skill needs agents/openai.yaml with policy.allow_implicit_invocation: false");
    }
  }

  const lines = parts.body.split("\n").length;
  if (lines > 500) fail(file, `body is ${lines} lines; move detail into references/ (budget 500)`);

  // Every markdown file shipped with the skill is read by the model, so all of them are checked.
  for (const f of walk(dir)) {
    if (!/\.(md|txt)$/.test(f)) continue;
    const text = f === file ? parts.body : readFileSync(f, "utf8");
    if (basename(f) === "SKILL.md" && f !== file) fail(f, "nested SKILL.md; installers would register it as a separate skill");
    text.split("\n").forEach((line, i) => {
      for (const [re, why] of BODY_BANS) if (re.test(line)) fail(`${f}:${i + 1}`, why);
      for (const re of COUPLINGS) if (re.test(line)) fail(`${f}:${i + 1}`, `workspace coupling (${re.source}); move it to docs/agents/ configuration`);
    });
  }

  // A derived skill names its source; NOTICE carries the upstream licence.
  if (fm.metadata?.credits && !readFileSync(join(repo, "NOTICE"), "utf8").includes("Matt Pocock") && /pocock/i.test(fm.metadata.credits)) {
    fail(file, "credits Matt Pocock but NOTICE lacks his licence");
  }
}

// The README catalog is hand-written, so it must name every listed skill.
const readme = readFileSync(join(repo, "README.md"), "utf8");
for (const name of seen.keys()) {
  const dir = targets.find((d) => basename(d) === name);
  if (dir && !dir.includes("/_incubating/") && !readme.includes(`\`${name}\``)) fail(join(repo, "README.md"), `catalog does not list \`${name}\``);
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem(s) across ${targets.length} skill(s).`);
  process.exit(1);
}
console.log(`${targets.length} skill(s) valid.`);

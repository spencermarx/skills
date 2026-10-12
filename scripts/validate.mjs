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

// Phrasings that name another skill. A reference to a skill that does not exist sends
// the reader to nothing in every harness. Kept narrow on purpose: "use `x`" alone also
// names CLIs and files, so it counts only before "instead" or a closing parenthesis (a
// description's route), or paired with a name that is a skill.
const SKILL_NAME = "`([a-z0-9]+(?:-[a-z0-9]+)*)`";
const SKILL_REFS = [
  new RegExp(`${SKILL_NAME}\\s+skill\\b`, "g"),
  new RegExp(`\\b(?:[Ll]oad|[Ii]nvoke)\\s+(?:the\\s+)?${SKILL_NAME}`, "g"),
  new RegExp(`\\b[Uu]se\\s+${SKILL_NAME}(?=\\s+instead\\b|\\))`, "g"),
  new RegExp(`\\b[Uu]se\\s+${SKILL_NAME}\\s+(?:and|or)\\s+${SKILL_NAME}`, "g"),
];
// Skills a passage invents as an explicit example, never meant to resolve.
const INVENTED_SKILLS = new Set(["make-chart"]);

// A description is the one text every harness reads before choosing a skill, so there
// every backticked kebab-case token must be a skill. These are the other tokens a
// description may mention: the `gh` CLI, and `check`, `setup-aclarify-skills`' argument.
// Add one here only when it is not a skill name.
const DESCRIPTION_NON_SKILLS = new Set(["check", "gh"]);

// The canonical route for loading a skill: "(through your skill tool, `/x`, or by
// reading its SKILL.md)". `/x` is what a user types, so it must name a skill, and the
// one the sentence loads. `[\s>]` lets the phrase wrap, inside a blockquote too.
const TYPED_ROUTE = /\((?:each[\s>]+)?through[\s>]+your[\s>]+skill[\s>]+tool,[\s>]+((?:`\/[^`\s]+`(?:[\s>]+and[\s>]+)?)+),?[\s>]+or[\s>]+by[\s>]+reading/g;
const PLACEHOLDER_ROUTE = /^<[a-z-]+>$/;
// Where a sentence ends, for the typed-route check: `.`, `!` or `?` and whitespace, or a
// line that opens a list item (`-`, `*`, `1.`).
const SENTENCE_END = /[.!?][\s>]+|\n[ \t>]*(?:[-*]|\d+[.)])[ \t]+/g;
const KEBAB_TOKEN = /`([a-z0-9]+(?:-[a-z0-9]+)*)`/g;

// Credits are two keys, so one string cannot mix them. `credits` names a source whose
// text was copied or adapted: it needs the source's URL and that URL's NOTICE section.
// `ideas` names a book, a method, or a skill read but not adapted: no NOTICE section.
const IDEAS_PREFIX = /^Ideas from /;
const ADAPTED_WORDS = /\b(adapted|copied|paraphrased|ported|derived)\b/i;
const URL = /https?:\/\/[^\s),;]+/g;

// The source URLs NOTICE carries a licence section for: each section's header line
// sits between two rules of dashes and ends in the source's URL.
function noticeSources() {
  const lines = readFileSync(join(repo, "NOTICE"), "utf8").split("\n");
  const rule = (l) => /^-{20,}$/.test(l?.trim() ?? "");
  const out = new Set();
  lines.forEach((l, i) => {
    if (rule(lines[i - 1]) && rule(lines[i + 1])) for (const u of l.match(URL) ?? []) out.add(u.replace(/[.]$/, ""));
  });
  return out;
}

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
const allSkills = new Set(skillDirs().map((d) => basename(d)));
const licensed = noticeSources();

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

  // A description's routes, "(use `x`)" or "(`x`, then `y`)", send the router to
  // another skill, so every backticked kebab-case name in it must be one.
  if (typeof fm.description === "string") {
    for (const [, n] of fm.description.matchAll(KEBAB_TOKEN)) {
      if (!allSkills.has(n) && !DESCRIPTION_NON_SKILLS.has(n)) {
        fail(file, `description names \`${n}\`, which is not a skill in this catalog; fix the route, or, if \`${n}\` is a CLI, an argument or a file and not a skill, add it to DESCRIPTION_NON_SKILLS in scripts/validate.mjs`);
      }
    }
  }

  for (const key of Object.keys(fm)) {
    if (!SPEC_KEYS.has(key) && !EXTRA_KEYS.has(key)) fail(file, `frontmatter key "${key}" is neither spec nor an allowed extra`);
  }
  // Spec: metadata is a string-to-string map. One exception: `npx skills` installs a
  // skill with the boolean `internal: true` only when it is named with --skill, which is
  // how an incubating skill stays out of a bare install. Nowhere else may hide a skill.
  const incubating = relative(repo, dir).split(/[\\/]/)[1] === "_incubating";
  if (incubating && (fm.metadata === null || typeof fm.metadata !== "object" || !("internal" in fm.metadata))) {
    fail(file, "an incubating skill must set metadata.internal: true (the boolean), so a bare `npx skills add` leaves it out until it is promoted");
  }
  if (fm.metadata !== undefined) {
    if (typeof fm.metadata !== "object" || fm.metadata === null || Array.isArray(fm.metadata)) fail(file, "metadata must be a map");
    else for (const [k, v] of Object.entries(fm.metadata)) {
      if (k === "internal") {
        if (!incubating) fail(file, "metadata.internal hides a skill from a bare install; only skills under skills/_incubating/ may set it");
        else if (v !== true) fail(file, "metadata.internal must be exactly the boolean true (the installer ignores any other value)");
      } else if (typeof v !== "string") fail(file, `metadata.${k} must be a string`);
    }
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
    // The whole file, frontmatter included, so a description's "(use `x`)" route and a
    // reference wrapped across lines are both checked.
    const whole = readFileSync(f, "utf8");
    for (const re of SKILL_REFS) for (const m of whole.matchAll(re)) {
      const names = m.slice(1).filter(Boolean);
      if (names.length > 1 && !names.some((n) => allSkills.has(n))) continue;
      for (const n of names) if (!allSkills.has(n) && !INVENTED_SKILLS.has(n)) {
        fail(`${f}:${whole.slice(0, m.index).split("\n").length}`, `refers to the \`${n}\` skill, which is not in this catalog`);
      }
    }
    for (const m of whole.matchAll(TYPED_ROUTE)) checkTypedRoute(whole, m, `${f}:${whole.slice(0, m.index).split("\n").length}`);
  }

  // A derived skill names its source; NOTICE carries the source's licence.
  const md = fm.metadata && typeof fm.metadata === "object" ? fm.metadata : {};
  if (typeof md.credits === "string") {
    const urls = (md.credits.match(URL) ?? []).map((u) => u.replace(/[.]$/, ""));
    if (IDEAS_PREFIX.test(md.credits)) fail(file, `metadata.credits opens with "Ideas from "; a credit for ideas alone (no text copied or adapted) goes in metadata.ideas, which needs no NOTICE section`);
    else if (!urls.length) fail(file, "metadata.credits names no source URL; give the URL of the project the text was adapted from, or, if no text was adapted, move the credit to metadata.ideas");
    for (const u of urls) if (!licensed.has(u)) fail(file, `metadata.credits names ${u}, but NOTICE has no section whose header ends with that URL; add the source's licence there, or, if no text was adapted from it, move the credit to metadata.ideas`);
  }
  if (typeof md.ideas === "string" && ADAPTED_WORDS.test(md.ideas)) {
    fail(file, "metadata.ideas says text was adapted, copied, paraphrased, ported or derived; that part of the credit goes in metadata.credits, with the source's URL and a NOTICE section");
  }
}

// "(through your skill tool, `/x`, or by reading its SKILL.md)": each typed `/x` must be
// a skill, and the one the sentence loads: the nearest skill named in backticks before
// the parenthesis (with k typed routes, one of the nearest k), within its sentence
// (SENTENCE_END), so a name in an earlier list item or sentence, or one the sentence
// sets aside before naming the skill it loads, never vouches for the route. A sentence that
// names no skill ("load it") is read with the rest of its paragraph. `/<name>` is a
// placeholder for a list given around it, and is left alone.
function checkTypedRoute(whole, m, at) {
  const after = (text, re) => text.slice(Math.max(0, ...[...text.matchAll(re)].map((s) => s.index + s[0].length)));
  const paragraph = after(whole.slice(0, m.index), /\n[ \t>]*\n/g);
  const sentence = after(paragraph, SENTENCE_END);
  const named = (text) => [...text.matchAll(KEBAB_TOKEN)].map((t) => t[1]).filter((n) => allSkills.has(n) || INVENTED_SKILLS.has(n));
  const typedAll = [...m[1].matchAll(/`\/([^`]+)`/g)].map((t) => t[1]);
  const inScope = named(sentence).length ? named(sentence) : named(paragraph);
  const nearest = inScope.slice(-typedAll.length);
  for (const typed of typedAll) {
    if (PLACEHOLDER_ROUTE.test(typed)) continue;
    if (!allSkills.has(typed) && !INVENTED_SKILLS.has(typed)) {
      fail(at, `the typed route \`/${typed}\` names no skill in this catalog; a user typing it reaches nothing, or a harness built-in. Use the loaded skill's name`);
    } else if (!nearest.includes(typed)) {
      fail(at, `the typed route \`/${typed}\` does not match the skill this sentence loads (${nearest.length ? nearest.map((n) => `\`${n}\``).join(", ") : "none named in backticks"}, the nearest skill named before it); the route and the name must agree`);
    }
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

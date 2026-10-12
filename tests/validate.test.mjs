// Probes for the validator's credit, description-route and typed-route rules: each probe
// skill sits in a temp catalog beside a real one, and validate.mjs must reject or accept it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULE = "-".repeat(80);
const SRC = "https://github.com/acme/skills";

// Runs validate.mjs over a temp catalog of { name: SKILL.md }, every skill under core/
// unless its name starts with "incub-". `notice` lists the URLs NOTICE has sections for.
function validate(skills, { notice = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "skills-validate-"));
  try {
    for (const f of ["scripts", "node_modules"]) cpSync(join(repo, f), join(root, f), { recursive: true });
    writeFileSync(join(root, "NOTICE"), notice.map((u) => `${RULE}\nsource  ${u}\n${RULE}\n\nLicence text.\n`).join("\n"));
    writeFileSync(join(root, "README.md"), Object.keys(skills).map((n) => `\`${n}\``).join("\n"));
    for (const [name, md] of Object.entries(skills)) {
      const dir = join(root, "skills", name.startsWith("incub-") ? "_incubating" : "core", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), md);
    }
    const out = execFileSync("node", [join(root, "scripts", "validate.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const skill = (name, { description = "Use when testing.", meta = "", body = "Do the thing." } = {}) =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${meta ? `metadata:\n${meta}` : ""}---\n\n${body}\n`;
const helper = skill("helper");

test("the real tree passes", () => {
  const out = execFileSync("node", [join(repo, "scripts", "validate.mjs")], { cwd: repo, encoding: "utf8" });
  assert.match(out, /skill\(s\) valid/);
});

// Credits.
test("rejects: a credit that mixes ideas with adapted text, with no NOTICE section", () => {
  const r = validate({ probe: skill("probe", { meta: `  credits: "Ideas from Jane's notes; text adapted from Acme's acme-skill, ${SRC} (MIT)"\n` }) });
  assert.ok(!r.ok, "a mixed credit was accepted");
  assert.match(r.out, /opens with "Ideas from "/);
  assert.match(r.out, new RegExp(`names ${SRC}, but NOTICE has no section`));
});

test("rejects: adapted text credited under metadata.ideas", () => {
  const r = validate({ probe: skill("probe", { meta: `  ideas: "Text adapted from Acme's acme-skill, ${SRC}"\n` }) });
  assert.ok(!r.ok, "adapted text under ideas was accepted");
  assert.match(r.out, /goes in metadata\.credits/);
});

test("rejects: paraphrased or ported text credited under metadata.ideas", () => {
  for (const word of ["Paraphrased", "Ported", "Derived"]) {
    const r = validate({ probe: skill("probe", { meta: `  ideas: "${word} from Acme's acme-skill, ${SRC}"\n` }) });
    assert.ok(!r.ok, `"${word} from" under ideas was accepted`);
    assert.match(r.out, /goes in metadata\.credits/);
  }
});

test("accepts an ideas key with a URL and no NOTICE section", () => {
  const r = validate({ probe: skill("probe", { meta: `  ideas: "Acme's acme-skill (${SRC}), read but not vendored"\n` }) });
  assert.ok(r.ok, r.out);
});

test("accepts credits and ideas side by side when the credit's source has a NOTICE section", () => {
  const meta = `  credits: "Adapted from Acme's acme-skill, ${SRC} (MIT)"\n  ideas: "Jane's notes"\n`;
  const r = validate({ probe: skill("probe", { meta }) }, { notice: [SRC] });
  assert.ok(r.ok, r.out);
});

// Description routes.
test("rejects: a description route to a skill not in the catalog", () => {
  const r = validate({ probe: skill("probe", { description: "Use when testing. Do NOT use for a cold email (`no-such-skill`)." }) });
  assert.ok(!r.ok, "a dead description route was accepted");
  assert.match(r.out, /description names `no-such-skill`, which is not a skill in this catalog/);
});

test("rejects: the second name of a chained description route", () => {
  const r = validate({ helper, probe: skill("probe", { description: "Use when testing. Not to review copy (`helper`, then `also-missing`)." }) });
  assert.ok(!r.ok, "a dead second route was accepted");
  assert.match(r.out, /description names `also-missing`/);
});

test("accepts description routes to real skills and the allowlisted CLIs", () => {
  const r = validate({ helper, probe: skill("probe", { description: "Use when `gh` or `check` fails. Not for decks (`helper`)." }) });
  assert.ok(r.ok, r.out);
});

// Typed routes in the canonical loading phrase.
const load = (named, typed) => `Load the \`${named}\` skill (through your skill tool, \`/${typed}\`, or by\nreading its SKILL.md), then go on.`;

test("accepts a typed route matching its sentence, a wrapped blockquote, a list and a placeholder", () => {
  const body = [
    load("helper", "helper"),
    "",
    "> Load the `helper` skill (through your skill tool, `/helper`, or by",
    "> reading its SKILL.md).",
    "",
    "Load the `helper` and `probe` skills (each through your skill tool, `/helper` and `/probe`, or by reading its SKILL.md).",
    "",
    "Then `helper`. Load each by name (through your skill tool, `/<name>`, or by reading its SKILL.md).",
    "",
    "If `helper` is installed, use it. Load it (through your skill tool, `/helper`, or by reading its SKILL.md).",
    "",
    "- **Copy.** Load the `probe` skill (through your skill tool,",
    "  `/probe`, or by reading its SKILL.md)",
    "- **Creative.** Load the `helper` skill (through your skill tool, `/helper`, or by reading its SKILL.md)",
  ].join("\n");
  const r = validate({ helper, probe: skill("probe", { body }) });
  assert.ok(r.ok, r.out);
});

test("rejects: a typed route that names no skill (round 1's `/context` defect)", () => {
  const r = validate({ helper, probe: skill("probe", { body: load("helper", "context") }) });
  assert.ok(!r.ok, "a typed route to a missing skill was accepted");
  assert.match(r.out, /SKILL\.md:\d+: the typed route `\/context` names no skill in this catalog/);
});

test("rejects: a typed route naming a real skill other than the sentence's", () => {
  const r = validate({ helper, probe: skill("probe", { body: load("helper", "probe") }) });
  assert.ok(!r.ok, "a mismatched typed route was accepted");
  assert.match(r.out, /the typed route `\/probe` does not match the skill this sentence loads \(`helper`, the nearest/);
});

test("rejects: a typed route vouched for only by an earlier list item with no full stop", () => {
  const body = "- Draft with `helper`\n- Load the `probe` skill (through your skill tool, `/helper`, or by reading its SKILL.md)";
  const r = validate({ helper, probe: skill("probe", { body }) });
  assert.ok(!r.ok, "a route matched by the previous list item was accepted");
  assert.match(r.out, /the typed route `\/helper` does not match the skill this sentence loads \(`probe`/);
});

test("rejects: a typed route naming the skill a contrastive sentence sets aside", () => {
  const body = "Do not load `probe` here; load the `helper` skill (through your skill tool, `/probe`, or by reading its SKILL.md).";
  const r = validate({ helper, probe: skill("probe", { body }) });
  assert.ok(!r.ok, "a route naming the set-aside skill was accepted");
  assert.match(r.out, /the typed route `\/probe` does not match the skill this sentence loads \(`helper`/);
});

// Incubation.
test("rejects: an incubating skill without metadata.internal", () => {
  const r = validate({ "incub-probe": skill("incub-probe") });
  assert.ok(!r.ok, "an incubating skill without internal was accepted");
  assert.match(r.out, /an incubating skill must set metadata\.internal: true/);
});

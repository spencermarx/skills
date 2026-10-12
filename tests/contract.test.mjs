// Proves the checks bite: each fixture breaks one rule of the portability contract,
// and validate.mjs must reject it. A check that passes everything protects nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

const RULE = "-".repeat(80);
// A NOTICE carrying a licence section for each source URL given.
const notice = (...urls) => urls.map((u) => `${RULE}\nsource  ${u}\n${RULE}\n\nLicence text.\n`).join("\n");

function validateFixture(name, skillMd, extra = {}, { family = "core", noticeText = notice() } = {}) {
  const root = mkdtempSync(join(tmpdir(), "skills-contract-"));
  try {
    for (const f of ["scripts", "node_modules"]) cpSync(join(repo, f), join(root, f), { recursive: true });
    writeFileSync(join(root, "NOTICE"), noticeText);
    writeFileSync(join(root, "README.md"), `\`${name}\`\n`);
    const dir = join(root, "skills", family, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillMd);
    for (const [p, body] of Object.entries(extra)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), body); }
    execFileSync("node", [join(root, "scripts", "validate.mjs")], { cwd: root, encoding: "utf8", stdio: "pipe" });
    return { ok: true, out: "" };
  } catch (e) {
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const skill = (name, body = "Do the thing.", fm = "") => `---\nname: ${name}\ndescription: Use when testing.\n${fm}---\n\n${body}\n`;

test("a clean skill passes", () => {
  const r = validateFixture("clean-skill", skill("clean-skill"));
  assert.ok(r.ok, r.out);
});

const breaks = [
  ["name differs from folder", "wrong-name", skill("other-name"), /must equal folder/],
  ["Claude-only variable", "var-skill", skill("var-skill", "Run ${CLAUDE_SKILL_DIR}/x.sh"), /Claude-only variable/],
  ["harness tool name", "tool-skill", skill("tool-skill", "Use the Bash tool to run it."), /harness tool name/],
  ["Claude Code tool", "ask-skill", skill("ask-skill", "Call AskUserQuestion."), /Claude Code tool name/],
  ["workspace coupling", "couple-skill", skill("couple-skill", "Read Workspace/Standards/x.md"), /workspace coupling/],
  ["unknown frontmatter key", "key-skill", skill("key-skill", "x", "model: opus\n"), /neither spec nor an allowed extra/],
  ["user-invoked without openai.yaml", "user-skill", skill("user-skill", "x", "disable-model-invocation: true\n"), /agents\/openai.yaml/],
  ["reserved name", "code-review", skill("code-review"), /collides with a harness built-in/],
];

for (const [label, name, md, pattern] of breaks) {
  test(`rejects: ${label}`, () => {
    const r = validateFixture(name, md);
    assert.ok(!r.ok, `${label} was accepted`);
    assert.match(r.out, pattern);
  });
}

// Credits: a credit naming a source needs that source's licence section in NOTICE, and
// only a credit marked "Ideas from " may go without one.
const SRC = "https://github.com/example/skills";
const credited = (name, credit) => skill(name, "x", `metadata:\n  credits: "${credit}"\n`);

test("accepts a credit whose source has a NOTICE section", () => {
  const r = validateFixture("cred-ok", credited("cred-ok", `Adapted from Example's x skill, ${SRC} (MIT)`), {}, { noticeText: notice(SRC) });
  assert.ok(r.ok, r.out);
});

test("accepts an ideas-only credit with no NOTICE section", () => {
  const r = validateFixture("cred-ideas", credited("cred-ideas", `Ideas from Example's x skill (${SRC}), not vendored`));
  assert.ok(r.ok, r.out);
});

test("rejects: a credit whose source has no NOTICE section", () => {
  const r = validateFixture("cred-nonotice", credited("cred-nonotice", `Adapted from Example's x skill, ${SRC} (MIT)`), {}, { noticeText: `${notice("https://github.com/other/skills")}\nMentions ${SRC} in passing.\n` });
  assert.ok(!r.ok, "a credit without a NOTICE section was accepted");
  assert.match(r.out, /NOTICE has no section for it/);
});

test("rejects: a credit that names no source and is not marked ideas-only", () => {
  const r = validateFixture("cred-nourl", credited("cred-nourl", "Adapted from a skill somewhere"));
  assert.ok(!r.ok, "a credit with no source was accepted");
  assert.match(r.out, /names no source URL/);
});

// metadata.internal: the one non-string metadata value, allowed only to keep an
// incubating skill out of a bare install.
const internal = (name, value) => skill(name, "x", `metadata:\n  internal: ${value}\n`);

test("accepts metadata.internal: true on an incubating skill", () => {
  const r = validateFixture("incub-ok", internal("incub-ok", "true"), {}, { family: "_incubating" });
  assert.ok(r.ok, r.out);
});

for (const [label, value, family, pattern] of [
  ["metadata.internal on a promoted skill", "true", "core", /only skills under skills\/_incubating\/ may set it/],
  ["metadata.internal as a string", '"true"', "_incubating", /must be exactly the boolean true/],
  ["metadata.internal: false", "false", "_incubating", /must be exactly the boolean true/],
]) {
  test(`rejects: ${label}`, () => {
    const r = validateFixture("incub-bad", internal("incub-bad", value), {}, { family });
    assert.ok(!r.ok, `${label} was accepted`);
    assert.match(r.out, pattern);
  });
}

// Skill references: every phrasing that names another skill must name one in the tree.
test("accepts references to a skill in the tree, to CLIs, and to the invented example", () => {
  const body = [
    "Load the `ref-ok` skill first. Use the `gh` CLI, run `shellcheck`, and use `logo-white`.",
    "Use `npm` or `pnpm`. To chart data (use `make-chart`).",
  ].join("\n");
  const r = validateFixture("ref-ok", skill("ref-ok", body));
  assert.ok(r.ok, r.out);
});

for (const [label, body] of [
  ["`x` skill", "Run the `no-such-skill` skill."],
  ["load `x`", "Load `no-such-skill` before you start."],
  ["use `x` instead", "For a deck, use `no-such-skill`\ninstead."],
  ["(use `x`)", "Not for decks (use `no-such-skill`)."],
  ["use `x` and a real skill", "If in doubt, use `no-such-skill` and `ref-bad`."],
]) {
  test(`rejects: an unresolved skill reference, ${label}`, () => {
    const r = validateFixture("ref-bad", skill("ref-bad", body));
    assert.ok(!r.ok, `${label} was accepted`);
    assert.match(r.out, /refers to the `no-such-skill` skill, which is not in this catalog/);
  });
}

test("checks references in the description too", () => {
  const md = `---\nname: ref-desc\ndescription: Use when testing. Do NOT use for decks (use\n  \`no-such-skill\`).\n---\n\nx\n`;
  const r = validateFixture("ref-desc", md);
  assert.ok(!r.ok, "a description route to a missing skill was accepted");
  assert.match(r.out, /SKILL\.md:3: refers to the `no-such-skill` skill/);
});

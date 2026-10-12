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

function validateFixture(name, skillMd, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "skills-contract-"));
  try {
    for (const f of ["scripts", "node_modules"]) cpSync(join(repo, f), join(root, f), { recursive: true });
    writeFileSync(join(root, "NOTICE"), "Matt Pocock\n");
    writeFileSync(join(root, "README.md"), `\`${name}\`\n`);
    const dir = join(root, "skills", "core", name);
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

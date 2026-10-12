// Installs this repository with the real `npx skills` installer, the route every
// harness without a plugin system uses, and checks every promoted skill lands where
// each agent looks for it. Catches what the manifest check cannot: a skill the
// installer cannot discover, or one it flattens onto another skill's name. Also pins
// the incubating contract: a bare install leaves every skills/_incubating/ skill out,
// and naming one with --skill installs it (the installer's `metadata.internal: true`).
// Needs network access for npx. Set SKIP_INSTALL_TEST=1 to skip offline.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { listSkillPaths } from "../scripts/sync-manifests.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_CLI = "skills@1.7.2";
// Where each agent's project-level skills land with `npx skills add --copy`.
const AGENTS = { "claude-code": ".claude/skills", codex: ".agents/skills", opencode: ".agents/skills", cursor: ".agents/skills" };
const promoted = listSkillPaths(repo).map((p) => basename(p));
const incubatingDir = join(repo, "skills", "_incubating");
const incubating = existsSync(incubatingDir)
  ? readdirSync(incubatingDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(incubatingDir, d.name, "SKILL.md"))).map((d) => d.name)
  : [];
const skip = process.env.SKIP_INSTALL_TEST === "1";

// INSTALL_INTERNAL_SKILLS=1 would make the installer include internal skills everywhere.
const { INSTALL_INTERNAL_SKILLS, ...baseEnv } = process.env;
const npx = (args, cwd) =>
  execFileSync("npx", ["-y", SKILLS_CLI, ...args], { cwd, encoding: "utf8", env: { ...baseEnv, DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "1" } });

test("the installer discovers every promoted skill", { skip }, () => {
  // --list prints colored, boxed text (and refuses --json), so strip the color codes
  // and match each name as the whole of its line.
  const listed = npx(["add", repo, "--list"], repo).replace(/\x1b\[[0-9;]*m/g, "");
  for (const name of promoted) assert.match(listed, new RegExp(`^\\W*${name}\\s*$`, "m"), `${name} not discovered`);
  for (const name of incubating) assert.doesNotMatch(listed, new RegExp(`^\\W*${name}\\s*$`, "m"), `incubating ${name} is listed for a bare install`);
});

test("a copy install puts every promoted skill where each agent looks", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-install-"));
  try {
    npx(["add", repo, "--skill", "*", "--agent", ...Object.keys(AGENTS), "--copy", "-y"], dir);
    for (const [agent, path] of Object.entries(AGENTS)) {
      for (const name of promoted) {
        assert.ok(existsSync(join(dir, path, name, "SKILL.md")), `${agent}: ${path}/${name}/SKILL.md missing`);
      }
    }
    const installed = readdirSync(join(dir, ".claude/skills"));
    assert.ok(!installed.some((n) => n.startsWith("_")), "an underscore family folder was installed as a skill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare install leaves every incubating skill out, and naming one installs it", { skip: skip || !incubating.length }, () => {
  const bare = mkdtempSync(join(tmpdir(), "skills-install-bare-"));
  const named = mkdtempSync(join(tmpdir(), "skills-install-named-"));
  try {
    npx(["add", repo, "--agent", "claude-code", "--copy", "-y"], bare);
    const installed = readdirSync(join(bare, ".claude/skills"));
    for (const name of promoted) assert.ok(installed.includes(name), `bare install missed promoted ${name}`);
    for (const name of incubating) assert.ok(!installed.includes(name), `bare install included incubating ${name}; set metadata.internal: true in its SKILL.md`);
    for (const name of incubating) {
      npx(["add", repo, "--skill", name, "--agent", "claude-code", "--copy", "-y"], named);
      assert.ok(existsSync(join(named, ".claude/skills", name, "SKILL.md")), `--skill ${name} did not install it`);
    }
  } finally {
    rmSync(bare, { recursive: true, force: true });
    rmSync(named, { recursive: true, force: true });
  }
});

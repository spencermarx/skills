// Runs the whiteboard skill's suites under `node --test tests/`. They live in tests/whiteboard/ so
// they never ship inside the skill. The poller test needs only node and curl; the server suites
// boot the real bridge headless, so they need only the server's dependencies
// (`npm ci --prefix skills/_incubating/whiteboard/server`, which CI runs) and skip without them.
// Each suite works in its own temp repository and stops every server it starts (harness.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "whiteboard");
const skill = join(here, "..", "..", "skills", "_incubating", "whiteboard");
const tsx = join(skill, "server", "node_modules", ".bin", "tsx");
const notInstalled = !existsSync(tsx) && "the whiteboard server's dependencies are not installed (npm ci --prefix skills/_incubating/whiteboard/server)";

test("whiteboard poller", () => {
  const run = spawnSync("bash", [join(here, "poll.test.sh")], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

for (const suite of readdirSync(here).filter((f) => f.endsWith(".test.mjs")).sort()) {
  test(`whiteboard ${suite}`, { skip: notInstalled }, () => {
    const run = spawnSync("node", [join(here, suite)], { encoding: "utf8", timeout: 300_000 });
    assert.equal(run.status, 0, `${run.stdout.slice(-4000)}${run.stderr.slice(-4000)}`);
  });
}

// whiteboard.sh, without downloading anything: a copy of the skill's sources with no runtime installed.
function bareSkill({ readOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "whiteboard-sh-"));
  const copy = join(root, "whiteboard");
  cpSync(skill, copy, { recursive: true, filter: (src) => !/[/\\](node_modules|dist)$/.test(src) });
  const repo = join(root, "repo");
  mkdirSync(repo);
  if (readOnly) for (const part of ["app", "server"]) chmodSync(join(copy, part), 0o555);
  const sh = (...args) => spawnSync("bash", [join(copy, "scripts", "whiteboard.sh"), ...args, "--repo", repo], { encoding: "utf8" });
  return { copy, repo, sh };
}

test("whiteboard.sh: not installed is exit 3 with the commands it would run", () => {
  const { copy, sh } = bareSkill();
  const status = sh("status");
  assert.equal(status.status, 3, status.stderr);
  assert.match(status.stdout, /npm ci --prefix .*server/);
  assert.match(status.stdout, /playwright install chromium/);
  assert.ok(status.stdout.includes(copy), "installs into the writable skill folder");
  assert.equal(sh("path").status, 3);
  assert.equal(sh("start", "--board", join(copy, "x.tldr")).status, 3);
  assert.equal(sh("start").status, 2, "start needs --board");
});

test("whiteboard.sh: a read-only skill folder installs into the scratch folder", () => {
  const { repo, sh } = bareSkill({ readOnly: true });
  const status = sh("status", "--scratch", ".scratch-here");
  assert.equal(status.status, 3, status.stderr);
  assert.ok(status.stdout.includes(join(repo, ".scratch-here", "whiteboard-runtime")), status.stdout);
});

// A runtime that looks fully installed: lock stamps, tsx, a build, and a stand-in playwright whose
// Chromium "exists", so only the sources stamp decides.
function fakeInstall(copy, stamp) {
  for (const part of ["app", "server"]) {
    mkdirSync(join(copy, part, "node_modules", ".bin"), { recursive: true });
    cpSync(join(copy, part, "package-lock.json"), join(copy, part, "node_modules", ".whiteboard-installed-lock"));
  }
  writeFileSync(join(copy, "server", "node_modules", ".bin", "tsx"), "#!/bin/sh\n", { mode: 0o755 });
  const pw = join(copy, "server", "node_modules", "playwright");
  mkdirSync(pw, { recursive: true });
  writeFileSync(join(pw, "package.json"), '{"name":"playwright","type":"module","main":"index.js"}');
  writeFileSync(join(pw, "index.js"), "export const chromium = { executablePath: () => process.execPath };\n");
  mkdirSync(join(copy, "app", "dist"), { recursive: true });
  writeFileSync(join(copy, "app", "dist", "index.html"), "");
  const hash = spawnSync("bash", ["-c",
    "cd \"$1\" && find app server -type f -not -path '*/node_modules/*' -not -path 'app/dist/*' -print0 | LC_ALL=C sort -z | xargs -0 shasum | shasum | awk '{print $1}'",
    "_", copy], { encoding: "utf8" }).stdout;
  writeFileSync(join(copy, "app", "dist", ".sources-hash"), stamp ?? hash);
}

test("whiteboard.sh: an install counts only when built from the current sources", () => {
  const fresh = bareSkill();
  fakeInstall(fresh.copy);
  assert.equal(fresh.sh("status").status, 0, "a current build counts as installed");
  const stale = bareSkill();
  fakeInstall(stale.copy, "stale\n");
  assert.equal(stale.sh("status").status, 3, "a build from older sources does not");
});

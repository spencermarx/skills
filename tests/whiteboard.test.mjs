// Runs the whiteboard skill's suites under `node --test tests/`. They live in tests/whiteboard/ so
// they never ship inside the skill. The poller test needs only node and curl; the server suites
// boot the real bridge headless, so they need only the server's dependencies
// (`npm ci --prefix skills/_incubating/whiteboard/server`, which CI runs) and skip without them.
// The cases that need Chromium or the full runtime (the real-browser boundaries, detach.test.mjs)
// skip themselves where it is not installed, as in CI; run them locally after `whiteboard.sh install`.
// Each suite works in its own temp repository and stops every server it starts (harness.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.equal(sh("start", "--name", "x").status, 3);
  assert.equal(sh("start").status, 2, "start needs --board or --name");
});

test("whiteboard.sh status: exit 1, not 3, when Node.js is missing", () => {
  const { copy, repo } = bareSkill();
  const bin = mkdtempSync(join(tmpdir(), "whiteboard-no-node-"));
  const dirnameTool = spawnSync("bash", ["-c", "command -v dirname"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(dirnameTool, join(bin, "dirname"));
  const status = spawnSync("/bin/bash", [join(copy, "scripts", "whiteboard.sh"), "status", "--repo", repo], { encoding: "utf8", env: { PATH: bin } });
  assert.equal(status.status, 1, `${status.stdout}${status.stderr}`);
  assert.match(status.stderr, /node and npm are required/);
});

test("whiteboard.sh start: a board outside the repository is refused before anything is created", () => {
  const { copy, repo, sh } = bareSkill();
  const outside = join(copy, "elsewhere", "deeper", "x.tldr");
  for (const args of [["start"], ["start", "--detach"], ["locate"]]) {
    const run = sh(...args, "--board", outside);
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /outside the repository/);
  }
  assert.ok(!existsSync(join(copy, "elsewhere")), "no folder was created outside the repository");
  assert.ok(!existsSync(join(repo, ".scratchpad")), "nor the boards folder");
});

test("whiteboard.sh start: a board in a folder that does not exist is refused before anything is created", () => {
  const { repo, sh } = bareSkill();
  const missing = join(repo, "no-such-folder", "x.tldr");
  for (const args of [["start"], ["start", "--detach"], ["locate"]]) {
    const run = sh(...args, "--board", missing);
    assert.equal(run.status, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /folder does not exist/);
  }
  assert.ok(!existsSync(join(repo, "no-such-folder")), "the board's folder was not created");
  assert.ok(!existsSync(join(repo, ".scratchpad")), "nor the boards folder or a log");
});

test("whiteboard.sh start: in a repository with no scratch folder, it creates the boards folder and the board's log", () => {
  for (const detach of [[], ["--detach"]]) {
    const { repo, sh } = bareSkill();
    assert.ok(!existsSync(join(repo, ".scratchpad")));
    const start = sh("start", "--name", "First Board", ...detach);
    assert.equal(start.status, 3, `start ${detach.join(" ")}: ${start.stdout}${start.stderr}`);
    assert.match(start.stderr, /not installed/, "the caller is told what is missing");
    const where = JSON.parse(sh("locate", "--name", "First Board").stdout);
    assert.equal(where.board, join(realpathSync(repo), ".scratchpad", "whiteboard", "First-Board.tldr"), "--name resolves through the slug rule");
    assert.ok(existsSync(where.log), `the board's log exists after start ${detach.join(" ")}`);
    assert.match(readFileSync(where.log, "utf8"), /not installed/, "and says what is missing");
  }
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

// Runs the whiteboard skill's suites under `node --test tests/`. They live in tests/whiteboard/ so
// they never ship inside the skill. Every suite (`*.test.mjs` and `*.test.ts`) runs as
// `node --import tsx <suite>` from the skill's server/ folder, so tsx and the server's dependencies
// resolve; they need only those dependencies (`npm ci --prefix skills/_incubating/whiteboard/server`,
// which CI runs) and skip without them. Most cases boot the real bridge headless
// (WHITEBOARD_NO_CANVAS). The cases that need Chromium or the built app (busy-loop, render-cap's
// real-canvas phases, sync-corruption's real-canvas boards, the real-browser boundaries,
// detach.test.mjs) skip themselves where those are missing, as in CI, which has neither; run them
// locally after `whiteboard.sh install`. Each suite works in its own temp repository and stops every
// server it starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "whiteboard");
const skill = join(here, "..", "..", "skills", "_incubating", "whiteboard");
const serverDir = join(skill, "server");
const notInstalled = !existsSync(join(serverDir, "node_modules", "tsx", "package.json"))
  && "the whiteboard server's dependencies are not installed (npm ci --prefix skills/_incubating/whiteboard/server)";

for (const suite of readdirSync(here).filter((f) => /\.test\.(mjs|ts)$/.test(f)).sort()) {
  test(`whiteboard ${suite}`, { skip: notInstalled }, () => {
    const run = spawnSync("node", ["--import", "tsx", join(here, suite)], { cwd: serverDir, encoding: "utf8", timeout: 600_000 });
    assert.equal(run.status, 0, `${run.stdout.slice(-4000)}${run.stderr.slice(-4000)}`);
  });
}

// whiteboard.sh, without downloading anything: a copy of the skill's sources with no runtime installed.
function bareSkill({ readOnly = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "whiteboard-sh-"));
  const copy = join(root, "whiteboard");
  cpSync(skill, copy, { recursive: true, filter: (src) => !/[/\\](node_modules|dist)$/.test(src) });
  mkdirSync(join(root, "repo"));
  const repo = realpathSync(join(root, "repo"));
  if (readOnly) for (const part of ["app", "server"]) chmodSync(join(copy, part), 0o555);
  const sh = (...args) => spawnSync("bash", [join(copy, "scripts", "whiteboard.sh"), ...args, "--repo", repo], { encoding: "utf8" });
  return { copy, repo, sh };
}

test("whiteboard.sh: not installed is exit 5 with the commands it would run", () => {
  const { copy, sh } = bareSkill();
  const status = sh("status");
  assert.equal(status.status, 5, status.stderr);
  assert.match(status.stdout, /npm ci --prefix .*server/);
  assert.match(status.stdout, /playwright install chromium/);
  assert.ok(status.stdout.includes(copy), "installs into the writable skill folder");
  assert.equal(sh("path").status, 5);
  assert.equal(sh("start", "--name", "x").status, 5);
  assert.equal(sh("start", "--name", "x", "--detach").status, 5);
  assert.equal(sh("start").status, 2, "start needs --board or --name");
});

test("whiteboard.sh status: exit 1, not 5, when Node.js is missing", () => {
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

test("whiteboard.sh start: in a repository with no scratch folder, it creates the boards folder, and --detach the board's log", () => {
  for (const detach of [[], ["--detach"]]) {
    const { repo, sh } = bareSkill();
    assert.ok(!existsSync(join(repo, ".scratchpad")));
    const start = sh("start", "--name", "First Board", ...detach);
    assert.equal(start.status, 5, `start ${detach.join(" ")}: ${start.stdout}${start.stderr}`);
    assert.match(start.stderr, /not installed/, "the caller is told what is missing");
    const located = sh("locate", "--name", "First Board");
    assert.equal(located.status, 0, located.stderr);
    const where = JSON.parse(located.stdout);
    const home = join(realpathSync(repo), ".scratchpad", "whiteboard");
    assert.equal(where.board, join(home, "First-Board.tldr"), "--name resolves through the slug rule");
    assert.equal(where.room, "First-Board", "the room id is the file's name");
    for (const [key, ext] of [["lock", "lock"], ["port", "port"], ["messages", "messages.jsonl"], ["recipients", "recipients.json"], ["png", "png"], ["log", "log"]]) {
      assert.equal(where[key], join(home, `First-Board.${ext}`), `${key} lives in the boards folder`);
    }
    assert.equal(where.live, null);
    assert.ok(existsSync(home), `the boards folder exists after start ${detach.join(" ")}`);
    if (detach.length) assert.match(readFileSync(where.log, "utf8"), /not installed/, "the log says what is missing");
    else assert.ok(!existsSync(where.log), "an owned start writes no log: its output is the job's");
  }
});

test("whiteboard.sh: a read-only skill folder installs into the scratch folder", () => {
  const { repo, sh } = bareSkill({ readOnly: true });
  const status = sh("status", "--scratch", ".scratch-here");
  assert.equal(status.status, 5, status.stderr);
  assert.ok(status.stdout.includes(join(repo, ".scratch-here", "whiteboard-runtime")), status.stdout);
});

// A runtime that looks fully installed: lock stamps, a stand-in tsx package, a build, and a
// stand-in playwright whose Chromium "exists", so only the sources stamp decides. The stand-in tsx
// loads a `.ts` file as plain JavaScript, so a copy's server/index.ts can be replaced by `fakeServer`.
function fakeInstall(copy, stamp) {
  for (const part of ["app", "server"]) {
    mkdirSync(join(copy, part, "node_modules"), { recursive: true });
    cpSync(join(copy, part, "package-lock.json"), join(copy, part, "node_modules", ".whiteboard-installed-lock"));
  }
  const tsx = join(copy, "server", "node_modules", "tsx");
  mkdirSync(tsx, { recursive: true });
  writeFileSync(join(tsx, "package.json"), '{"name":"tsx","type":"module","exports":"./index.js"}');
  writeFileSync(join(tsx, "index.js"), [
    'import { register } from "node:module";',
    'register("data:text/javascript," + encodeURIComponent(',
    '  "export async function load(url, ctx, next) { return url.endsWith(\\".ts\\") ? next(url, { ...ctx, format: \\"module\\" }) : next(url, ctx); }"));',
    "",
  ].join("\n"));
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
  assert.equal(stale.sh("status").status, 5, "a build from older sources does not");
});

// A stand-in for the bridge, written over a copy's server/index.ts before fakeInstall stamps it. It
// does what whiteboard.sh relies on: claims the lock the way the real server does (parentPid is its
// own pid with the owner watch off, else its parent), answers /canvas-status for its room, and says
// how it was started. FAKE_EXIT=<code> makes it log a refusal and exit with that code instead.
const FAKE_SERVER = `
const fs = await import("node:fs");
const http = await import("node:http");
const path = await import("node:path");
const board = process.env.WHITEBOARD_BOARD, home = process.env.WHITEBOARD_HOME;
const room = path.basename(board, ".tldr");
console.log("[fake] pid " + process.pid + " ppid " + process.ppid + " watch " + (process.env.WHITEBOARD_OWNER_WATCH ?? "on") + " repo " + process.env.WHITEBOARD_REPO);
if (process.env.FAKE_EXIT) { console.error("[bridge] board '" + room + "' is already served by pid 1 on port 1; not starting a second server"); process.exit(Number(process.env.FAKE_EXIT)); }
if (process.env.FAKE_PRINT_ONLY) process.exit(0);
const parentPid = process.env.WHITEBOARD_OWNER_WATCH === "off" ? process.pid : process.ppid;
const server = http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ activeRoom: room, ownerWatch: process.env.WHITEBOARD_OWNER_WATCH ?? "on", parentPid }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  fs.writeFileSync(path.join(home, room + ".lock"), JSON.stringify({ port, pid: process.pid, board, startedAt: Date.now(), parentPid }));
  console.log("[bridge] listening on http://127.0.0.1:" + port + " (ephemeral)");
});
process.on("SIGTERM", () => process.exit(0));
`;

function fakeServerSkill() {
  const sk = bareSkill();
  writeFileSync(join(sk.copy, "server", "index.ts"), FAKE_SERVER);
  fakeInstall(sk.copy);
  return sk;
}

const killQuietly = (pid) => { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } };
const runSh = (sk, env, ...args) => spawnSync("bash", [join(sk.copy, "scripts", "whiteboard.sh"), ...args, "--repo", sk.repo],
  { encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });

test("whiteboard.sh start: replaces itself with the server, so the caller is the server's direct parent", () => {
  const sk = fakeServerSkill();
  const run = runSh(sk, { FAKE_PRINT_ONLY: "1" }, "start", "--name", "Owned");
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const m = run.stdout.match(/\[fake\] pid (\d+) ppid (\d+) watch (\S+) repo (.*)/);
  assert.ok(m, run.stdout);
  assert.equal(Number(m[2]), process.pid, "no shell or npm sits between the caller and the server");
  assert.equal(m[3], "on", "an owned start keeps the owner watch");
  assert.equal(m[4], realpathSync(sk.repo), "the server is told the repository");
  assert.ok(!existsSync(join(sk.repo, ".scratchpad", "whiteboard", "Owned.log")), "and its output is the caller's, not a log");
});

test("whiteboard.sh start: the server's exit code is start's", () => {
  const sk = fakeServerSkill();
  const run = runSh(sk, { FAKE_EXIT: "4" }, "start", "--name", "Owned");
  assert.equal(run.status, 4, `${run.stdout}${run.stderr}`);
});

test("whiteboard.sh start --detach: runs the server in its own session with its owner watch off, until it is stopped", async () => {
  const sk = fakeServerSkill();
  const run = runSh(sk, {}, "start", "--detach", "--name", "Detached Board");
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const where = JSON.parse(run.stdout);
  try {
    assert.equal(where.room, "Detached-Board");
    assert.ok(where.live && where.live.pid, "the JSON carries the live lock");
    assert.equal(where.live.parentPid, where.live.pid, "a detached server is its own owner");
    const status = await (await fetch(`http://127.0.0.1:${where.live.port}/canvas-status`)).json();
    assert.equal(status.ownerWatch, "off");
    const ps = spawnSync("ps", ["-o", "sess=,pgid=", "-p", String(where.live.pid)], { encoding: "utf8" }).stdout.trim();
    const pgid = ps.split(/\s+/).pop();
    assert.notEqual(Number(pgid), process.pid, "not in the caller's process group");
    assert.match(readFileSync(where.log, "utf8"), /listening on http:\/\/127\.0\.0\.1:/, "its output goes to the board's log");
    // A second start on the live board is refused, with its JSON, and creates nothing.
    for (const args of [["start"], ["start", "--detach"]]) {
      const again = runSh(sk, {}, ...args, "--name", "Detached Board");
      assert.equal(again.status, 3, `${args.join(" ")}: ${again.stderr}`);
      assert.match(again.stderr, /already live/);
    }
    const located = runSh(sk, {}, "locate", "--name", "Detached Board");
    assert.equal(located.status, 0, "locate is exit 0 on a live board too");
    assert.equal(JSON.parse(located.stdout).live.pid, where.live.pid);
    killQuietly(where.live.pid);
    for (let i = 0; i < 50 && spawnSync("kill", ["-0", String(where.live.pid)]).status === 0; i++) spawnSync("sleep", ["0.1"]);
    spawnSync("sleep", ["0.3"]);
    const left = readdirSync(join(sk.repo, ".scratchpad", "whiteboard")).filter((f) => f.includes(".exit."));
    assert.deepEqual(left, [], "a server closed after start returned leaves no exit-code file");
  } finally {
    killQuietly(where.live?.pid);
  }
});

test("whiteboard.sh start --detach: a server that exits early is reported with its log and its exit code", () => {
  for (const [code, want] of [["3", 3], ["4", 4], ["7", 1]]) {
    const sk = fakeServerSkill();
    const run = runSh(sk, { FAKE_EXIT: code }, "start", "--detach", "--name", "Early");
    assert.equal(run.status, want, `FAKE_EXIT=${code}: ${run.stdout}${run.stderr}`);
    assert.match(run.stderr, /exited before the board was live/);
    assert.match(run.stderr, /is already served/, "the end of the log is shown");
    const left = readdirSync(join(sk.repo, ".scratchpad", "whiteboard")).filter((f) => f.includes(".exit."));
    assert.deepEqual(left, [], "no exit-code file is left behind");
  }
});

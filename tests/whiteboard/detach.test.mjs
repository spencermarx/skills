// A board server's lifetime: bound to its parent (the Claude Code boot), or detached (every other
// harness). The render-canvas is skipped (WHITEBOARD_NO_CANVAS).
//
//   1. Owned (the default): the server is started under a parent process, which then dies. The owner
//      watch saves the board, removes the lock and exits.
//   2. Detached (WHITEBOARD_OWNER_WATCH=off): the same parent dies and the server keeps serving. Its
//      lock reads detached, with its own pid as a numeric parentPid, so boards.mjs reads it live;
//      /done ends it.
//   3. `whiteboard.sh start --detach`, as a harness's tool call runs it: the server outlives a TERM
//      and a HUP to its caller's process group.
//   4. Two simultaneous `start --detach` calls on one board both exit 0 with the same server's
//      JSON; the one that lost the race sees another session's ownerSessionId, so it is a guest.
//   3 and 4 need the installed runtime (the script refuses to start without it), so they skip where
//   `whiteboard.sh status` does not answer installed, as in CI.
//
// Every server it starts is stopped, by signalling its own process group.
//
//   node --import tsx tests/whiteboard/detach.test.mjs   (cwd: the skill's server/)

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_DIR, SKILL_DIR, boards, cleanEnv, sandbox } from './harness.mjs';

const SH = path.join(SKILL_DIR, 'scripts', 'whiteboard.sh');
const SB = sandbox('detach');
const ENV = cleanEnv({ WHITEBOARD_NO_CANVAS: '1' });

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

const pgidOf = (pid) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim()) || null;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const locate = (name) => JSON.parse(spawnSync('bash', [SH, 'locate', '--name', name, '--repo', SB.root], { encoding: 'utf8' }).stdout);

const callers = [];
const servers = new Set();

// A caller in its own process group, as a harness runs a tool call: it runs `start --detach`,
// reports its exit code, then lingers (ignoring TERM, so the group survives a TERM and a HUP still
// finds it). Resolves { code, out, pgid } once start has returned.
function caller(name, ownerSessionId) {
  const script = 'bash "$0" start --detach --name "$1" --repo "$2"; echo "exit:$?"; trap "" TERM; exec sleep 120';
  const child = spawn('bash', ['-c', script, SH, name, SB.root], {
    detached: true, env: { ...ENV, WHITEBOARD_OWNER_SESSION_ID: ownerSessionId }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  callers.push(child);
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/exit:(\d+)/);
      if (m) resolve({ code: Number(m[1]), out: out.slice(0, m.index).trim(), err, pgid: child.pid });
    });
    setTimeout(() => resolve({ code: null, out, err, pgid: child.pid }), 90_000).unref();
  });
}

// Stop a server by signalling its own process group. Only a process running this skill's server is
// touched, never whatever reused a dead server's pid.
async function stopServer(pid) {
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  if (!/--import tsx index\.ts\b/.test(command) && !command.includes(path.join(SKILL_DIR, 'server'))) return;
  const pgid = pgidOf(pid);
  if (!pgid || pgid === pgidOf(process.pid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
}

// A server started by a parent shell that waits on it, as a background job's shell would. Resolves
// { parent, port, lock } once it listens; the parent is in a process group of its own.
async function underParent(name, extraEnv) {
  const board = SB.board(name);
  const parent = spawn('/bin/sh', ['-c', '"$0" --import tsx index.ts & wait', process.execPath], {
    cwd: SERVER_DIR, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...ENV, ...SB.env, WHITEBOARD_BOARD: board, WHITEBOARD_OWNER_WATCH_MS: '200', ...extraEnv },
  });
  callers.push(parent);
  let out = '';
  parent.stdout.on('data', (d) => { out += d; });
  parent.stderr.on('data', (d) => { out += d; });
  const deadline = Date.now() + 20_000;
  while (!/listening on http:\/\/127\.0\.0\.1:(\d+)/.test(out) && Date.now() < deadline) await sleep(100);
  const port = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out)?.[1]);
  const lock = boards.readLock(SB.files(board).lock);
  if (lock?.pid) servers.add(lock.pid);
  return { board, parent, port, lock, output: () => out };
}

async function statusOf(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/canvas-status`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function ownedExitsWithParent() {
  console.log('\n[1] owned: the server exits with its parent');
  const { board, parent, port, lock } = await underParent('Owned');
  ok(Number.isInteger(port) && port > 0, 'it listens');
  eq(lock?.parentPid, parent.pid, 'the lock names its parent as parentPid');
  eq(lock?.detached, undefined, 'and is not detached');
  eq((await statusOf(port))?.detached, false, '/canvas-status reads detached: false');
  process.kill(parent.pid, 'SIGKILL');
  for (let i = 0; i < 40 && alive(lock.pid); i++) await sleep(250);
  ok(!alive(lock.pid), 'once the parent dies, the server exits');
  ok(!fs.existsSync(SB.files(board).lock), 'and removes its lock');
  ok(fs.existsSync(board), 'having saved the board');
  ok(fs.existsSync(SB.files(board).port), 'and kept its port record for the next boot');
}

async function detachedOutlivesParent() {
  console.log('\n[2] detached: the server outlives its parent and ends on /done');
  const { board, parent, port, lock } = await underParent('Detached', { WHITEBOARD_OWNER_WATCH: 'off' });
  ok(Number.isInteger(port) && port > 0, 'it listens');
  eq(lock?.detached, true, 'the lock reads detached');
  eq(lock?.parentPid, lock?.pid, 'with its own pid as parentPid');
  ok(typeof lock?.parentPid === 'number', 'a number, so no boot reads it as an older server');
  eq((await statusOf(port))?.detached, true, '/canvas-status reads detached: true');
  process.kill(parent.pid, 'SIGKILL');
  await sleep(2000); // ten owner-watch intervals
  ok(alive(lock.pid), 'after its parent dies, the server still runs');
  eq((await statusOf(port))?.activeRoom, SB.room(board), 'and still serves the board');
  eq((await boards.liveOwner(SB.home, SB.room(board)))?.pid, lock.pid, 'boards.mjs reads it live');
  const done = await fetch(`http://127.0.0.1:${port}/done`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  eq(done.status, 200, '/done answers 200');
  for (let i = 0; i < 40 && alive(lock.pid); i++) await sleep(250);
  ok(!alive(lock.pid), 'and the server exits');
  ok(!fs.existsSync(SB.files(board).lock), 'removing its lock');
}

async function survivesGroupSignals() {
  console.log('\n[3] the server outlives a TERM and a HUP to its caller\'s process group');
  const started = await caller('Group Signals', 'session-a');
  eq(started.code, 0, `start --detach exits 0 ${started.err.trim()}`);
  const where = started.code === 0 ? JSON.parse(started.out) : {};
  const pid = where.live?.pid;
  ok(Number.isInteger(pid), 'it prints the board\'s JSON with a live server');
  if (!pid) return;
  servers.add(pid);
  const serverGroup = pgidOf(pid);
  ok(serverGroup !== null && serverGroup !== started.pgid, `the server is not in its caller's process group (${serverGroup} vs ${started.pgid})`);
  process.kill(-started.pgid, 'SIGTERM');
  await sleep(1500);
  ok(groupAlive(started.pgid), 'the caller\'s group was still there to receive the TERM (its last member ignores TERM)');
  eq(locate('Group Signals').live?.pid, pid, 'after a TERM to the caller\'s group, the board is still live on the same server');
  process.kill(-started.pgid, 'SIGHUP');
  for (let i = 0; i < 20 && groupAlive(started.pgid); i++) await sleep(250);
  ok(!groupAlive(started.pgid), 'the HUP ended the caller\'s group');
  await sleep(1000);
  eq(locate('Group Signals').live?.pid, pid, 'after a HUP to the caller\'s group, the board is still live on the same server');
}

async function simultaneousStarts() {
  console.log('\n[4] two simultaneous start --detach calls both attach to one server');
  const [a, b] = await Promise.all([caller('Race', 'session-a'), caller('Race', 'session-b')]);
  eq(a.code, 0, `the first caller exits 0 ${a.err.trim()}`);
  eq(b.code, 0, `the second caller exits 0 ${b.err.trim()}`);
  const ja = a.code === 0 ? JSON.parse(a.out) : {};
  const jb = b.code === 0 ? JSON.parse(b.out) : {};
  for (const j of [ja, jb]) if (j.live?.pid) servers.add(j.live.pid);
  ok(Number.isInteger(ja.live?.pid) && ja.live?.pid === jb.live?.pid, `both print the same live.pid (${ja.live?.pid}, ${jb.live?.pid})`);
  eq(ja.live?.port, jb.live?.port, 'and the same port');
  const owner = ja.live?.ownerSessionId;
  ok(owner === 'session-a' || owner === 'session-b', `the lock names the winner's session (${owner})`);
  eq(jb.live?.ownerSessionId, owner, 'so the caller that lost the race sees another session\'s ownerSessionId: it is a guest');
  await sleep(1000);
  eq(locate('Race').live?.pid, ja.live?.pid, 'one server holds the board afterwards');
}

async function main() {
  await ownedExitsWithParent();
  await detachedOutlivesParent();
  const status = spawnSync('bash', [SH, 'status', '--repo', SB.root], { encoding: 'utf8' });
  if (status.status !== 0) {
    console.log('\n(3 and 4 skipped: whiteboard.sh status does not answer installed here; whiteboard.sh install)');
  } else {
    await survivesGroupSignals();
    await simultaneousStarts();
  }
  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

async function cleanup() {
  for (const lockFile of fs.existsSync(SB.home) ? fs.readdirSync(SB.home).filter((f) => f.endsWith('.lock')) : []) {
    try { servers.add(JSON.parse(fs.readFileSync(path.join(SB.home, lockFile), 'utf8')).pid); } catch { /* unreadable */ }
  }
  for (const pid of servers) await stopServer(pid);
  for (const c of callers) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
}

main()
  .catch((e) => { console.error('\nERROR', e); process.exitCode = 1; })
  .finally(async () => { await cleanup(); process.exit(process.exitCode ?? 0); });

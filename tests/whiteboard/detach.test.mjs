// `whiteboard.sh start --detach`, as a harness's tool call runs it: from a caller in a process group
// of its own. Needs the full runtime (the script refuses to start without it), so it skips where
// the runtime is not installed, as in CI; the render-canvas is skipped (WHITEBOARD_NO_CANVAS).
//
//   1. The server outlives its caller's process group: it runs in a session of its own, and a
//      TERM and then a HUP to the caller's group leave the board live.
//   2. Two simultaneous `start --detach` calls on one board both exit 0 with the same server's
//      JSON; the one that lost the race sees another session's ownerSessionId, so it is a guest.
//
// Every server it starts is stopped, by signalling its own process group.
//
//   node tests/whiteboard/detach.test.mjs

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DIR, sandbox } from './harness.mjs';

const SH = path.join(SKILL_DIR, 'scripts', 'whiteboard.sh');
const SB = sandbox('detach');
const ENV = { ...process.env, WHITEBOARD_NO_CANVAS: '1' };

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

// Stop a detached server by signalling its own process group (tsx and the node it forks). Only a
// process running this skill's server is touched, never whatever reused a dead server's pid.
async function stopServer(pid) {
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout;
  if (!command.includes(path.join(SKILL_DIR, 'server'))) return;
  const pgid = pgidOf(pid);
  if (!pgid || pgid === pgidOf(process.pid)) return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* gone */ }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
}

async function survivesGroupSignals() {
  console.log('\n[1] the server outlives a TERM and a HUP to its caller\'s process group');
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
  console.log('\n[2] two simultaneous start --detach calls both attach to one server');
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
  const status = spawnSync('bash', [SH, 'status', '--repo', SB.root], { encoding: 'utf8' });
  if (status.status !== 0) {
    console.log('(skipped: the whiteboard runtime is not installed here; whiteboard.sh install)');
    return;
  }
  await survivesGroupSignals();
  await simultaneousStarts();
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

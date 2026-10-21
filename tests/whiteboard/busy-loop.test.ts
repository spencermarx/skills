// [v9.10 #63] Regression test for the orphaned-server busy loop.
//
// The bug (2026-09-25: twenty processes pinned a 16-core machine; 2026-10-19: five more, 21 days
// old, ~100% CPU each): a board server outlived the Claude session that booted it (#50 before #64),
// and that session's end closed the pipe behind the server's stdout/stderr. The next log line (any at all; a
// render-canvas death and its self-heal write several) fails EPIPE, emitted as an 'error' event
// with no listener, so it became an uncaughtException. The handler logged it with console.error,
// to the same dead pipe,
// which raised the next EPIPE: a self-sustaining loop (`uv__run_check → TriggerUncaughtException →
// FormatStackTrace` in a sample). The handler's shutdown(1) ran once and then stalled at its first
// await, because the fault stream starved the timer it awaited, and the shuttingDown guard turned
// every later call into a no-op. Nothing could ever reach process.exit.
//
// The fix: (1) write errors on stdout/stderr are swallowed, so a lost log sink is never fatal and the
// board keeps serving silently while its owner lives; (2) shutdown arms a hard exit deadline before its
// first await, so a graceful path that hangs still ends in an exit, after the synchronous final
// snapshot and lock removal; (3) an uncaught exception during shutdown exits at once instead of
// being swallowed by the guard.
//
// This test runs the REAL render-canvas (Playwright Chromium), because both conditions are a real
// browser process dying or freezing under the server:
//   PHASE A  the server's log pipes close and the render-canvas browser is SIGKILLed while its owner
//            process lives: the server must not spin, must self-heal the canvas and keep serving
//            (#62), and /done must then exit promptly with the lock removed and no Chromium left.
//   PHASE B  the render-canvas browser is SIGSTOPped (frozen, so page.close never answers) and /done
//            is called: the server must still exit within the shutdown deadline, lock removed and
//            board flushed.
//   PHASE C  [#64] the owning process dies, taking the log pipes with it (the old orphan's exact
//            conditions): the owner watch must save the board, remove the lock and exit within the
//            bound, without spinning, and leave no Chromium behind. Since #64 the server no longer
//            survives its session; the #63 fix is what lets that exit complete on a dead pipe.
//
// Toggle-proof: against the pre-fix index.ts, Phase A spins (~100% CPU) and never exits on /done,
// and Phase B hangs in teardownRenderCanvas past the bound.
//
//   node --import tsx tests/whiteboard/busy-loop.test.ts      (run from the skill's server/)
//
// Every server boots on an ephemeral port (its port record is removed first) against a wbspin_*
// board in this suite's own throwaway repository. It needs Playwright's Chromium and the built app,
// and skips without them (as in CI). Exit 0 = pass.

import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { CANVAS_KEY, SERVER_DIR, hasAppBuild, hasChromium, sandbox } from './harness.mjs';

// This suite lives outside the skill, in tests/whiteboard/: the server comes from the skill's
// server/, and every board from this suite's own throwaway repository.
// No suite server may ring a real session's inbox, take its identity, or read an exported PORT.
const SCRUBBED_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: undefined, CLAUDE_CODE_MESSAGING_TOKEN: undefined,
  CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PID: undefined, CLAUDE_JOB_DIR: undefined, PORT: undefined };
// Boot the server the way the skill does: node with the tsx loader in-process (#64).
const BOOT_ARGS = ['--import', 'tsx', 'index.ts'];

// This suite's own throwaway repository (WHITEBOARD_REPO); HOME is its boards folder.
const SB = sandbox('busy-loop');
const HOME: string = SB.home;

const A = 'wbspin_a'; // log pipes gone + render-canvas killed, owner alive
const B = 'wbspin_b'; // render-canvas frozen + /done
const C = 'wbspin_c'; // [#64] owner process dies with the pipes: save, unlock, exit
const boards = [A, B, C];
const boardFiles = (board: string) => ['tldr', 'lock', 'messages.jsonl', 'png', 'port'].map((ext) => path.join(HOME, `${board}.${ext}`));

// The server's SHUTDOWN_DEADLINE_MS is 5s; the bound adds margin for a loaded machine.
const EXIT_BOUND_MS = 10_000;
// CPU seconds the server may burn over the idle window. The loop burns ~1s per wall second.
const IDLE_WINDOW_MS = 4_000;
const IDLE_CPU_MAX_S = 0.5;

// --- tiny assertion harness (mirrors integration.test.ts) -------------------
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// --- process helpers (POSIX ps/pgrep) ---------------------------------------
// A pid a lookup did not find is `undefined`; every helper treats it as a process that is not there.
type Pid = number | undefined;
const run = (cmd: string, args: string[]): string => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const childrenOf = (pid: number): number[] => run('pgrep', ['-P', String(pid)]).split('\n').filter(Boolean).map(Number);
const descendantsOf = (pid: number): number[] => childrenOf(pid).flatMap((c) => [c, ...descendantsOf(c)]);
const commandOf = (pid: number): string => run('ps', ['-o', 'command=', '-p', String(pid)]);
const alive = (pid: Pid): boolean => { if (pid === undefined) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
// Cumulative CPU seconds from `ps -o time=` ([[dd-]hh:]mm:ss[.cc] on both macOS and Linux).
function cpuSeconds(pid: Pid): number | null {
  if (pid === undefined) return null;
  const raw = run('ps', ['-o', 'time=', '-p', String(pid)]);
  if (!raw) return null;
  const [days = '0', clock = ''] = raw.includes('-') ? raw.split('-') : ['0', raw];
  return Number(days) * 86400 + clock.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}
// The server is the node process running index.ts (the spawned child itself, or a wrapper's child);
// the render-canvas browser is its descendant without --type=.
const serverPid = (rootPid: number): Pid => [rootPid, ...descendantsOf(rootPid)].find((p) => {
  const cmd = commandOf(p);
  return cmd.startsWith(process.execPath) && /index\.ts/.test(cmd);
});
const browserPid = (rootPid: number): Pid => descendantsOf(rootPid).find((p) => /chrom/i.test(commandOf(p)) && !/--type=/.test(commandOf(p)));
// Signal a pid a lookup found; a phase that reaches here without one fails loudly, as it always did.
function signal(pid: Pid, sig: NodeJS.Signals): void {
  if (pid === undefined) throw new Error(`no pid to send ${sig} to`);
  process.kill(pid, sig);
}

// --- boot a bridge WITH the render-canvas, resolve its port from stdout -----
interface Exit { code: number | null; signal: NodeJS.Signals | null; at: number }
type Server = Omit<ChildProcessByStdio<null, Readable, Readable>, 'pid'> & { readonly pid: number; _exited: Promise<Exit>; _port: Promise<number> };
// `viaOwner` boots it under a stand-in owner process (a shell whose child is the server), so the
// test can kill the owner. The session inbox variables are scrubbed: no ring can reach a real session.
function boot(board: string, { viaOwner = false }: { viaOwner?: boolean } = {}): Server {
  for (const f of boardFiles(board)) fs.rmSync(f, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...SCRUBBED_ENV, ...SB.env, WHITEBOARD_CANVAS_KEY: CANVAS_KEY,
    WHITEBOARD_BOARD: path.join(HOME, `${board}.tldr`), WHITEBOARD_OWNER_WATCH_MS: '200',
  };
  const child = viaOwner
    ? spawn('/bin/sh', ['-c', `"${process.execPath}" ${BOOT_ARGS.join(' ')} & wait`], { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, BOOT_ARGS, { cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<Exit>((resolve) => child.once('exit', (code, sig) => resolve({ code, signal: sig, at: Date.now() })));
  const port = new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    exited.then(({ code }) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  if (child.pid === undefined) throw new Error(`server ${board} did not spawn`);
  return Object.assign(child, { _exited: exited, _port: port }) as Server;
}

interface CanvasStatus { connected?: boolean }
const canvasStatus = (port: number): Promise<CanvasStatus> =>
  fetch(`http://127.0.0.1:${port}/canvas-status`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<CanvasStatus>);
const post = (port: number, p: string, body?: Record<string, unknown>): Promise<unknown> =>
  fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(3000),
  }).then((r) => r.json());

async function waitFor(pred: () => unknown, timeoutMs: number, stepMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await pred()) return true; } catch { /* not yet */ }
    await sleep(stepMs);
  }
  return false;
}
// A wedged server may never answer /done; the exit assertion that follows is what reports it.
const requestDone = (port: number) => post(port, '/done').catch(() => null);
const canvasConnected = (port: number) => waitFor(async () => (await canvasStatus(port)).connected === true, 30_000);
const exitedWithin = (child: Server, ms: number): Promise<Exit | null> => Promise.race([child._exited, sleep(ms).then(() => null)]);

// Kill anything a phase left behind (a pre-fix server never exits on its own).
function reap(child: Server, pids: Pid[]): void {
  for (const pid of [...pids, ...descendantsOf(child.pid), child.pid]) {
    if (pid === undefined) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

async function phaseA() {
  console.log('\n[PHASE A] log pipes closed + render-canvas killed, owner alive: no spin, keeps serving, /done exits');
  const server = boot(A);
  const port = await server._port;
  const tracked: Pid[] = [];
  try {
    ok(await canvasConnected(port), 'the real render-canvas connects');
    const node = serverPid(server.pid);
    const chrome = browserPid(server.pid);
    tracked.push(node, chrome);
    ok(!!node && !!chrome, `found the server (${node}) and its render-canvas browser (${chrome})`);

    // The booting session ends: the read side of the server's stdout/stderr pipe goes away.
    server.stdout.destroy();
    server.stderr.destroy();
    await post(port, '/agent-message', { text: 'a line the server logs to its now-dead stdout' });
    signal(chrome, 'SIGKILL');

    await sleep(1000); // let the death land and the first EPIPEs fire
    const cpu0 = cpuSeconds(node);
    await sleep(IDLE_WINDOW_MS);
    const cpu1 = cpuSeconds(node);
    const burned = cpu1 !== null && cpu0 !== null ? cpu1 - cpu0 : Infinity;
    ok(burned <= IDLE_CPU_MAX_S, `INVARIANT: the server does not spin (${burned.toFixed(2)} CPU-s over ${IDLE_WINDOW_MS / 1000}s, max ${IDLE_CPU_MAX_S})`);

    ok(alive(node), 'the server survives a lost log sink while its owner lives');
    ok(await canvasConnected(port), 'the render-canvas self-heals with nothing to log to (#62)');
    const relaunched = browserPid(server.pid);
    tracked.push(relaunched);

    await requestDone(port);
    const exit = await exitedWithin(server, EXIT_BOUND_MS);
    ok(exit !== null, `INVARIANT: /done exits the server within ${EXIT_BOUND_MS / 1000}s`);
    ok(!alive(node), 'the server process is gone');
    ok(!fs.existsSync(path.join(HOME, `${A}.lock`)), 'the lock is removed');
    ok(!!relaunched && await waitFor(() => !alive(relaunched), 3000), 'the relaunched render-canvas Chromium is not left behind');
  } finally {
    reap(server, tracked);
  }
}

async function phaseB() {
  console.log('\n[PHASE B] render-canvas frozen + /done: the shutdown deadline still exits the server');
  const server = boot(B);
  const port = await server._port;
  const tracked: Pid[] = [];
  try {
    ok(await canvasConnected(port), 'the real render-canvas connects');
    const node = serverPid(server.pid);
    const chrome = browserPid(server.pid);
    tracked.push(node, chrome);
    ok(!!node && !!chrome, `found the server (${node}) and its render-canvas browser (${chrome})`);

    signal(chrome, 'SIGSTOP'); // alive but unresponsive: page.close() never gets an answer
    const t0 = Date.now();
    await requestDone(port);
    const exit = await exitedWithin(server, EXIT_BOUND_MS);
    ok(exit !== null, `INVARIANT: a stalled graceful shutdown still exits within ${EXIT_BOUND_MS / 1000}s${exit ? ` (took ${exit.at - t0}ms)` : ''}`);
    ok(!alive(node), 'the server process is gone');
    ok(!fs.existsSync(path.join(HOME, `${B}.lock`)), 'the lock is removed');
    ok(fs.existsSync(path.join(HOME, `${B}.tldr`)), 'the final board snapshot is on disk');
    ok(await waitFor(() => !alive(chrome), 3000), 'the frozen render-canvas Chromium is not left behind');
  } finally {
    for (const pid of tracked) { if (pid !== undefined) { try { process.kill(pid, 'SIGCONT'); } catch { /* gone */ } } }
    reap(server, tracked);
  }
}

async function phaseC() {
  console.log('\n[PHASE C] the owner process dies, taking the log pipes with it: the server saves, unlocks and exits (#64)');
  const owner = boot(C, { viaOwner: true });
  const port = await owner._port;
  const tracked: Pid[] = [];
  try {
    ok(await canvasConnected(port), 'the real render-canvas connects under the stand-in owner');
    const node = serverPid(owner.pid);
    const chrome = browserPid(owner.pid);
    tracked.push(node, chrome);
    ok(!!node && !!chrome && node !== owner.pid, `found the server (${node}) under its owner (${owner.pid}) and its browser (${chrome})`);
    await post(port, '/message', { text: 'kept for the next owner', idempotencyKey: 'c1' });

    // The session ends: its process dies and the pipes behind the server's stdout/stderr close.
    owner.stdout.destroy();
    owner.stderr.destroy();
    process.kill(owner.pid, 'SIGKILL');
    const t0 = Date.now();
    const gone = await waitFor(() => !alive(node), EXIT_BOUND_MS, 100);
    ok(gone, `INVARIANT: the server exits within ${EXIT_BOUND_MS / 1000}s of its owner dying${gone ? ` (took ${Date.now() - t0}ms)` : ''}`);
    ok(!fs.existsSync(path.join(HOME, `${C}.lock`)), 'the lock is removed');
    ok(fs.existsSync(path.join(HOME, `${C}.tldr`)), 'the board snapshot is on disk for the next owner');
    ok(fs.readFileSync(path.join(HOME, `${C}.messages.jsonl`), 'utf8').includes('kept for the next owner'), 'the durable Send log is kept');
    ok(await waitFor(() => !alive(chrome), 3000), 'the render-canvas Chromium is not left behind');
  } finally {
    reap(owner, tracked);
  }
}

async function main() {
  if (!hasChromium() || !hasAppBuild()) {
    console.log('[SKIP] busy-loop: it needs Playwright\'s Chromium and the built app (scripts/whiteboard.sh install)');
    process.exit(0);
  }
  try {
    await phaseA();
    await phaseB();
    await phaseC();
  } finally {
    for (const board of boards) for (const f of boardFiles(board)) fs.rmSync(f, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

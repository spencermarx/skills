// [v9.8 §6.1 #61] Regression test for the render-canvas stale-frame stall.
//
// The bug (diagnosed 2026-09-25): when the headless render-canvas's image export FAILS, the app
// still answers export-image with {type:'image', id, ok:false} and NO upload. The bridge ignored the
// `ok` flag: its `image` handler called resolveImage(msg.id, msg.path) with msg.path undefined, and
// resolveImage did `w.resolve(resultPath || latestImagePath)` — so GET /image returned HTTP 200 with
// the LAST-GOOD PNG path while that PNG's mtime/size/dims were frozen (the live board had moved on).
// Any agent that "verifies visually" then read a stale frame and drew a false conclusion.
//
// The FIX (bridge-only — the app already sends ok:false):
//   1. The `image`/`image-result` frame is ok/err SIGNALLING only. The fresh path arrives solely via
//      POST /image-upload (which the app awaits BEFORE sending the frame). On ok:false the waiter is
//      REJECTED, so GET /image returns 503 with the error — never a stale 200.
//   2. resolveImage's idx=0 fallback is removed: an unmatched id resolves nothing (it used to hand the
//      oldest waiter a path meant for a different request).
//   3. /canvas-status exposes export health (lastExportOk/Error/At, lastImageMtime/Bytes) so the stall
//      is observable without byte-diffing the PNG.
//
// The render-canvas here is a FAKE ws client joined as role=agent; there is no Playwright and no live
// board. Every server boots on an ephemeral port (its port record is removed first) against a
// wbtest_* board in the worktree's own .scratchpad/whiteboard/ — the live board on port 62919 is
// never touched.
//
//   node --import tsx render-stall.test.ts      (run from server/)

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(SKILL_DIR, 'server');
// Boot the server the way the skill does (node with the tsx loader in-process, no tsx CLI
// wrapper), so the spawned child IS the server and killing it never orphans a board.
const BOOT_ARGS = ['--import', 'tsx', 'index.ts'];

function repoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}
const HOME = path.join(repoRoot(SKILL_DIR), '.scratchpad', 'whiteboard');
fs.mkdirSync(HOME, { recursive: true });

// --- tiny assertion harness -------------------------------------------------
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- boot a bridge, resolve its port from stdout ----------------------------
type Server = ChildProcessByStdio<null, Readable, Readable> & { _port: Promise<number> };
function boot(board: string, extraEnv: Record<string, string> = {}): Server {
  const boardPath = path.join(HOME, `${board}.tldr`);
  try { fs.rmSync(boardPath, { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.messages.jsonl`), { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.port`), { force: true }); } catch {} // a fresh, ephemeral port
  try { fs.rmSync(path.join(HOME, `${board}.png`), { force: true }); } catch {} // start with NO good frame
  const child = spawn(process.execPath, BOOT_ARGS, {
    cwd: SERVER_DIR,
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: undefined, CLAUDE_CODE_MESSAGING_TOKEN: undefined,
    CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PID: undefined, CLAUDE_JOB_DIR: undefined, WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: boardPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  return Object.assign(child, { _port: port });
}

const boardPng = (board: string) => path.join(HOME, `${board}.png`);
const statOrNull = (p: string): fs.Stats | null => { try { return fs.statSync(p); } catch { return null; } };

// A GET /image that returns { status, body } instead of throwing, so we can assert on the status code.
interface ImageBody { path?: string; error?: string }
interface ImageResult { status: number; body: ImageBody | null }
async function getImage(port: number): Promise<ImageResult> {
  const r = await fetch(`http://127.0.0.1:${port}/image`);
  let body: ImageBody | null = null;
  try { body = await r.json() as ImageBody; } catch {}
  return { status: r.status, body };
}
interface CanvasStatus {
  connected?: boolean; lastExportOk?: boolean | null; lastExportError?: string | null;
  lastExportAt?: number | null; lastImageBytes?: number | null;
}
const canvasStatus = (port: number): Promise<CanvasStatus> =>
  fetch(`http://127.0.0.1:${port}/canvas-status`).then((r) => r.json() as Promise<CanvasStatus>);

// A FAKE render-canvas: a ws client joined as role=agent. Its response to each export-image frame is
// governed by the mutable `behavior` (id, ws) => void|Promise, so a single socket drives every phase.
type Behavior = (id: string, ws: WebSocket) => void | Promise<void>;
interface FakeCanvas { ws: WebSocket; behavior: Behavior | null; lastExportId: string | null }
interface ExportFrame { type?: string; id: string }
async function fakeRenderCanvas(port: number): Promise<FakeCanvas> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?role=agent`);
  const rc: FakeCanvas = { ws, behavior: null, lastExportId: null };
  ws.on('message', async (raw) => {
    let msg: ExportFrame; try { msg = JSON.parse(raw.toString()) as ExportFrame; } catch { return; }
    if (msg.type === 'export-image') {
      rc.lastExportId = msg.id;
      if (rc.behavior) await rc.behavior(msg.id, ws);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return rc;
}

// Behaviors the fake can wear ------------------------------------------------
// Success mirrors the real app: POST the PNG to /image-upload and AWAIT it, THEN send ok:true.
const PNG = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 0xab)]);
// `id` is whatever export id the test captured, possibly none yet; it goes into the URL as it is.
async function uploadPng(port: number, id: string | null | undefined, bytes: number): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${port}/image-upload?id=${encodeURIComponent(String(id))}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG(bytes),
  });
  return r.json();
}
const succeedWith = (port: number, bytes: number): Behavior => async (id, ws) => {
  await uploadPng(port, id, bytes);
  ws.send(JSON.stringify({ type: 'image', id, ok: true }));
};
const failWith = (error: string): Behavior => (id, ws) => {
  ws.send(JSON.stringify({ type: 'image', id, ok: false, error }));
};

async function main() {
  const board = 'wbtest_render_stall';
  const server = boot(board);
  const port = await server._port;
  const rc = await fakeRenderCanvas(port);
  try {
    ok((await canvasStatus(port)).connected === true, 'fake render-canvas is connected (role=agent)');

    // ---- Phase 1: a healthy export resolves /image with a freshly-written frame -------------------
    console.log('\n[PHASE 1] a successful export returns a fresh 200');
    ok(statOrNull(boardPng(board)) === null, 'no PNG exists yet (no good frame to fall back to)');
    rc.behavior = succeedWith(port, 100);
    const good1 = await getImage(port);
    eq(good1.status, 200, 'GET /image returns 200 on a successful export');
    const st1 = statOrNull(boardPng(board));
    ok(st1 && st1.size > 0, 'the PNG was actually written (fresh frame on disk)');
    const cs1 = await canvasStatus(port);
    eq(cs1.lastExportOk, true, 'canvas-status.lastExportOk is true after a good export');
    eq(cs1.lastImageBytes, PNG(100).length, 'canvas-status.lastImageBytes matches the written frame');
    ok(typeof cs1.lastExportAt === 'number', 'canvas-status.lastExportAt is set');

    // ---- Phase 2: THE BUG — a failed export must NOT serve the stale good frame as 200 ------------
    console.log('\n[PHASE 2] a failed export returns 503, NEVER a stale 200 (the regression)');
    const mtimeBefore = fs.statSync(boardPng(board)).mtimeMs;
    rc.behavior = failWith('simulated toImage throw (WebGL context lost)');
    const bad = await getImage(port);
    eq(bad.status, 503, 'INVARIANT: GET /image returns 503 on a failed export (not a stale 200)');
    ok(bad.body && /export-image failed/.test(bad.body.error ?? ''), 'the 503 carries the export error');
    const mtimeAfter = fs.statSync(boardPng(board)).mtimeMs;
    eq(mtimeAfter, mtimeBefore, 'the on-disk PNG mtime did NOT advance (no write happened) — proves it was a real failure, not a re-render');
    const cs2 = await canvasStatus(port);
    eq(cs2.lastExportOk, false, 'canvas-status.lastExportOk flips to false — the stall is now observable');
    ok(/toImage throw/.test(cs2.lastExportError ?? ''), 'canvas-status.lastExportError carries the reason');

    // ---- Phase 3: recovery — the next good export resolves fresh again ----------------------------
    console.log('\n[PHASE 3] recovery: a good export after a failure returns a fresh 200 again');
    rc.behavior = succeedWith(port, 250);
    const good2 = await getImage(port);
    eq(good2.status, 200, 'GET /image returns 200 once the export recovers');
    const cs3 = await canvasStatus(port);
    eq(cs3.lastExportOk, true, 'canvas-status.lastExportOk is true again after recovery');
    eq(cs3.lastImageBytes, PNG(250).length, 'lastImageBytes reflects the NEW frame (advanced), not the stale one');

    // ---- Phase 4: the idx=0 hazard — a mismatched-id frame resolves NO waiter ---------------------
    console.log('\n[PHASE 4] a stray frame with the wrong id does not resolve a parked /image waiter');
    // Park a waiter but answer with a BOGUS id (as the removed idx=0 fallback would have mis-resolved).
    let parkedId = null as string | null;
    rc.behavior = (id, ws) => {
      parkedId = id;
      ws.send(JSON.stringify({ type: 'image', id: `bogus-${id}`, ok: true })); // wrong id, claims success
    };
    const pending = getImage(port);
    // Give the stray frame time to arrive and (wrongly, under the old code) resolve the waiter.
    const raced = await Promise.race([pending, sleep(400).then(() => 'STILL_PENDING')]);
    eq(raced, 'STILL_PENDING', 'INVARIANT: the parked /image waiter is NOT resolved by a mismatched-id frame');
    // Now answer the REAL id properly so the waiter resolves and the test finishes fast.
    ok(typeof parkedId === 'string' && parkedId, 'captured the real export id the waiter is keyed on');
    await uploadPng(port, parkedId, 60);
    rc.ws.send(JSON.stringify({ type: 'image', id: parkedId, ok: true }));
    const settled = await pending;
    eq(settled.status, 200, 'the same waiter resolves 200 once the CORRECT id is answered');

    // ---- Phase 5: TWO concurrent waiters — exact-id routing (the real idx=0 hazard) ---------------
    // Removing the idx=0 fallback matters when >1 /image call is in flight (lead + a worker both
    // perceiving). Park A and B; resolve B first and assert A stays pending; then a stray frame must
    // still resolve neither; then resolve A. Old positional code would have mis-routed a stray frame
    // to the oldest waiter (A). Both waiters resolve to the same on-disk path, so we assert on WHICH
    // waiter settles WHEN, which is exactly what exact-id routing governs.
    console.log('\n[PHASE 5] two concurrent /image waiters resolve strictly by id');
    const ids: string[] = [];
    rc.behavior = (id) => { ids.push(id); }; // hold both; the test drives resolution order
    const pA = getImage(port);
    for (let i = 0; i < 30 && ids.length < 1; i++) await sleep(50);
    const pB = getImage(port);
    for (let i = 0; i < 30 && ids.length < 2; i++) await sleep(50);
    eq(ids.length, 2, 'both concurrent /image calls parked a distinct waiter');
    ok(ids[0] !== ids[1], 'the two waiters have distinct export ids');
    // Resolve the SECOND waiter (B) first.
    await uploadPng(port, ids[1], 70);
    rc.ws.send(JSON.stringify({ type: 'image', id: ids[1], ok: true }));
    const bDone = await Promise.race([pB, sleep(1500).then(() => 'PENDING' as const)]);
    ok(bDone !== 'PENDING' && bDone.status === 200, 'INVARIANT: resolving id B settles waiter B (200)');
    const aStillPending = await Promise.race([pA, sleep(300).then(() => 'STILL_PENDING')]);
    eq(aStillPending, 'STILL_PENDING', 'INVARIANT: waiter A is untouched while only B was resolved');
    // A stray bogus-id frame must resolve neither (the idx=0 fallback would have taken A).
    rc.ws.send(JSON.stringify({ type: 'image', id: `bogus-${ids[0]}`, ok: true }));
    const aStillPending2 = await Promise.race([pA, sleep(300).then(() => 'STILL_PENDING')]);
    eq(aStillPending2, 'STILL_PENDING', 'INVARIANT: a stray frame does not resolve A even with a second waiter gone');
    // Now resolve A properly.
    await uploadPng(port, ids[0], 90);
    rc.ws.send(JSON.stringify({ type: 'image', id: ids[0], ok: true }));
    const aDone = await Promise.race([pA, sleep(1500).then(() => 'PENDING' as const)]);
    ok(aDone !== 'PENDING' && aDone.status === 200, 'waiter A settles 200 once its own id is resolved');

    // ---- Phase 6: an empty board (ok:false, NO error) must NOT flip health false (no crying wolf) --
    console.log('\n[PHASE 6] an empty-board ok:false (nothing to render) returns 503 but keeps health OK');
    rc.behavior = succeedWith(port, 120); // first, a good export → health true
    await getImage(port);
    const csHealthy = await canvasStatus(port);
    eq(csHealthy.lastExportOk, true, 'precondition: health is true after a good export');
    const mtimeHealthy = fs.statSync(boardPng(board)).mtimeMs;
    rc.behavior = (id, ws) => ws.send(JSON.stringify({ type: 'image', id, ok: false })); // no error = empty board
    const empty = await getImage(port);
    eq(empty.status, 503, 'an empty-board export still returns 503 (never a stale 200)');
    ok(empty.body && /no image produced/.test(empty.body.error ?? ''), 'the 503 explains there was no image produced');
    const csAfterEmpty = await canvasStatus(port);
    eq(csAfterEmpty.lastExportOk, true, 'INVARIANT: an empty board does NOT flip lastExportOk false — the signal does not cry wolf');
    eq(fs.statSync(boardPng(board)).mtimeMs, mtimeHealthy, 'no write happened on the empty-board export');

    // ---- Phase 7: a failed /image-upload write rejects PROMPTLY and flips health false -------------
    // If the server's writeFile throws, the app (which does not check response.ok) still sends ok:true;
    // without the catch-side rejectImage the waiter would hang to WS_REQUEST_TIMEOUT_MS (15s) and health
    // would keep reading true. Force EISDIR by making the target PNG path a directory.
    console.log('\n[PHASE 7] a failed image-upload write rejects promptly (not a 15s hang) and flips health false');
    fs.rmSync(boardPng(board), { force: true });
    fs.mkdirSync(boardPng(board)); // writeFile(<dir>) → EISDIR
    try {
      rc.behavior = succeedWith(port, 80); // uploads (server write throws), then sends ok:true
      const t0 = Date.now();
      const failed = await getImage(port);
      const elapsed = Date.now() - t0;
      eq(failed.status, 503, 'a failed upload-write returns 503 (never a stale 200)');
      ok(elapsed < 5000, `the /image waiter is rejected promptly, not after the 15s timeout (took ${elapsed}ms)`);
      const csWrite = await canvasStatus(port);
      eq(csWrite.lastExportOk, false, 'INVARIANT: a failed write flips lastExportOk false (the stall is observable)');
      ok(/write failed/.test(csWrite.lastExportError ?? ''), 'lastExportError names the write failure');
    } finally {
      fs.rmSync(boardPng(board), { recursive: true, force: true });
    }
  } finally {
    try { rc.ws.close(); } catch {}
    server.kill('SIGKILL');
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

// [render-cap] Regression test for the render-canvas OOM/hang fix (2026-09-28).
//
// Context (from HANDOFF 20260927-213224): the whole-board PNG export hung/OOM'd the degraded
// headless Chromium and the bridge's /image waiter timed out recording NOTHING — every
// lastExport* field stayed null, so the stall was invisible. The fix has four parts; two are
// bridge-side and provable here against a FAKE render-canvas (no Playwright, no live board):
//
//   1. BOUNDS FORWARDING — GET /image?bounds=x,y,w,h forwards a `bounds` field on the export-image
//      frame so an agent can zoom in on a region (a downscaled whole-board bird's-eye otherwise).
//      A malformed/non-positive bounds degrades to whole-board (no field), never a 400.
//   2. NO-FRAME TIMEOUT HEALTH — when the render-canvas never answers an export at all (a hang, or
//      a page that is gone), the bridge's requestImage timeout now records
//      lastExportOk=false / lastExportError='export timed out (no frame from render-canvas)'
//      instead of leaving the field null. This is the exact null-across-the-board signature.
//
// The other two parts run in a real browser and are NOT covered here (documented, not tested):
//   - the app-side raster cap (bounds+scale+pixelRatio) and client-side toImage timeout (App.tsx);
//   - the Playwright crash/disconnect auto-restart (needs a real Chromium to crash).
//
// Toggle-proof: reverting requestImage's `...(bounds ? {bounds} : {})` fails Phase A; reverting the
// lastExport* assignments in the requestImage timeout fails Phase B.
//
// Every server boots on an ephemeral port (PORT=0) against a wbtest_* board in the worktree's own
// .scratchpad/whiteboard/ — the live board on port 62919 is never touched.
//
//   node server/render-cap.test.mjs      (run from the skill root)

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', '_incubating', 'whiteboard');
const SERVER_DIR = path.join(SKILL_DIR, 'server');
// ws comes from the skill's server/node_modules: this suite lives outside the skill folder.
const { WebSocket } = createRequire(path.join(SERVER_DIR, 'package.json'))('ws');
const TSX = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');

function repoRoot(start) {
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
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function deepEq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- boot a bridge, resolve its port from stdout ----------------------------
function boot(board, extraEnv = {}) {
  const boardPath = path.join(HOME, `${board}.tldr`);
  try { fs.rmSync(boardPath, { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.messages.jsonl`), { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.png`), { force: true }); } catch {}
  const child = spawn(TSX, ['index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: '0', WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: boardPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child._port = new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  return child;
}

const boardPng = (board) => path.join(HOME, `${board}.png`);
const canvasStatus = (port) => fetch(`http://127.0.0.1:${port}/canvas-status`).then((r) => r.json());

async function getImage(port, query = '') {
  const r = await fetch(`http://127.0.0.1:${port}/image${query}`);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 0xab)]);
async function uploadPng(port, id, bytes) {
  const r = await fetch(`http://127.0.0.1:${port}/image-upload?id=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG(bytes),
  });
  return r.json();
}

// A FAKE render-canvas that records every export-image frame it receives (frame, incl. bounds) and
// runs a mutable `behavior` to decide how — if at all — to answer.
async function fakeRenderCanvas(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?role=agent`);
  const rc = { ws, behavior: null, frames: [] };
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'export-image') {
      rc.frames.push(msg);
      if (rc.behavior) await rc.behavior(msg, ws);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return rc;
}
// Success behavior: upload a PNG and AWAIT it, then send ok:true (mirrors the real app's order).
const succeed = (port) => async (msg, ws) => {
  await uploadPng(port, msg.id, 100);
  ws.send(JSON.stringify({ type: 'image', id: msg.id, ok: true }));
};

async function phaseA() {
  console.log('\n[PHASE A] GET /image?bounds= forwards a region; malformed bounds degrade to whole-board');
  const board = 'wbtest_render_cap_bounds';
  const server = boot(board, { WHITEBOARD_LEAD_GRACE_MS: '60000' });
  const port = await server._port;
  const rc = await fakeRenderCanvas(port);
  try {
    ok((await canvasStatus(port)).connected === true, 'fake render-canvas is connected (role=agent)');
    rc.behavior = succeed(port);

    // Whole-board: no bounds param ⇒ no bounds field on the frame (downscaled bird's-eye).
    rc.frames.length = 0;
    const whole = await getImage(port);
    eq(whole.status, 200, 'GET /image (no bounds) returns 200');
    eq(rc.frames.length, 1, 'exactly one export-image frame was forwarded');
    eq(rc.frames[0].bounds, undefined, 'INVARIANT: no bounds param ⇒ no bounds field (whole-board bird\'s-eye)');

    // Region: a valid bounds param ⇒ the exact region forwarded verbatim.
    rc.frames.length = 0;
    const region = await getImage(port, '?bounds=10,20,300,400');
    eq(region.status, 200, 'GET /image?bounds=... returns 200');
    deepEq(rc.frames[0].bounds, { x: 10, y: 20, w: 300, h: 400 }, 'INVARIANT: a valid ?bounds= is forwarded verbatim as a region');

    // Region with floats + negative origin (page coords can be negative) ⇒ still forwarded.
    rc.frames.length = 0;
    await getImage(port, '?bounds=-5.5,-10,120.25,80');
    deepEq(rc.frames[0].bounds, { x: -5.5, y: -10, w: 120.25, h: 80 }, 'negative/float page coords forward correctly');

    // Malformed ⇒ degrade to whole-board (no field), NEVER a 400.
    rc.frames.length = 0;
    const bad = await getImage(port, '?bounds=not,a,box,x');
    eq(bad.status, 200, 'INVARIANT: a malformed ?bounds= degrades to whole-board (200, not 400)');
    eq(rc.frames[0].bounds, undefined, 'a malformed ?bounds= forwards no region field');

    // Non-positive size ⇒ degrade to whole-board (a zero/negative area is meaningless).
    rc.frames.length = 0;
    const zero = await getImage(port, '?bounds=0,0,0,50');
    eq(zero.status, 200, 'a non-positive ?bounds= size degrades to whole-board (200)');
    eq(rc.frames[0].bounds, undefined, 'a non-positive ?bounds= size forwards no region field');
  } finally {
    try { rc.ws.close(); } catch {}
    server.kill('SIGKILL');
  }
}

async function phaseB() {
  console.log('\n[PHASE B] a no-frame export timeout records health (not a silent null)');
  const board = 'wbtest_render_cap_timeout';
  // Short WS timeout so the no-frame path fires fast instead of waiting the 15s default.
  const server = boot(board, { WHITEBOARD_LEAD_GRACE_MS: '60000', WHITEBOARD_WS_TIMEOUT_MS: '700' });
  const port = await server._port;
  const rc = await fakeRenderCanvas(port);
  try {
    ok((await canvasStatus(port)).connected === true, 'fake render-canvas is connected (role=agent)');
    const cs0 = await canvasStatus(port);
    eq(cs0.lastExportOk, null, 'precondition: lastExportOk is null (no export attempted yet)');

    // The fake NEVER answers export-image → the bridge's requestImage timeout fires.
    rc.behavior = () => { /* swallow: never upload, never send a frame */ };
    const t0 = Date.now();
    const timedOut = await getImage(port);
    const elapsed = Date.now() - t0;
    eq(timedOut.status, 503, 'GET /image returns 503 when the render-canvas never answers');
    ok(/timed out/.test(timedOut.body?.error ?? ''), 'the 503 says the export timed out');
    ok(elapsed >= 600 && elapsed < 4000, `the timeout fired near WHITEBOARD_WS_TIMEOUT_MS, not the 15s default (took ${elapsed}ms)`);

    const cs1 = await canvasStatus(port);
    eq(cs1.lastExportOk, false, 'INVARIANT: a no-frame timeout flips lastExportOk false (no longer a silent null)');
    ok(/no frame from render-canvas/.test(cs1.lastExportError ?? ''), 'lastExportError names the no-frame timeout');
    ok(typeof cs1.lastExportAt === 'number', 'lastExportAt is recorded on the timeout');

    // Recovery: once the fake answers again, health returns to true (the timeout was not sticky).
    rc.behavior = succeed(port);
    const good = await getImage(port);
    eq(good.status, 200, 'GET /image returns 200 once the render-canvas answers again');
    eq((await canvasStatus(port)).lastExportOk, true, 'lastExportOk recovers to true after a good export');
  } finally {
    try { rc.ws.close(); } catch {}
    server.kill('SIGKILL');
    try { fs.rmSync(boardPng(board), { force: true }); } catch {}
  }
}

async function main() {
  await phaseA();
  await phaseB();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

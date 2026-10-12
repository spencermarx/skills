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
// board. Every server boots on an ephemeral port (PORT=0) in this suite's own throwaway repository,
// so no running board is ever touched.
//
//   node tests/whiteboard/render-stall.test.mjs

import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CANVAS_KEY, SERVER_DIR, sandbox, startServer, stopAllServers } from './harness.mjs';

// ws comes from the skill's server/node_modules: this suite lives outside the skill folder.
const { WebSocket } = createRequire(path.join(SERVER_DIR, 'package.json'))('ws');
const SB = sandbox('render-stall');


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

// --- boot a bridge in this suite's own throwaway repository -----------------
const boot = (board, extraEnv = {}) => startServer(SB, SB.board(board), extraEnv);

const boardPng = (board) => SB.files(SB.board(board)).png;
const statOrNull = (p) => { try { return fs.statSync(p); } catch { return null; } };

// A GET /image that returns { status, body } instead of throwing, so we can assert on the status code.
async function getImage(port) {
  const r = await fetch(`http://127.0.0.1:${port}/image`);
  let body = null;
  try { body = await r.json(); } catch {}
  return { status: r.status, body };
}
const canvasStatus = (port) => fetch(`http://127.0.0.1:${port}/canvas-status`).then((r) => r.json());

// A FAKE render-canvas: a ws client joined as role=agent. Its response to each export-image frame is
// governed by the mutable `behavior` (id, ws) => void|Promise, so a single socket drives every phase.
async function fakeRenderCanvas(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?role=agent&canvasKey=${CANVAS_KEY}`);
  const rc = { ws, behavior: null, lastExportId: null };
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'export-image') {
      rc.lastExportId = msg.id;
      if (rc.behavior) await rc.behavior(msg.id, ws);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return rc;
}

// Behaviors the fake can wear ------------------------------------------------
// Success mirrors the real app: POST the PNG to /image-upload and AWAIT it, THEN send ok:true.
const PNG = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 0xab)]);
async function uploadPng(port, id, bytes) {
  const r = await fetch(`http://127.0.0.1:${port}/image-upload?id=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG(bytes),
  });
  return r.json();
}
const succeedWith = (port, bytes) => async (id, ws) => {
  await uploadPng(port, id, bytes);
  ws.send(JSON.stringify({ type: 'image', id, ok: true }));
};
const failWith = (error) => (id, ws) => {
  ws.send(JSON.stringify({ type: 'image', id, ok: false, error }));
};

async function main() {
  const board = 'wbtest_render_stall';
  const server = boot(board, { WHITEBOARD_LEAD_GRACE_MS: '60000' });
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
    const mtimeBefore = statOrNull(boardPng(board)).mtimeMs;
    rc.behavior = failWith('simulated toImage throw (WebGL context lost)');
    const bad = await getImage(port);
    eq(bad.status, 503, 'INVARIANT: GET /image returns 503 on a failed export (not a stale 200)');
    ok(bad.body && /export-image failed/.test(bad.body.error ?? ''), 'the 503 carries the export error');
    const mtimeAfter = statOrNull(boardPng(board)).mtimeMs;
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
    let parkedId = null;
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
    const ids = [];
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
    const bDone = await Promise.race([pB, sleep(1500).then(() => 'PENDING')]);
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
    const aDone = await Promise.race([pA, sleep(1500).then(() => 'PENDING')]);
    ok(aDone !== 'PENDING' && aDone.status === 200, 'waiter A settles 200 once its own id is resolved');

    // ---- Phase 6: an empty board (ok:false, NO error) must NOT flip health false (no crying wolf) --
    console.log('\n[PHASE 6] an empty-board ok:false (nothing to render) returns 503 but keeps health OK');
    rc.behavior = succeedWith(port, 120); // first, a good export → health true
    await getImage(port);
    const csHealthy = await canvasStatus(port);
    eq(csHealthy.lastExportOk, true, 'precondition: health is true after a good export');
    const mtimeHealthy = statOrNull(boardPng(board)).mtimeMs;
    rc.behavior = (id, ws) => ws.send(JSON.stringify({ type: 'image', id, ok: false })); // no error = empty board
    const empty = await getImage(port);
    eq(empty.status, 503, 'an empty-board export still returns 503 (never a stale 200)');
    ok(empty.body && /no image produced/.test(empty.body.error ?? ''), 'the 503 explains there was no image produced');
    const csAfterEmpty = await canvasStatus(port);
    eq(csAfterEmpty.lastExportOk, true, 'INVARIANT: an empty board does NOT flip lastExportOk false — the signal does not cry wolf');
    eq(statOrNull(boardPng(board)).mtimeMs, mtimeHealthy, 'no write happened on the empty-board export');

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
    await stopAllServers();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await stopAllServers(); process.exit(process.exitCode ?? 0); });

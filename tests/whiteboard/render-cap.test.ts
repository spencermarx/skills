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
// The app-side raster cap (bounds+scale+pixelRatio) and client-side toImage timeout (App.tsx) run in
// the app and are NOT covered here (documented, not tested).
//
// The crash relaunch (handleRenderCanvasDeath) IS covered, against the server's own real Chromium
// (Phases C-J boot with the render-canvas on and act only on that server's child processes):
//   - PHASE C, RENDERER CRASH: the canvas page's renderer dies while the browser lives ('crash'): the
//     relaunch closes the live browser and the canvas comes back.
//   - PHASE D, LIVE NAVIGATION FAILURE: a switch's navigation fails while the browser is alive
//     (WHITEBOARD_FAIL_NAV, a test-only hook): the relaunch closes it and comes up in the new
//     board, and clears lastNavError.
//   - PHASE E, A SWITCH DURING A RELAUNCH: the browser is killed and a switch lands while the relaunch
//     runs: one Chromium is left, on the new board.
//   - PHASE F, A RELAUNCHED RENDERER THAT STOPS ANSWERING: the relaunch's page loads and then loops
//     forever (WHITEBOARD_TEST_WEDGE_LAUNCH, a test-only hook): the attempt fails at its bound, the
//     relaunch ends, and the canvas comes back.
//   - PHASE G, A SWITCH DURING THE BOOT LAUNCH: the boot launch goes through the one launcher, so the
//     switch stands aside: one Chromium is left, on the new board, and its death is relaunched.
//   - PHASE H, A RENDERER THAT STOPS ANSWERING DURING A SWITCH'S NAVIGATION (WHITEBOARD_TEST_WEDGE_NAV):
//     an /exec queued behind the navigation still answers, and the canvas comes back.
//   - PHASE I, A SWITCH TO AN EMPTY BOARD: an /exec queued behind the switch answers 200 and a /shapes
//     made right after it answers for the new board; a renderer that stops answering after the
//     navigation to an empty board (WHITEBOARD_TEST_WEDGE_NAV) fails the navigation, and the canvas
//     comes back.
//   - PHASE J, A GIVE-UP AND A PARKED EXPORT: the boot launch gives up (WHITEBOARD_TEST_FAIL_LAUNCHES,
//     a test-only hook), a later launch withdraws the give-up, and a switch fails an /image parked on
//     the page it replaces at once, recording no export failure.
//   - PHASE K, PERCEPTION DURING A SWITCH: /image and /shapes made during a navigation that freezes
//     (WHITEBOARD_TEST_WEDGE_NAV, on a board with a shape, so it fails about 20 s after it loads) answer
//     only once it has ended, 503 with `relaunching: true`, and SKILL's one retry answers for the board;
//     while the launcher runs, /shapes answers 503 at once and never for the board a switch left.
//   - PHASE L, WHAT A FAILED /exec LEFT: a blob that throws after a write says it may have drawn and
//     to write what is missing under a new key, and its answer's sentAt is no later than the stamp on
//     what it wrote and later than the stamp on what came before; a move a peer (a headless operator tab) makes while a
//     blob that wrote the same shape is waiting is kept when that blob throws; a write a corrupted store
//     cut off while that peer moves a shape is ok:false, and reaches the room though the next blob is
//     ended by a reload; a blob the canvas does not answer within the ws timeout (WHITEBOARD_WS_TIMEOUT_MS) is ok:false and says the same, a
//     retry with its key never runs it again, and it draws nothing after that answer, so the missing
//     shape the agent writes is drawn once and carries no other agent's name; one that corrupted the
//     store before it stalled is recovered, so what it drew reaches the room, and still draws nothing
//     after the answer; an /exec made while the launcher's canvas for a board a
//     switch left is connected never answers ok:true for a write the board does not get, and SKILL's
//     503 rule lands it.
//   - PHASE M, A PAGE THAT STOPS ANSWERING PART-WAY THROUGH A TIMEOUT RECOVERY: the answer comes within
//     the ws timeout and the 30 s the plain reload may take, the canvas is asked for one asset rather
//     than one per asset, the line says the server is relaunching the canvas, and the relaunched canvas
//     holds what the blob drew. Against 7e5e22d4 the answer took 72 s and asked to restart the whiteboard.
//   - PHASE N, A RECOVERY WHOSE TIME RUNS OUT ON A PAGE THAT STILL ANSWERS: the page answers the request
//     for an asset 40 s late, its main thread free, so the recovery's time runs out before a reload; the
//     line says so, and that the server is relaunching the canvas. Against 9138bc82 it said the canvas
//     had stopped answering: 2 of its 9 checks fail.
//   - PHASE O, A CRASH WHILE A RECOVERY'S RELOAD WAITS: the renderer is killed during the reload of a
//     page blocked as in Phase M; the line says the canvas went down and the server is relaunching it.
//     Against 9138bc82 it said the board could not be repaired and asked for a restart: 2 of its 10
//     checks fail. The line's cause is pinned whole, and the canvas is relaunched once.
//   - PHASE P, A CRASH WHILE THE HARVEST WAITS ON ITS LAST READ: the recovery reloads a page already
//     dead, and Chromium's late reply to that reload fails an assertion in Playwright's message
//     dispatch. The server takes it for the canvas's fault: it keeps serving, the canvas is relaunched
//     once, and holds what the blob drew. Its first checks pin which faults are the canvas's
//     (canvas-fault.ts). Against 69e89dff the server shut itself down about 1 ms after the answer.
//   - PHASE Q, A CRASH PART-WAY THROUGH THE HARVEST'S READS: every asset left unread has no answer.
//     Against 69e89dff the relaunched canvas, which never held them, was asked for the rest, and they
//     came back gone. A line that says the canvas went down does not say it was reloaded; against
//     4520654e it opened "the canvas was reloaded". The same harvest with no crash, the page leaving
//     its reads of the assets unanswered, gives the line that opens "the canvas was reloaded after
//     <reason>, but", with no went-down sentence.
//   - PHASE R, A CRASH AFTER THE RECOVERY'S RELOAD, WITH A SLOW RELAUNCH (WHITEBOARD_TEST_WEDGE_LAUNCH):
//     an answer that says recovered comes once a read of /shapes shows the put-back. Against 69e89dff it
//     said recovered while the launcher ran and /shapes answered 503.
//   - PHASE S, A RELOAD GIVEN ABOUT 25 MS: the line names the milliseconds. Against 69e89dff it read
//     "0.0 s".
//   - PHASE T, A DRIVER FAULT WHILE THE CANVAS ANSWERS (a test-only preload throws Phase P's fault on
//     SIGUSR2): the canvas stays up, and the blob running on it answers ok. Two faults on a canvas whose
//     main thread a blob blocks for 25 s relaunch it once, and the next /exec lands. With no canvas up
//     (the boot launch gave up), the same fault has the launcher bring one back. Against 4520654e the
//     fault closed the canvas that answered and ended the blob.
//   - PHASE U, A DRIVER FAULT WHILE THE CANVAS RELOADS: the page asks for its own reload and blocks its
//     main thread, so the reload's commit reaches the page ahead of the check that it answers. The check
//     asks the page again, on its new document, and the canvas stays up, in each of 3 tries. Against bfb10d30 Playwright's
//     "Execution context was destroyed" read the canvas dead and relaunched it in every try: 2 of its 7
//     checks fail. Against 219ec6d5, which logged each ask again as it made it, the one line a check now
//     writes when it ends is missing: 1 fails. Against dd67371d, whose line also gave a count of navigations
//     that was the count of asks a navigation dropped, the match fails: 1 fails.
//   - PHASE V, A FRESH CANVAS THAT DIES WHILE THE LAUNCHER'S VERIFY ASKS IT AGAIN (a test-only preload has
//     the boot launch's page reload itself as it is verified, into a document that blocks 8 s): with the
//     renderer killed, the browser killed, or the browser sent SIGTERM (what `kill <pid>` sends), the verify
//     reads the canvas dead when it dies, its line names how (`it crashed`, `its browser disconnected`), and
//     the launcher brings it up on its next attempt. Against 219ec6d5 the verify read it dead only at its
//     15 s deadline, about 10 s after the kill, and its line named no outcome: 6 of its 15 checks fail.
//     Against dd67371d a browser killed or sent SIGTERM in the check was logged `it closed`: 2 fail. Against
//     cf2069c3 a browser sent SIGTERM still was, since it closes its pages before it disconnects: 1 fails.
//   - PHASE W, A PAGE THAT RELOADS ITSELF AT THE START OF EVERY DOCUMENT FOR 8 S, WITH A DRIVER FAULT 1 S
//     IN: the check asks again at most once per 250 ms of the time it ran, writes one line when it ends, and
//     the canvas stays up once the reloads stop. Against 219ec6d5 the check asked again and logged as often
//     as the page navigated: 2 of its 7 checks fail. With the pause cut to 120 ms, 1 fails.
//
// Toggle-proof: reverting requestImage's `...(bounds ? {bounds} : {})` fails Phase A; reverting the
// lastExport* assignments in the requestImage timeout fails Phase B. Against the relaunch before PR
// #236's round-5 fix (closeDeadBrowser removed every 'disconnected' listener, so the close of a live
// browser never returned, and a switch during a relaunch launched a browser of its own), Phases C and
// D never recover (browserUp false, /exec 503, lastNavError still set) and Phase E leaves two Chromiums.
// Against round 5's head (889d167f: no bound on evaluate or newPage, and a boot launch outside the
// relaunch) with the two wedge hooks added, Phase F's relaunch never ends, Phase G leaves two Chromiums,
// and Phase H's /exec never answers: 7 or 9 of their 20 checks fail, as G kills the tracked or the
// untracked Chromium. Without the hooks F and H cannot wedge, and 3 or 5 fail. Against round 6's head (be47aa14) with the launch-failure hook added, Phase I's /exec
// answers 503, its /shapes answers for the board it left, and its frozen navigation is taken for a
// success; Phase J's give-up outlives the recovery, and its parked /image waits 15 s and records an
// export failure: 12 of their 25 checks fail. Against fd58d576, whose perception wait stopped at 15 s,
// Phase K's /image and /shapes answer 503 at 15 s with `relaunching: false`, before the navigation has
// failed, and SKILL's one retry meets a second 503: 5 of its 13 checks fail. Against e8cd8eca, Phase
// L's thrown blobs answer their bare error, the unanswered blob is a 503 that its retry runs again, the
// blob still running draws a second missing shape under the worker's name, and the /exec during the
// launcher answers ok:true from the page for X: 11 of its 18 checks fail, or 9 in a run where that
// /exec answers 503. Against 4dfd00c1, which undid
// a blob that throws, the thrown blobs answer their bare error, the undo puts the operator's moved shape
// back, the unanswered blob's answer names no new key, and the blob still running draws as at e8cd8eca:
// 8 of 18 fail. Against d8ecf618, the three answers carry the old text, and the blob still running draws
// as at e8cd8eca: 7 of 18 fail. Each of the three answers ok:true for the write the corrupted store cut
// off while the peer moved a shape, and never delivers it. Against 4fa10c73, the three answers carry
// round 11's text, and that write answers ok:true and is discarded by the reload that ends the next
// blob: 5 of 18 fail.
//
// Every server boots on an ephemeral port (its port record is removed first) against a wbtest_*
// board in the worktree's own .scratchpad/whiteboard/ — the live board on port 62919 is never touched.
//
//   node --import tsx render-cap.test.ts   (run from server/)

import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { isCanvasDriverFault as IsCanvasDriverFault } from './canvas-fault.js';
import type { TLSyncClient } from '@tldraw/sync-core';
import type { TLRecord, TLShapeId, TLStoreProps } from '@tldraw/tlschema';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(SKILL_DIR, 'server');
// Boot the server the way the skill does (node with the tsx loader in-process, no tsx CLI
// wrapper), so the spawned child IS the server and killing it never orphans a board.
const BOOT_ARGS = ['--import', 'tsx', 'index.ts'];

// --- the shapes the server answers with ----------------------------------------
interface Bounds { x: number; y: number; w: number; h: number }
interface ExportFrame { type: 'export-image'; id: string; bounds?: Bounds }
interface CanvasStatus {
  connected: boolean;
  browserUp: boolean;
  relaunching: boolean;
  room: string;
  activeRoom: string;
  roomShapes: number;
  lastExportOk: boolean | null;
  lastExportError: string | null;
  lastExportAt: number | null;
  lastNavError: string | null;
}
interface Stamp { name?: string; at?: number }
interface ShapeRecord { id: string; y?: number; meta?: { createdBy?: Stamp; lastEditedBy?: Stamp; tag?: string } }
interface Recovery { recovered?: boolean; text?: string; missing?: string[]; why?: Record<string, string> }
// One body for every JSON answer the suite reads: /exec, /board/open, /session/register, /shapes, /image.
interface ApiBody {
  ok?: boolean;
  error?: string;
  result?: unknown;
  sentAt?: number;
  recovery?: Recovery;
  room?: string;
  sessionId?: string;
  shapes?: ShapeRecord[];
}
interface ApiResponse { status: number; body: ApiBody }
interface MessagesBody { messages?: { author?: { name?: string }; text?: string }[] }
type Server = ChildProcessByStdio<null, Readable, Readable> & { _log: string; _port: Promise<number> };

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
function deepEq(actual: unknown, expected: unknown, msg: string): void {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- boot a bridge, resolve its port from stdout ----------------------------
function boot(board: string, extraEnv: Record<string, string> = {}): Server {
  const boardPath = path.join(HOME, `${board}.tldr`);
  try { fs.rmSync(boardPath, { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.messages.jsonl`), { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.recipients.json`), { force: true }); } catch {}
  try { fs.rmSync(path.join(HOME, `${board}.port`), { force: true }); } catch {} // a fresh, ephemeral port
  try { fs.rmSync(path.join(HOME, `${board}.png`), { force: true }); } catch {}
  const child = spawn(process.execPath, BOOT_ARGS, {
    cwd: SERVER_DIR,
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: undefined, CLAUDE_CODE_MESSAGING_TOKEN: undefined,
    CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PID: undefined, CLAUDE_JOB_DIR: undefined, WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: boardPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server: Server = Object.assign(child, { _log: '', _port: Promise.resolve(0) });
  server.stdout.on('data', (d: Buffer) => { server._log += d.toString(); });
  server.stderr.on('data', (d: Buffer) => { server._log += d.toString(); });
  server._port = new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { server.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    server.stdout.on('data', onData);
    server.on('exit', (code) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  return server;
}

const boardPng = (board: string): string => path.join(HOME, `${board}.png`);
const canvasStatus = (port: number): Promise<CanvasStatus> => fetch(`http://127.0.0.1:${port}/canvas-status`).then((r) => r.json() as Promise<CanvasStatus>);

async function getImage(port: number, query = ''): Promise<{ status: number; body: ApiBody | null }> {
  const r = await fetch(`http://127.0.0.1:${port}/image${query}`);
  let body: ApiBody | null = null;
  try { body = (await r.json()) as ApiBody; } catch {}
  return { status: r.status, body };
}

const PNG = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 0xab)]);
async function uploadPng(port: number, id: string, bytes: number): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${port}/image-upload?id=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG(bytes),
  });
  return r.json();
}

// A FAKE render-canvas that records every export-image frame it receives (frame, incl. bounds) and
// runs a mutable `behavior` to decide how — if at all — to answer.
type Behavior = (msg: ExportFrame, ws: WebSocket) => unknown;
interface FakeCanvas { ws: WebSocket; behavior: Behavior | null; frames: ExportFrame[] }
async function fakeRenderCanvas(port: number): Promise<FakeCanvas> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/events?role=agent`);
  const rc: FakeCanvas = { ws, behavior: null, frames: [] };
  ws.on('message', async (raw) => {
    let msg: { type?: unknown }; try { msg = JSON.parse(raw.toString()) as { type?: unknown }; } catch { return; }
    if (msg.type === 'export-image') {
      rc.frames.push(msg as ExportFrame);
      if (rc.behavior) await rc.behavior(msg as ExportFrame, ws);
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return rc;
}
// Success behavior: upload a PNG and AWAIT it, then send ok:true (mirrors the real app's order).
const succeed = (port: number): Behavior => async (msg, ws) => {
  await uploadPng(port, msg.id, 100);
  ws.send(JSON.stringify({ type: 'image', id: msg.id, ok: true }));
};

async function phaseA() {
  console.log('\n[PHASE A] GET /image?bounds= forwards a region; malformed bounds degrade to whole-board');
  const board = 'wbtest_render_cap_bounds';
  const server = boot(board);
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
    eq(rc.frames[0]!.bounds, undefined, 'INVARIANT: no bounds param ⇒ no bounds field (whole-board bird\'s-eye)');

    // Region: a valid bounds param ⇒ the exact region forwarded verbatim.
    rc.frames.length = 0;
    const region = await getImage(port, '?bounds=10,20,300,400');
    eq(region.status, 200, 'GET /image?bounds=... returns 200');
    deepEq(rc.frames[0]!.bounds, { x: 10, y: 20, w: 300, h: 400 }, 'INVARIANT: a valid ?bounds= is forwarded verbatim as a region');

    // Region with floats + negative origin (page coords can be negative) ⇒ still forwarded.
    rc.frames.length = 0;
    await getImage(port, '?bounds=-5.5,-10,120.25,80');
    deepEq(rc.frames[0]!.bounds, { x: -5.5, y: -10, w: 120.25, h: 80 }, 'negative/float page coords forward correctly');

    // Malformed ⇒ degrade to whole-board (no field), NEVER a 400.
    rc.frames.length = 0;
    const bad = await getImage(port, '?bounds=not,a,box,x');
    eq(bad.status, 200, 'INVARIANT: a malformed ?bounds= degrades to whole-board (200, not 400)');
    eq(rc.frames[0]!.bounds, undefined, 'a malformed ?bounds= forwards no region field');

    // Non-positive size ⇒ degrade to whole-board (a zero/negative area is meaningless).
    rc.frames.length = 0;
    const zero = await getImage(port, '?bounds=0,0,0,50');
    eq(zero.status, 200, 'a non-positive ?bounds= size degrades to whole-board (200)');
    eq(rc.frames[0]!.bounds, undefined, 'a non-positive ?bounds= size forwards no region field');
  } finally {
    try { rc.ws.close(); } catch {}
    server.kill('SIGKILL');
  }
}

async function phaseB() {
  console.log('\n[PHASE B] a no-frame export timeout records health (not a silent null)');
  const board = 'wbtest_render_cap_timeout';
  // Short WS timeout so the no-frame path fires fast instead of waiting the 15s default.
  const server = boot(board, { WHITEBOARD_WS_TIMEOUT_MS: '700' });
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

// --- the real render-canvas (Phases C-E) -------------------------------------
// Every Chromium process here descends from a server this file booted; nothing else is ever signalled.
const CANVAS_ON = { WHITEBOARD_NO_CANVAS: '' };
const waitFor = async (pred: () => unknown, ms: number, step = 100): Promise<boolean> => {
  const deadline = Date.now() + ms;
  for (;;) { if (await pred()) return true; if (Date.now() >= deadline) return false; await sleep(step); }
};
interface Proc { pid: number; ppid: number; cmd: string }
function processTable(): Proc[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l): Proc | null => { const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! } : null; })
    .filter((p): p is Proc => Boolean(p));
}
// A server's Chromium browsers: its direct children that are a browser's main process (not a --type= helper).
const chromiumMains = (serverPid: number | undefined): number[] => processTable().filter((p) => p.ppid === serverPid && /chrom/i.test(p.cmd) && !p.cmd.includes('--type=')).map((p) => p.pid);
// The renderer processes of those browsers.
const renderersOf = (mains: number[]): number[] => processTable().filter((p) => mains.includes(p.ppid) && p.cmd.includes('--type=renderer')).map((p) => p.pid);
// Every Chromium pid seen under a server, so the phase can kill what its server left behind.
function trackChromium(server: Server, seen: Set<number>): void {
  const t = processTable();
  const mine = new Set<number | undefined>([server.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of t) if (mine.has(p.ppid) && !mine.has(p.pid)) { mine.add(p.pid); grew = true; }
  }
  for (const p of t) if (p.pid !== server.pid && mine.has(p.pid) && /chrom/i.test(p.cmd)) seen.add(p.pid);
}
async function stopCanvasServer(server: Server, seen: Set<number>): Promise<void> {
  try { trackChromium(server, seen); } catch {}
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await waitFor(() => server.exitCode !== null || server.signalCode !== null, 8000);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await sleep(300);
  // Only a pid that still runs a Chromium: a pid reused by anything else is never signalled.
  const stillChromium = new Set(processTable().filter((p) => /chrom/i.test(p.cmd)).map((p) => p.pid));
  for (const pid of seen) if (stillChromium.has(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
const postJson = (port: number, p: string, body: unknown): Promise<ApiResponse> =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as ApiBody }))
    .catch((e: Error) => ({ status: 0, body: { error: e.message } }));
const geoShape = (id: string) => ({ id, typeName: 'shape', type: 'geo', x: 0, y: 0, rotation: 0, index: 'a1', parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
  props: { geo: 'rectangle', w: 100, h: 100, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1, flipX: false, flipY: false, richText: { type: 'doc', content: [{ type: 'paragraph' }] } } });
// An /exec that writes one shape, and whether that shape reached the hosted room.
async function execLands(port: number, room: string, id: string): Promise<{ status: number; reached: boolean }> {
  const before = (await canvasStatus(port)).roomShapes;
  const ex = await postJson(port, '/exec', { code: `editor.store.put([${JSON.stringify(geoShape(id))}]);` });
  const reached = ex.status === 200 && await waitFor(async () => { const st = await canvasStatus(port); return st.activeRoom === room && st.roomShapes === before + 1; }, 5000);
  return { status: ex.status, reached };
}
const canvasUp = async (port: number): Promise<boolean> => { const st = await canvasStatus(port); return st.browserUp === true && st.connected === true; };
// A headless operator tab: a real tldraw store and sync client joined to the room, so its edits reach
// the render-canvas as a peer's do. tldraw's client code is loaded here, behind the browser-global shim
// (as in doorbell.test.ts), so the phases before it never load it (the type imports above are erased).
interface SyncPeer {
  put(id: string, x: number): void;
  move(id: string, x: number): void;
  get(id: string): { x?: number } | undefined;
  close(): void;
}
async function syncPeer(port: number, room: string): Promise<SyncPeer> {
  const g = globalThis as Record<string, unknown>;
  g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
  g.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false, visibilityState: 'visible' };
  g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
  g.cancelAnimationFrame ??= (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
  const { Store } = await import('@tldraw/store');
  const { createTLSchema } = await import('@tldraw/tlschema');
  const { TLSyncClient } = await import('@tldraw/sync-core');
  // The published typings omit ClientWebSocketAdapter; client-adapter.ts types the same runtime export.
  const { ClientWebSocketAdapter } = await import('./client-adapter.js');
  const { atom } = await import('@tldraw/state');
  const store = new Store({ schema: createTLSchema(), props: {} as TLStoreProps });
  const socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${port}/sync/${room}`);
  let client!: TLSyncClient<TLRecord>;
  await new Promise<void>((resolve) => {
    client = new TLSyncClient({ store, socket, presence: atom<TLRecord | null>('presence', null), onLoad: () => resolve(), onSyncError: () => {} });
  });
  return {
    put: (id, x) => store.put([{ ...geoShape(id), x } as unknown as TLRecord]),
    move: (id, x) => store.put([{ ...store.get(id as TLShapeId), x } as TLRecord]),
    get: (id) => store.get(id as TLShapeId) as { x?: number } | undefined,
    close: () => {
      try { client.close(); } catch { /* already closed */ }
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}
function removeBoard(board: string): void {
  for (const ext of ['.tldr', '.lock', '.port', '.png', '.messages.jsonl', '.recipients.json']) { try { fs.rmSync(path.join(HOME, `${board}${ext}`), { force: true }); } catch {} }
}

async function phaseC() {
  console.log('\n[PHASE C] the canvas page\'s renderer crashes while the browser lives: the relaunch brings the canvas back');
  const board = 'wbtest_render_cap_renderer';
  const server = boot(board, CANVAS_ON);
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up');
    const mains = chromiumMains(server.pid);
    const renderers = renderersOf(mains);
    trackChromium(server, seen);
    ok(mains.length === 1 && renderers.length >= 1, `one browser, with its renderer (${mains.length} browser, ${renderers.length} renderer)`);
    for (const pid of renderers) process.kill(pid, 'SIGKILL'); // the renderer only: the browser lives
    ok(await waitFor(() => server._log.includes('render-canvas page crashed; relaunching'), 10000, 20), 'the crash is handed to the relaunch');
    ok(await waitFor(() => server._log.includes('render-canvas relaunched after page crashed'), 20000), 'INVARIANT: the relaunch completes (the close of the live browser returns)');
    ok(await waitFor(() => canvasUp(port), 10000), 'INVARIANT: browserUp and connected are true again');
    trackChromium(server, seen);
    const ex = await execLands(port, board, 'shape:rc-renderer');
    ok(ex.status === 200 && ex.reached, `INVARIANT: an /exec succeeds and reaches the board (status ${ex.status})`);
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function phaseD() {
  console.log('\n[PHASE D] a switch\'s navigation fails while the browser lives: the relaunch comes up in the new board');
  const board = 'wbtest_render_cap_navx';
  const target = 'wbtest_render_cap_navy';
  removeBoard(target);
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_FAIL_NAV: '1' });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up on X');
    trackChromium(server, seen);
    const opened = await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    eq(`${opened.status} ${opened.body.room}`, `200 ${target}`, 'the switch to Y answers 200');
    ok(await waitFor(() => server._log.includes(`render-canvas navigation to '${target}' failed`), 5000, 20), "the canvas's navigation to Y fails, with the browser alive");
    ok(await waitFor(() => server._log.includes('render-canvas relaunched after navigation failed'), 20000), 'INVARIANT: the relaunch completes (the close of the live browser returns)');
    trackChromium(server, seen);
    const st = await canvasStatus(port);
    eq(`${st.activeRoom} ${st.room} ${st.browserUp} ${st.connected}`, `${target} ${target} true true`, 'INVARIANT: the canvas is up, in Y');
    eq(st.lastNavError, null, 'INVARIANT: lastNavError is cleared once the relaunch succeeds');
    eq(chromiumMains(server.pid).length, 1, 'the old browser was closed: one Chromium is left');
    const ex = await execLands(port, target, 'shape:rc-navfail');
    ok(ex.status === 200 && ex.reached, `an /exec succeeds and reaches Y (status ${ex.status})`);
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

async function phaseE() {
  console.log('\n[PHASE E] the browser dies and a switch lands during the relaunch: one Chromium is left, on the new board');
  const board = 'wbtest_render_cap_racex';
  const target = 'wbtest_render_cap_racey';
  removeBoard(target);
  const server = boot(board, CANVAS_ON);
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up on X');
    const before = chromiumMains(server.pid);
    trackChromium(server, seen);
    eq(before.length, 1, 'one Chromium');
    process.kill(before[0]!, 'SIGKILL'); // this server's own browser dies
    ok(await waitFor(() => server._log.includes(`browser disconnected; relaunching into room '${board}'`), 10000, 5), 'the death is handed to the relaunch');
    const opened = await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    eq(`${opened.status} ${opened.body.room}`, `200 ${target}`, 'a switch to Y during the relaunch answers 200');
    ok(await waitFor(() => server._log.includes('render-canvas relaunched after browser disconnected'), 30000), 'the relaunch completes');
    ok(server._log.includes(`the board moved to '${target}' during the relaunch; relaunching there`), 'the switch landed while the relaunch ran, and the relaunch followed it to Y');
    await sleep(3000); // let any second launch finish and connect
    trackChromium(server, seen);
    const st = await canvasStatus(port);
    eq(chromiumMains(server.pid).length, 1, 'INVARIANT: exactly one Chromium is left');
    eq(`${st.activeRoom} ${st.room} ${st.browserUp} ${st.connected}`, `${target} ${target} true true`, 'INVARIANT: the canvas is up, and its room is Y');
    const ex = await execLands(port, target, 'shape:rc-race');
    ok(ex.status === 200 && ex.reached, `INVARIANT: an /exec succeeds and reaches Y (status ${ex.status})`);
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

// The relaunch has ended, either way.
const relaunchEnded = (server: Server): boolean => /render-canvas relaunched after|NOT recovered/.test(server._log);

async function phaseF() {
  console.log('\n[PHASE F] the relaunched renderer stops answering after its page loads: the relaunch still ends');
  const board = 'wbtest_render_cap_hang';
  // WHITEBOARD_TEST_WEDGE_LAUNCH wedges launch 2 (the relaunch) in an endless loop right after its page loads.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_TEST_WEDGE_LAUNCH: '2' });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up');
    const seed = await execLands(port, board, 'shape:rc-hang-seed');
    ok(seed.reached, 'the board has a shape, so the relaunch verifies a render');
    const old = chromiumMains(server.pid);
    trackChromium(server, seen);
    process.kill(old[0]!, 'SIGKILL');
    ok(await waitFor(() => server._log.includes('TEST: wedging the renderer after launch 2'), 15000, 50), 'the relaunched renderer stops answering after its page loads');
    const ended = await waitFor(() => relaunchEnded(server), 60000, 250);
    ok(ended, 'INVARIANT: the relaunch ends (relaunched, or NOT recovered) within 60 s');
    ok(await waitFor(() => canvasUp(port), 20000), 'INVARIANT: the canvas is up again');
    trackChromium(server, seen);
    const ex = await execLands(port, board, 'shape:rc-hang');
    ok(ex.status === 200 && ex.reached, `INVARIANT: an /exec succeeds and reaches the board (status ${ex.status})`);
  } finally {
    for (const pid of seen) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function phaseG() {
  console.log('\n[PHASE G] a switch lands during the boot launch: one Chromium, on the new board, whose death is relaunched');
  const board = 'wbtest_render_cap_bootx';
  const target = 'wbtest_render_cap_booty';
  removeBoard(target);
  const server = boot(board, CANVAS_ON);
  const seen = new Set<number>();
  try {
    const port = await server._port;
    const opened = await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    eq(`${opened.status} ${opened.body.room}`, `200 ${target}`, 'a switch to Y right after listen answers 200');
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === target && st.browserUp && st.connected; }, 30000), 'the canvas comes up on Y');
    await sleep(3000); // let any second launch finish and connect
    trackChromium(server, seen);
    const mains = chromiumMains(server.pid);
    eq(mains.length, 1, 'INVARIANT: exactly one Chromium');
    process.kill(mains[0]!, 'SIGKILL');
    ok(await waitFor(() => server._log.includes(`browser disconnected; relaunching into room '${target}'`), 10000, 20), 'INVARIANT: its death is handed to the relaunch');
    ok(await waitFor(() => server._log.includes('render-canvas relaunched after browser disconnected'), 30000), 'the relaunch completes');
    trackChromium(server, seen);
    const ex = await execLands(port, target, 'shape:rc-boot');
    ok(ex.status === 200 && ex.reached, `INVARIANT: an /exec succeeds and reaches Y (status ${ex.status})`);
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

async function phaseH() {
  console.log('\n[PHASE H] the renderer stops answering during a switch\'s own navigation: the exec queue is not wedged');
  const board = 'wbtest_render_cap_navhx';
  const target = 'wbtest_render_cap_navhy';
  removeBoard(target);
  // WHITEBOARD_TEST_WEDGE_NAV wedges the renderer right after the first navigation to X loads.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_TEST_WEDGE_NAV: board });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up on X');
    ok((await execLands(port, board, 'shape:rc-navh-seed')).reached, 'X has a shape, so a navigation to X verifies a render');
    await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === target && st.connected; }, 30000), 'the canvas is on Y');
    trackChromium(server, seen);
    const back = await postJson(port, '/board/open', { path: path.join(HOME, `${board}.tldr`) });
    eq(`${back.status} ${back.body.room}`, `200 ${board}`, 'the switch back to X answers 200');
    ok(await waitFor(() => server._log.includes(`TEST: wedging the renderer after navigation to ${board}`), 10000, 20), 'the renderer stops answering after the navigation to X loads');
    const t = Date.now();
    const ex1 = await Promise.race([postJson(port, '/exec', { code: 'editor.getCurrentPageShapeIds().size' }), sleep(60000).then(() => ({ status: 'no answer' }))]);
    ok(ex1.status !== 'no answer', `INVARIANT: an /exec queued behind the frozen navigation answers (${ex1.status} after ${Math.round((Date.now() - t) / 1000)} s)`);
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === board && st.browserUp && st.connected && st.lastNavError === null; }, 60000), 'INVARIANT: the canvas comes back on X, and lastNavError clears');
    trackChromium(server, seen);
    const ex = await execLands(port, board, 'shape:rc-navh');
    ok(ex.status === 200 && ex.reached, `an /exec succeeds and reaches X (status ${ex.status})`);
  } finally {
    for (const pid of seen) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

async function phaseI() {
  console.log('\n[PHASE I] a switch to an empty board ends only on a canvas that answers and is connected');
  const board = 'wbtest_render_cap_emptyx';
  const target = 'wbtest_render_cap_emptyy'; // never written: an empty board
  const wedged = 'wbtest_render_cap_emptyz'; // empty too, and its renderer stops answering once loaded
  removeBoard(target);
  removeBoard(wedged);
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_TEST_WEDGE_NAV: wedged });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up on X');
    ok((await execLands(port, board, 'shape:rc-empty-seed')).reached, 'X has a shape');
    trackChromium(server, seen);
    for (let round = 1; round <= 3; round++) {
      const opened = await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
      const [ex, sh] = await Promise.all([
        postJson(port, '/exec', { code: 'editor.getCurrentPageShapeIds().size' }),
        fetch(`http://127.0.0.1:${port}/shapes`).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as ApiBody })),
      ]);
      eq(`${opened.status} ${ex.status}`, '200 200', `INVARIANT: an /exec queued behind a switch to an empty board answers 200, not 503 (round ${round}${ex.status !== 200 ? `: ${ex.body.error}` : ''})`);
      const ids = Array.isArray(sh.body.shapes) ? sh.body.shapes.map((s) => s.id) : sh.body.error;
      eq(`${sh.status} ${JSON.stringify(ids)}`, '200 []',`INVARIANT: a /shapes made right after the switch answers for the empty board, never for X (round ${round})`);
      await postJson(port, '/board/open', { path: path.join(HOME, `${board}.tldr`) });
    }
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === board && st.connected; }, 30000), 'the canvas is back on X');
    const opened = await postJson(port, '/board/open', { path: path.join(HOME, `${wedged}.tldr`) });
    eq(`${opened.status} ${opened.body.room}`, `200 ${wedged}`, 'the switch to the empty board Z answers 200');
    ok(await waitFor(() => server._log.includes(`TEST: wedging the renderer after navigation to ${wedged}`), 10000, 20), 'the renderer stops answering after the navigation to Z loads');
    const t = Date.now();
    const ex1 = await Promise.race([postJson(port, '/exec', { code: 'editor.getCurrentPageShapeIds().size' }), sleep(60000).then(() => ({ status: 'no answer' }))]);
    ok(ex1.status !== 'no answer', `an /exec queued behind the frozen navigation answers (${ex1.status} after ${Math.round((Date.now() - t) / 1000)} s)`);
    ok(await waitFor(() => server._log.includes(`render-canvas navigation to '${wedged}' failed`), 30000, 50), 'INVARIANT: the navigation onto the empty board fails at its bound, and is handed to the launcher');
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === wedged && st.browserUp && st.connected && !st.relaunching && st.lastNavError === null; }, 60000), 'INVARIANT: the canvas comes back on Z, and lastNavError clears');
    trackChromium(server, seen);
    const ex = await execLands(port, wedged, 'shape:rc-empty');
    ok(ex.status === 200 && ex.reached, `INVARIANT: an /exec succeeds and reaches Z (status ${ex.status})`);
  } finally {
    for (const pid of seen) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
    removeBoard(wedged);
  }
}

async function phaseJ() {
  console.log('\n[PHASE J] a later launch withdraws the launcher\'s give-up, and a switch fails a parked /image without recording export health');
  const board = 'wbtest_render_cap_giveupx';
  const target = 'wbtest_render_cap_giveupy';
  removeBoard(target);
  // WHITEBOARD_TEST_FAIL_LAUNCHES fails the boot launch's three attempts, so the launcher gives up.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_TEST_FAIL_LAUNCHES: '3' });
  const seen = new Set<number>();
  let fake: WebSocket | null = null;
  try {
    const port = await server._port;
    ok(await waitFor(() => server._log.includes('NOT recovered after 3 attempts (the boot launch)'), 20000), 'the boot launch gives up');
    const st0 = await canvasStatus(port);
    ok(/self-heal failed/.test(st0.lastExportError ?? '') && st0.relaunching === false, 'the give-up is on /canvas-status, with relaunching false');
    const opened = await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    eq(`${opened.status} ${opened.body.room}`, `200 ${target}`, 'a switch to Y answers 200');
    ok(await waitFor(() => server._log.includes('render-canvas relaunched after navigation failed'), 30000), 'the switch hands the missing canvas to the launcher, which comes up');
    ok(await waitFor(() => canvasUp(port), 10000), 'the render-canvas is up on Y');
    trackChromium(server, seen);
    const st1 = await canvasStatus(port);
    eq(`${st1.lastExportOk} ${st1.lastExportError}`, 'null null', 'INVARIANT: the successful launch withdraws the give-up');
    // A role=agent socket takes the bridge's canvas socket and never answers an export, so an /image parks.
    fake = new WebSocket(`ws://127.0.0.1:${port}/events?role=agent`);
    await new Promise((resolve, reject) => { fake!.once('open', resolve); fake!.once('error', reject); });
    const t = Date.now();
    const parked = getImage(port);
    await sleep(300);
    await postJson(port, '/board/open', { path: path.join(HOME, `${board}.tldr`) });
    const img = await parked;
    const took = Date.now() - t;
    ok(img.status === 503 && took < 5000, `INVARIANT: the switch fails the parked /image at once (${img.status} after ${took} ms: ${img.body?.error})`);
    const st2 = await canvasStatus(port);
    eq(`${st2.lastExportOk} ${st2.lastExportError}`, 'null null', 'INVARIANT: a request caught by a switch records no export failure');
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === board && st.connected; }, 30000), 'the canvas is up on X');
    trackChromium(server, seen);
    const ex = await execLands(port, board, 'shape:rc-giveup');
    ok(ex.status === 200 && ex.reached, `an /exec succeeds and reaches X (status ${ex.status})`);
  } finally {
    try { fake?.close(); } catch {}
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

async function phaseK() {
  console.log('\n[PHASE K] perception made during a switch waits for its navigation, and answers 503 while the launcher runs');
  const board = 'wbtest_render_cap_waitx';
  const target = 'wbtest_render_cap_waity';
  removeBoard(target);
  // WHITEBOARD_TEST_WEDGE_NAV wedges the renderer right after the first navigation to X loads. X holds a
  // shape, so that navigation fails about 20 s after it loads (the socket wait, then the render check's
  // evaluate), past the 15 s a perception request used to wait.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_TEST_WEDGE_NAV: board });
  const seen = new Set<number>();
  const shapesOf = (port: number): Promise<{ status: number; ids: string[] | null; error: string | undefined }> => fetch(`http://127.0.0.1:${port}/shapes`).then(async (r) => {
    const body = (await r.json().catch(() => ({}))) as ApiBody;
    return { status: r.status, ids: Array.isArray(body.shapes) ? body.shapes.map((s) => s.id) : null, error: body.error };
  });
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up on X');
    ok((await execLands(port, board, 'shape:rc-wait-x')).reached, 'X has a shape');
    await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === target && st.connected; }, 30000), 'the canvas is on Y');
    ok((await execLands(port, target, 'shape:rc-wait-y')).reached, 'Y has a shape');
    trackChromium(server, seen);

    // A switch back to X, whose navigation freezes; /image and /shapes are made as soon as it answers.
    const back = await postJson(port, '/board/open', { path: path.join(HOME, `${board}.tldr`) });
    eq(`${back.status} ${back.body.room}`, `200 ${board}`, 'the switch back to X answers 200');
    const t = Date.now();
    const [img, sh] = await Promise.all([getImage(port), shapesOf(port)]);
    const took = Date.now() - t;
    const st = await canvasStatus(port);
    ok(server._log.includes(`render-canvas navigation to '${board}' failed`), `INVARIANT: /image and /shapes made during the frozen navigation answer only once it has ended (after ${took} ms)`);
    eq(`${img.status} ${sh.status} ${st.relaunching}`, '503 503 true', 'INVARIANT: they answer 503 while the launcher relaunches into X, and /canvas-status reads relaunching: true');
    // SKILL's 503 rule: poll /canvas-status while it reads relaunching: true, then retry once.
    ok(await waitFor(async () => !(await canvasStatus(port)).relaunching, 60000, 250), 'the relaunch ends');
    const retry = await shapesOf(port);
    eq(`${retry.status} ${JSON.stringify(retry.ids ?? retry.error)}`, '200 ["shape:rc-wait-x"]', "INVARIANT: SKILL's one retry answers for X, so there is no fault to report");
    trackChromium(server, seen);

    // The launcher runs when a switch commits: the switch stands aside, and until the launcher has
    // followed it to Y, perception answers 503 at once, never for X.
    const mains = chromiumMains(server.pid);
    process.kill(mains[0]!, 'SIGKILL');
    ok(await waitFor(() => server._log.includes(`browser disconnected; relaunching into room '${board}'`), 10000, 5), 'the browser dies, and the launcher relaunches into X');
    await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    const t2 = Date.now();
    const first = await shapesOf(port);
    const firstMs = Date.now() - t2;
    eq(`${first.status} ${first.error}`, '503 render-canvas relaunching', `INVARIANT: a /shapes made while the launcher runs answers 503 at once (${firstMs} ms)`);
    let forX = 0;
    let settled = false;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const r = await shapesOf(port);
      if (r.status === 200 && r.ids!.includes('shape:rc-wait-x')) forX++;
      const s = await canvasStatus(port);
      if (r.status === 200 && !s.relaunching && s.room === target) { settled = r.ids!.includes('shape:rc-wait-y'); break; }
      await sleep(50);
    }
    eq(forX, 0, 'INVARIANT: no /shapes made after the switch answers for X');
    ok(settled, 'once the launcher is done, /shapes answers for Y');
    trackChromium(server, seen);
  } finally {
    for (const pid of seen) { try { process.kill(pid, 'SIGCONT'); } catch {} }
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

async function phaseL() {
  console.log('\n[PHASE L] a failed /exec says what it left: a blob that throws says it may have drawn and undoes no one\'s edit, one the canvas did not answer is never run twice and draws nothing after its answer, and one made while the launcher runs for a board left answers 503');
  const board = 'wbtest_render_cap_execx';
  const target = 'wbtest_render_cap_execy';
  removeBoard(target);
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: '3000' });
  const seen = new Set<number>();
  const count = async (port: number): Promise<number> => (await postJson(port, '/exec', { code: 'return editor.getCurrentPageShapes().length' })).body.result as number;
  // What /shapes lists: the render-canvas's current page.
  const shapeIds = async (port: number): Promise<string[]> => fetch(`http://127.0.0.1:${port}/shapes`).then((r) => r.json() as Promise<ApiBody>).then((b) => (b.shapes ?? []).map((s) => s.id)).catch(() => []);
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up on X');
    ok((await execLands(port, board, 'shape:rc-exec-x')).reached, 'X has a shape');

    // A blob that writes, then throws: what it wrote before the throw stays, and the answer says so.
    const MAY = /may have drawn: read \/shapes \(what it wrote carries your name and an at no earlier than this answer's sentAt, in meta\.createdBy or meta\.lastEditedBy\), then redo only what did not land and no one else has edited since, under a new idempotencyKey$/;
    const thrown = await postJson(port, '/exec', { code: "editor.createShapes([{ id: createShapeId(), type: 'geo', x: 0, y: 300 }]); editor.createShapes([{ id: 'shape:rc-exec-x', type: 'geo', x: 0, y: 0 }]);" });
    eq(`${thrown.status} ${thrown.body.ok}`, '200 false', 'a blob whose second create collides answers ok:false');
    ok(MAY.test(thrown.body.error ?? ''), `INVARIANT: a blob that throws says it may have drawn, and to write what is missing under a new key (${thrown.body.error})`);
    // The answer carries the time the stamps are compared with: what this blob wrote is stamped no
    // earlier than it, and the shape written before it is stamped earlier.
    const stamped = (await fetch(`http://127.0.0.1:${port}/shapes`).then((r) => r.json() as Promise<ApiBody>)).shapes ?? [];
    const since = stamped.filter((s) => typeof thrown.body.sentAt === 'number' && s.meta?.createdBy?.at! >= thrown.body.sentAt).map((s) => s.y);
    deepEq(since, [300], `INVARIANT: the answer's sentAt picks out exactly what that blob wrote by its createdBy.at (sentAt ${thrown.body.sentAt})`);

    // The operator moves a shape while a blob that recolored it is waiting, and the blob then throws.
    // Nothing undoes the blob, so the operator's move stays.
    const peer = await syncPeer(port, board);
    try {
      const op = 'shape:rc-exec-op';
      peer.put(op, 0);
      ok(await waitFor(async () => (await postJson(port, '/exec', { code: `return !!editor.getShape('${op}')` })).body.result === true, 5000), 'the operator\'s shape reaches the render-canvas');
      const late = postJson(port, '/exec', { code: `editor.updateShapes([{ id: '${op}', type: 'geo', props: { color: 'red' } }]); await new Promise((r) => setTimeout(r, 1500)); throw new Error('late throw')` });
      await sleep(600);
      peer.move(op, 500);
      const lateAnswer = await late;
      await sleep(1500);
      eq(`${lateAnswer.status} ${lateAnswer.body.ok} ${MAY.test(lateAnswer.body.error ?? '')}`, '200 false true', 'that blob answers ok:false and says it may have drawn');
      eq(peer.get(op)?.x, 500, 'INVARIANT: a move the operator made while a blob ran is kept when the blob throws');

      // A write a corrupted store cut off, while the operator's move advances the room inside the sync
      // check's window. It answers ok:false and recovery delivers it, so the reload that ends the next
      // blob the canvas does not answer has nothing of it left to throw away.
      const sevId = 'shape:rc-exec-sev';
      const sevAnswer = postJson(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.createShapes([{ id: '${sevId}', type: 'geo', x: 600, y: 300 }]);` });
      await sleep(150);
      peer.move(op, 700);
      const sev = await sevAnswer;
      const sevOnAnswer = (await shapeIds(port)).includes(sevId);
      eq(`${sev.status} ${sev.body.ok} ${/may have drawn/.test(sev.body.error ?? '')}`, '200 false true', 'INVARIANT: a write a corrupted store cut off answers ok:false, though the operator moved a shape while the bridge confirmed it');
      ok(sev.body.recovery?.recovered !== true || sevOnAnswer, `INVARIANT: when that answer says recovered, the first /shapes read after it lists what recovery put back (recovery ${JSON.stringify(sev.body.recovery?.recovered)}, listed ${sevOnAnswer})`);
      await postJson(port, '/exec', { code: 'await new Promise((r) => setTimeout(r, 4500));', idempotencyKey: 'rc-exec-sev-next' });
      ok(await waitFor(() => !!peer.get(sevId), 5000), 'INVARIANT: that write reaches the room, though the next blob was ended by a reload');
    } finally {
      peer.close();
    }

    // A blob the canvas does not answer within the ws timeout: it may have drawn, so a retry never runs it.
    const n0 = await count(port);
    const slow = { code: "editor.createShapes([{ id: createShapeId(), type: 'geo', x: 300, y: 300 }]); await new Promise((r) => setTimeout(r, 4500));", idempotencyKey: 'rc-exec-slow' };
    const first = await postJson(port, '/exec', slow);
    eq(`${first.status} ${first.body.ok} ${MAY.test(first.body.error ?? '')}`, '200 false true', 'INVARIANT: an /exec the canvas did not answer is ok:false and says the blob may have drawn, and to write what is missing under a new key, not a 503');
    ok(!('recovery' in first.body), 'an /exec the canvas did not answer runs no recovery, so its answer carries none');
    await sleep(2000);
    const retry = await postJson(port, '/exec', slow);
    eq(`${retry.status} ${retry.body.error === first.body.error}`, '200 true', 'a retry with the same key gets the same answer');
    await sleep(5000);
    eq(await count(port), n0 + 1, 'INVARIANT: the blob was drawn once, never re-run');

    // The agent follows that answer: it reads /shapes and writes what is missing under a new key, and a
    // worker's exec runs next. The blob, still running when the bridge answered, must draw nothing after
    // the answer, under its own author or the worker's.
    const lead = (await postJson(port, '/session/register', { clientKey: 'rc-exec-lead', name: 'Claude' })).body.sessionId;
    const worker = (await postJson(port, '/session/register', { clientKey: 'rc-exec-worker', name: 'Claude-2' })).body.sessionId;
    const make = (tag: string, x: number): string => `editor.createShapes([{ id: createShapeId(), type: 'geo', x: ${x}, y: 900, meta: { tag: '${tag}' } }]);`;
    const twos = async (): Promise<ShapeRecord[]> => fetch(`http://127.0.0.1:${port}/shapes`).then((r) => r.json() as Promise<ApiBody>).then((b) => (b.shapes ?? []).filter((s) => s.meta?.tag === 'two'));
    await postJson(port, '/exec', { sessionId: lead, idempotencyKey: 'rc-exec-outlive', code: `${make('one', 0)} await new Promise((r) => setTimeout(r, 4500)); ${make('two', 200)}` });
    if ((await twos()).length === 0) await postJson(port, '/exec', { sessionId: lead, idempotencyKey: 'rc-exec-outlive-missing', code: make('two', 200) });
    await postJson(port, '/exec', { sessionId: worker, idempotencyKey: 'rc-exec-outlive-worker', code: `await new Promise((r) => setTimeout(r, 2500)); ${make('w', 400)}` });
    await sleep(3000);
    const drawn = await twos();
    eq(drawn.length, 1, 'INVARIANT: a blob the canvas did not answer draws nothing after the answer, so the missing shape the agent then writes is drawn once');
    eq(JSON.stringify(drawn.map((s) => s.meta?.createdBy?.name).sort()), '["Claude"]', "INVARIANT: no write of that blob carries the next exec's author");

    // A blob that corrupts the store, draws, and then outlives the ws timeout: a plain reload would
    // discard what it drew, so recovery runs instead, and its reload still ends the blob.
    const cut = await postJson(port, '/exec', { idempotencyKey: 'rc-exec-corrupt-slow', code: "editor.store.markAsPossiblyCorrupted(); editor.createShapes([{ id: 'shape:rc-exec-cut', type: 'geo', x: 0, y: 1200 }]); await new Promise((r) => setTimeout(r, 4500)); editor.createShapes([{ id: 'shape:rc-exec-after', type: 'geo', x: 300, y: 1200 }]);" });
    eq(`${cut.status} ${cut.body.ok} ${MAY.test(cut.body.error ?? '')}`, '200 false true', 'a blob that corrupted the store and was not answered is ok:false and says it may have drawn');
    const cutLines = ((await fetch(`http://127.0.0.1:${port}/messages`).then((r) => r.json() as Promise<MessagesBody>)).messages ?? []).filter((m) => m.author?.name === 'Whiteboard').map((m) => m.text);
    ok(cut.body.recovery?.recovered === true && cutLines.includes(cut.body.recovery.text), `INVARIANT: its answer carries a recovery that says recovered, the line the panel shows (${JSON.stringify(cut.body.recovery)})`);
    ok((await shapeIds(port)).includes('shape:rc-exec-cut'), 'INVARIANT: what that blob drew on the corrupted store before it stalled is on the board, on the first /shapes read after the answer');
    await sleep(5000);
    // A blob still running would draw on the canvas whether or not its store reaches the room, so this
    // asks the canvas, on any page.
    const after = await postJson(port, '/exec', { code: "return !!editor.getShape('shape:rc-exec-after')" });
    eq(`${after.status} ${after.body.result}`, '200 false', "INVARIANT: the recovery's reload ended that blob, so the canvas holds nothing it would draw after the answer");

    // The launcher runs a canvas for X when a switch to Y commits. Until it has followed the switch, that
    // page is no canvas for Y, and an /exec it ran would answer ok:true for a write Y never gets. The
    // window opens once that page is connected, so each attempt switches then and execs at once; an
    // attempt where the launcher finished first is ordinary and is repeated.
    await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.room === target && st.connected && !st.relaunching; }, 30000), 'the canvas is on Y');
    let caught: { attempt: number; during: ApiResponse; landed: boolean; again: ApiResponse | null; after: boolean } | null = null;
    for (let attempt = 1; attempt <= 5 && !caught; attempt++) {
      await postJson(port, '/board/open', { path: path.join(HOME, `${board}.tldr`) });
      if (!(await waitFor(async () => { const st = await canvasStatus(port); return st.room === board && st.connected && !st.relaunching; }, 30000))) break;
      trackChromium(server, seen);
      const mark = server._log.length;
      process.kill(chromiumMains(server.pid)[0]!, 'SIGKILL');
      if (!(await waitFor(() => server._log.slice(mark).includes(`browser disconnected; relaunching into room '${board}'`), 10000, 5))) break;
      if (!(await waitFor(async () => { const st = await canvasStatus(port); return st.connected && st.relaunching; }, 10000, 5))) continue;
      await postJson(port, '/board/open', { path: path.join(HOME, `${target}.tldr`) });
      const st = await canvasStatus(port);
      const id = `shape:rc-exec-probe-${attempt}`;
      const code = `editor.createShapes([{ id: '${id}', type: 'geo', x: ${attempt * 150}, y: 600 }]); return 1`;
      const during = await postJson(port, '/exec', { code, idempotencyKey: `rc-exec-during-${attempt}` });
      await waitFor(async () => { const s2 = await canvasStatus(port); return s2.room === target && s2.connected && !s2.relaunching; }, 60000, 250);
      const landed = (await shapeIds(port)).includes(id);
      // SKILL's 503 rule: poll /canvas-status while it reads relaunching: true, then retry once.
      const again = during.status === 503 ? await postJson(port, '/exec', { code, idempotencyKey: `rc-exec-during-${attempt}` }) : null;
      const after = await waitFor(async () => (await shapeIds(port)).includes(id), 5000);
      if (st.connected && st.relaunching && st.room === board && st.activeRoom === target) caught = { attempt, during, landed, again, after };
    }
    ok(!!caught, `an /exec is made while the launcher's canvas for X is connected and the board is Y (attempt ${caught?.attempt})`);
    ok(!(caught?.during.status === 200 && caught.during.body.ok === true && !caught.landed), `INVARIANT: that /exec never answers ok:true for a write Y does not get (${caught?.during.status} ${caught?.during.body.ok ?? caught?.during.body.error})`);
    ok(caught?.after === true, `INVARIANT: after SKILL's 503 rule the write is on Y (retry ${caught?.again?.status ?? 'none'})`);
    trackChromium(server, seen);
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
    removeBoard(target);
  }
}

async function phaseM() {
  console.log('\n[PHASE M] a page that stops answering part-way through a timeout recovery: the answer comes within the plain reload\'s time, and its line says the server relaunches the canvas');
  const board = 'wbtest_render_cap_stall';
  const WS = 3000;
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: String(WS) });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-stall-pre')).reached, 'the board has a shape');
    trackChromium(server, seen);
    // The blob corrupts the store, writes three assets and a box, then waits. The page answers the
    // probe and the harvest's first request, and its main thread blocks the moment it has sent that
    // answer, as a page that stops answering part-way through a recovery.
    const asset = (i: number): string => `{ id: 'asset:rc-stall-${i}', typeName: 'asset', type: 'image', props: { name: 's${i}.png', src: 'data:image/png;base64,' + '${'ABC'[i]}'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }`;
    const block = "const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { send.call(this, d); if (typeof d === 'string' && d.includes('\"digested\"')) { const end = Date.now() + 200000; while (Date.now() < end) {} } };";
    const sent = Date.now();
    const stall = await postJson(port, '/exec', { idempotencyKey: 'rc-stall', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${asset(0)}, ${asset(1)}, ${asset(2)}]); editor.createShapes([{ id: 'shape:rc-stall-lost', type: 'geo', x: 300, y: 0 }]); ${block} await new Promise((r) => setTimeout(r, 600000)); return 1` });
    const took = Date.now() - sent;
    trackChromium(server, seen);
    const r = stall.body.recovery;
    eq(`${stall.status} ${stall.body.ok}`, '200 false', 'the blob the canvas did not answer is ok:false');
    // Before this recovery ran on a timeout, the plain reload ended such a blob: the ws timeout plus the
    // 30 s the reload may take. The answer is no slower.
    ok(took <= WS + 30000 + 3000, `INVARIANT: the answer comes within the ws timeout and the plain reload's 30 s (${took} ms)`);
    ok(r?.recovered === false && /could not reload the canvas: it did not reload within the \d+\.\d s the recovery had left, so the server is relaunching it from the room/.test(r?.text ?? '') && !/restart the whiteboard/.test(r?.text ?? ''),
      `INVARIANT: the line says the canvas did not reload in the time left and the server is relaunching it, and asks for no restart (${JSON.stringify(r)})`);
    deepEq([...(r?.missing ?? [])].sort(), ['asset:rc-stall-0', 'asset:rc-stall-1', 'asset:rc-stall-2'], 'the answer names the three assets it could not read');
    deepEq(r?.why, { 'asset:rc-stall-0': 'no answer', 'asset:rc-stall-1': 'no answer', 'asset:rc-stall-2': 'no answer' }, 'INVARIANT: and says why: the canvas did not answer');
    ok(/could not read asset:rc-stall-\d whole/.test(server._log) && (server._log.match(/could not read asset:rc-stall-\d whole/g) ?? []).length === 1, 'INVARIANT: the canvas is asked for one asset, not one per asset, once it stops answering');
    const lines = ((await fetch(`http://127.0.0.1:${port}/messages`).then((x) => x.json() as Promise<MessagesBody>)).messages ?? []).filter((m) => m.author?.name === 'Whiteboard').map((m) => m.text);
    ok(lines.includes(r?.text), 'the panel shows the same line');
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.connected === true && st.relaunching === false && st.browserUp === true; }, 90000, 500), 'INVARIANT: the relaunched canvas comes back');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { lost: !!editor.getShape('shape:rc-stall-lost'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { lost: true, corrupted: false }, 'INVARIANT: the relaunched canvas holds the box the blob drew, from the put-back, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function phaseN() {
  console.log('\n[PHASE N] a recovery whose time runs out on a page that still answers, slowly: the line says the time ran out, not that the canvas stopped answering');
  const board = 'wbtest_render_cap_slowread';
  // A ws timeout longer than the recovery's 30 s, so the request for the asset is bounded by the recovery's
  // own time and the time runs out before a reload can begin.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: '40000' });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-slow-pre')).reached, 'the board has a shape');
    trackChromium(server, seen);
    // The blob corrupts the store, writes an asset and a box, and returns, so the write comes back
    // severed. The page then answers the request for the asset whole 40 s late, its main thread free.
    const asset = "{ id: 'asset:rc-slow-0', typeName: 'asset', type: 'image', props: { name: 's.png', src: 'data:image/png;base64,' + 'S'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }";
    const late = "const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.includes('\"shapes-result\"') && !d.includes('\"digested\"') && d.includes('asset:rc-slow-0')) { setTimeout(() => send.call(this, d), 40000); return; } send.call(this, d); };";
    const sent = Date.now();
    const slow = await postJson(port, '/exec', { idempotencyKey: 'rc-slow', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${asset}]); editor.createShapes([{ id: 'shape:rc-slow-cut', type: 'geo', x: 300, y: 0 }]); ${late} return 1` });
    const took = Date.now() - sent;
    trackChromium(server, seen);
    const r = slow.body.recovery;
    ok(slow.status === 200 && slow.body.ok === false && /^sync-severed/.test(slow.body.error ?? ''), `the write the corrupted store cut off answers ok:false, sync-severed (${slow.body.error})`);
    ok(took < 40000, `the answer comes within the recovery's 30 s, not the 40 s ws timeout (${took} ms)`);
    ok(r?.recovered === false && /could not reload the canvas: the recovery's time ran out before a reload could begin, so the server is relaunching it from the room/.test(r?.text ?? ''),
      `INVARIANT: the line says the recovery's time ran out before a reload, and that the server is relaunching the canvas (${JSON.stringify(r)})`);
    ok(!/stopped answering|restart the whiteboard/.test(r?.text ?? ''), 'INVARIANT: and neither says the canvas stopped answering nor asks for a restart');
    deepEq(r?.why, { 'asset:rc-slow-0': 'no answer' }, 'the asset the canvas had not answered for is named, with its cause');
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.connected === true && st.relaunching === false && st.browserUp === true; }, 90000, 500), 'the relaunched canvas comes back');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { cut: !!editor.getShape('shape:rc-slow-cut'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { cut: true, corrupted: false }, 'the relaunched canvas holds the box the write cut off, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function phaseO() {
  console.log('\n[PHASE O] the canvas crashes while a recovery\'s reload waits on it: the line says the server is relaunching it, and asks for no restart');
  const board = 'wbtest_render_cap_crashreload';
  const WS = 3000;
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: String(WS) });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-crash-pre')).reached, 'the board has a shape');
    trackChromium(server, seen);
    // As in Phase M, the page blocks once it has answered the harvest's first request, so the recovery's
    // reload waits on it. The renderer is killed while that reload waits.
    const asset = "{ id: 'asset:rc-crash-0', typeName: 'asset', type: 'image', props: { name: 'c.png', src: 'data:image/png;base64,' + 'C'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }";
    const block = "const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { send.call(this, d); if (typeof d === 'string' && d.includes('\"digested\"')) { const end = Date.now() + 200000; while (Date.now() < end) {} } };";
    const mark = server._log.length;
    const sent = Date.now();
    const pending = postJson(port, '/exec', { idempotencyKey: 'rc-crash', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${asset}]); editor.createShapes([{ id: 'shape:rc-crash-lost', type: 'geo', x: 300, y: 0 }]); ${block} await new Promise((r) => setTimeout(r, 600000)); return 1` });
    // The one asset request goes unanswered, and the reload begins at once.
    ok(await waitFor(() => /could not read asset:rc-crash-0 whole/.test(server._log.slice(mark)), 20000, 20), 'the harvest has read what it could, and the reload has begun');
    await sleep(1500);
    trackChromium(server, seen);
    const renderers = renderersOf(chromiumMains(server.pid));
    for (const pid of renderers) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    const killedAt = Date.now() - sent;
    const crashed = await pending;
    const took = Date.now() - sent;
    trackChromium(server, seen);
    const r = crashed.body.recovery;
    eq(`${crashed.status} ${crashed.body.ok}`, '200 false', `the blob the canvas did not answer is ok:false (renderers killed: ${renderers.length})`);
    ok(r?.recovered === false && /could not reload the canvas: it went down during the recovery \(page crashed\), so the server is relaunching it from the room/.test(r?.text ?? '') && !/restart the whiteboard/.test(r?.text ?? ''),
      `INVARIANT: the line says the canvas went down with its page crashed, that the server is relaunching it, and asks for no restart (${JSON.stringify(r)})`);
    ok(took < killedAt + 5000, `the answer comes once the reload has failed, not at the recovery's deadline (renderer killed at ${killedAt} ms, answered at ${took} ms)`);
    const lines = ((await fetch(`http://127.0.0.1:${port}/messages`).then((x) => x.json() as Promise<MessagesBody>)).messages ?? []).filter((m) => m.author?.name === 'Whiteboard').map((m) => m.text);
    ok(lines.includes(r?.text), 'the panel shows the same line');
    ok(await waitFor(async () => { const st = await canvasStatus(port); return st.connected === true && st.relaunching === false && st.browserUp === true; }, 90000, 500), 'the relaunched canvas comes back');
    await sleep(1000);
    eq((server._log.slice(mark).match(/relaunching into room/g) ?? []).length, 1, 'INVARIANT: the canvas is relaunched once');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { lost: !!editor.getShape('shape:rc-crash-lost'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { lost: true, corrupted: false }, 'the relaunched canvas holds the box the blob drew, from the put-back, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

// The renderer's processes under a server, killed at once; the count killed.
function killRenderers(server: Server): number {
  const renderers = renderersOf(chromiumMains(server.pid));
  for (const pid of renderers) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  return renderers.length;
}
const statusOrDown = (port: number): Promise<Partial<CanvasStatus>> => canvasStatus(port).catch(() => ({}));
const relaunches = (log: string): number => (log.match(/relaunching into room/g) ?? []).length;

async function phaseP() {
  console.log('\n[PHASE P] the canvas crashes while the harvest waits on its last read: the server keeps serving, and the relaunched canvas holds what the blob drew');
  // The classification first: a fault from Playwright's dispatch of a Chromium message is the canvas's,
  // and a fault with any other frame on its stack is the server's.
  let isCanvasDriverFault: typeof IsCanvasDriverFault | null = null;
  try { ({ isCanvasDriverFault } = (await import(pathToFileURL(path.join(SERVER_DIR, 'canvas-fault.ts')).href)) as { isCanvasDriverFault: typeof IsCanvasDriverFault | null }); } catch {}
  ok(typeof isCanvasDriverFault === 'function', 'P: the server classifies an uncaught fault as the canvas\'s or its own (canvas-fault.ts)');
  if (typeof isCanvasDriverFault === 'function') {
    const pw = '/w/server/node_modules/playwright-core/lib/coreBundle.js';
    const withStack = (stack: string): Error => Object.assign(new Error('Assertion error'), { stack });
    // The stack the reproduction of this phase logged at 9138bc82, the paths shortened.
    const dispatch = ['Error: Assertion error', `    at assert (${pw}:838:11)`, `    at _CRSession._onMessage (${pw}:35014:11)`, `    at CRConnection._onMessage (${pw}:34951:20)`, `    at Immediate.<anonymous> (${pw}:39453:30)`, '    at process.processImmediate (node:internal/timers:574:21)'];
    ok(isCanvasDriverFault(withStack(dispatch.join('\n'))) === true, 'INVARIANT: P: an assertion in Playwright\'s dispatch of a Chromium message is the canvas\'s');
    const withServer = [...dispatch.slice(0, 3), '    at onCrash (/w/server/index.ts:4085:40)', ...dispatch.slice(3)];
    ok(isCanvasDriverFault(withStack(withServer.join('\n'))) === false, 'INVARIANT: P: the same fault with a server frame on its stack is the server\'s');
    ok(isCanvasDriverFault(new Error('a server bug')) === false, 'INVARIANT: P: an error thrown from code outside Playwright is the server\'s');
    const noDispatch = ['Error: x', `    at Timeout._onTimeout (${pw}:100:1)`, '    at listOnTimeout (node:internal/timers:608:17)', '    at process.processTimers (node:internal/timers:543:7)'];
    ok(isCanvasDriverFault(withStack(noDispatch.join('\n'))) === false, 'INVARIANT: P: a fault in Playwright away from its message dispatch is the server\'s');
    const cut = ['Error: Assertion error', ...Array.from({ length: 8 }, (_, i) => `    at f${i} (${pw}:${i}:1)`), `    at _CRSession._onMessage (${pw}:35014:11)`, `    at CRConnection._onMessage (${pw}:34951:20)`];
    ok(isCanvasDriverFault(withStack(cut.join('\n')), 10) === false, 'INVARIANT: P: a stack cut at V8\'s frame limit, which could hide a server frame, is the server\'s');
    ok(isCanvasDriverFault('Assertion error') === false, 'P: a thrown value that is not an Error is the server\'s');
  }
  const board = 'wbtest_render_cap_crashharvest';
  const WS = 8000;
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: String(WS) });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'P: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-ph-pre')).reached, 'P: the board has a shape');
    trackChromium(server, seen);
    // The blob corrupts the store, writes an asset and a box, and waits. On the timeout, the page
    // answers the probe and the harvest's list, then blocks, so the harvest's one read of the asset
    // waits. The renderer is killed during that wait: the recovery then reloads a page already dead.
    const asset = "{ id: 'asset:rc-ph-0', typeName: 'asset', type: 'image', props: { name: 'p.png', src: 'data:image/png;base64,' + 'P'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }";
    const block = "const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { send.call(this, d); if (typeof d === 'string' && d.includes('\"digested\"')) { const end = Date.now() + 200000; while (Date.now() < end) {} } };";
    const mark = server._log.length;
    const pending = postJson(port, '/exec', { idempotencyKey: 'rc-ph', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${asset}]); editor.createShapes([{ id: 'shape:rc-ph-lost', type: 'geo', x: 300, y: 0 }]); ${block} await new Promise((r) => setTimeout(r, 600000)); return 1` });
    await sleep(WS + 3000);
    ok(!/could not read asset:rc-ph-0 whole/.test(server._log.slice(mark)), 'P: the harvest is still waiting on its read of the asset');
    trackChromium(server, seen);
    const killed = killRenderers(server);
    const crashed = await pending;
    const answeredAt = Date.now();
    trackChromium(server, seen);
    const r = crashed.body.recovery;
    eq(`${crashed.status} ${crashed.body.ok}`, '200 false', `P: the blob the canvas did not answer is ok:false (renderers killed: ${killed})`);
    ok(r?.recovered === false && /could not reload the canvas: it went down during the recovery \(page crashed\), so the server is relaunching it from the room/.test(r?.text ?? '') && !/restart the whiteboard/.test(r?.text ?? ''),
      `INVARIANT: P: the line says the canvas went down and the server is relaunching it (${JSON.stringify(r)})`);
    deepEq(r?.why, { 'asset:rc-ph-0': 'no answer' }, 'P: the asset the crash cut off is named, with its cause');
    await sleep(Math.max(0, answeredAt + 3000 - Date.now()));
    ok(server.exitCode === null && server.signalCode === null && !/uncaughtException|shutting down/.test(server._log.slice(mark)),
      `INVARIANT: P: the server is still serving 3 s after the answer (exit ${server.exitCode}, signal ${server.signalCode})`);
    console.log(`  [info] P: a driver fault ${/driver faulted/.test(server._log.slice(mark)) ? 'came, and was taken for the canvas\'s' : 'did not come in this run'}`);
    ok(await waitFor(async () => { const st = await statusOrDown(port); return st.connected === true && st.relaunching === false && st.browserUp === true; }, 90000, 500), 'INVARIANT: P: the relaunched canvas comes back');
    await sleep(1000);
    eq(relaunches(server._log.slice(mark)), 1, 'INVARIANT: P: the canvas is relaunched once');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { lost: !!editor.getShape('shape:rc-ph-lost'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { lost: true, corrupted: false }, 'INVARIANT: P: the relaunched canvas holds the box the blob drew, from the put-back, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function phaseQ() {
  console.log('\n[PHASE Q] the canvas crashes part-way through the harvest\'s reads: no asset is called gone, because the relaunched canvas is never asked for one');
  const board = 'wbtest_render_cap_crashmid';
  const server = boot(board, { ...CANVAS_ON });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'Q: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-q-pre')).reached, 'Q: the board has a shape');
    trackChromium(server, seen);
    // The blob corrupts the store and writes three assets, an image of each, and a box, and returns, so
    // the write comes back severed. The page holds each answer to a read of one asset 4 s, its main
    // thread free, and the renderer is killed when the first read reaches it.
    const ids = [0, 1, 2];
    const assets = ids.map((i) => `{ id: 'asset:rc-q-${i}', typeName: 'asset', type: 'image', props: { name: 'q${i}.png', src: 'data:image/png;base64,' + '${'XYZ'[i]}'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }`).join(', ');
    const images = ids.map((i) => `{ id: 'shape:rc-q-img${i}', type: 'image', x: ${200 * i}, y: 400, props: { assetId: 'asset:rc-q-${i}', w: 10, h: 10 } }`).join(', ');
    const hold = "const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.includes('\"shapes-result\"') && !d.includes('\"digested\"') && d.includes('asset:rc-q-')) { console.log('RCQ holding an answer'); setTimeout(() => send.call(this, d), 4000); return; } send.call(this, d); };";
    const mark = server._log.length;
    const pending = postJson(port, '/exec', { idempotencyKey: 'rc-q', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${assets}]); editor.createShapes([${images}, { id: 'shape:rc-q-cut', type: 'geo', x: 700, y: 0 }]); ${hold} return 1` });
    ok(await waitFor(() => /RCQ holding an answer/.test(server._log.slice(mark)), 60000, 10), 'Q: the harvest\'s first read of an asset reaches the page');
    const killed = killRenderers(server);
    const crashed = await pending;
    trackChromium(server, seen);
    const r = crashed.body.recovery;
    ok(crashed.status === 200 && crashed.body.ok === false && /^sync-severed/.test(crashed.body.error ?? ''), `Q: the write the corrupted store cut off answers ok:false, sync-severed (renderers killed: ${killed})`);
    console.log(`  [info] Q: ${JSON.stringify(r)}`);
    deepEq(r?.why, { 'asset:rc-q-0': 'no answer', 'asset:rc-q-1': 'no answer', 'asset:rc-q-2': 'no answer' }, 'INVARIANT: Q: every asset the crash left unread has no answer, and none is called gone');
    ok(r?.recovered === false && !/restart the whiteboard/.test(r?.text ?? ''), 'Q: the line says the write may be missing, and asks for no restart');
    ok(!/went down during the recovery/.test(r?.text ?? '') || !/the canvas was reloaded/.test(r?.text ?? ''), 'INVARIANT: Q: a line that says the canvas went down during the recovery does not say it was reloaded');
    ok(server.exitCode === null && server.signalCode === null, 'Q: the server is still serving');
    ok(await waitFor(async () => { const st = await statusOrDown(port); return st.connected === true && st.relaunching === false && st.browserUp === true; }, 90000, 500), 'Q: the relaunched canvas comes back');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { cut: !!editor.getShape('shape:rc-q-cut'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { cut: true, corrupted: false }, 'Q: the relaunched canvas holds the box the write cut off, from the put-back, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
  // The same harvest with no crash: the page never answers a read of one asset, so all three are left
  // unread, the reload comes back clean, and no launcher runs. The line keeps the opening that says the
  // canvas was reloaded, and carries no went-down sentence.
  const board2 = 'wbtest_render_cap_shortput';
  const server2 = boot(board2, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: '3000' });
  const seen2 = new Set<number>();
  try {
    const port = await server2._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'Q: the render-canvas is up (no crash)');
    ok((await execLands(port, board2, 'shape:rc-q2-pre')).reached, 'Q: the board has a shape (no crash)');
    trackChromium(server2, seen2);
    const ids = [0, 1, 2];
    const assets = ids.map((i) => `{ id: 'asset:rc-q2-${i}', typeName: 'asset', type: 'image', props: { name: 'q${i}.png', src: 'data:image/png;base64,' + '${'XYZ'[i]}'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }`).join(', ');
    const images = ids.map((i) => `{ id: 'shape:rc-q2-img${i}', type: 'image', x: ${200 * i}, y: 400, props: { assetId: 'asset:rc-q2-${i}', w: 10, h: 10 } }`).join(', ');
    const drop = "const send = WebSocket.prototype.send; WebSocket.prototype.send = function (d) { if (typeof d === 'string' && d.includes('\"shapes-result\"') && !d.includes('\"digested\"') && d.includes('asset:rc-q2-')) return; send.call(this, d); };";
    const mark = server2._log.length;
    const short = await postJson(port, '/exec', { idempotencyKey: 'rc-q2', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${assets}]); editor.createShapes([${images}, { id: 'shape:rc-q2-cut', type: 'geo', x: 700, y: 0 }]); ${drop} return 1` });
    trackChromium(server2, seen2);
    const r = short.body.recovery;
    console.log(`  [info] Q (no crash): ${JSON.stringify(r)}`);
    ok(short.status === 200 && short.body.ok === false && /^sync-severed/.test(short.body.error ?? ''), `Q: the write the corrupted store cut off answers ok:false, sync-severed (no crash: ${short.body.error})`);
    eq(r?.text, `Manual recovery needed: the canvas was reloaded after a corrupted canvas store, but ${r?.missing?.length} changes could not be put back in the room, so the last write may be missing from the board. Read the board and redraw what is missing.`,
      'INVARIANT: Q: with no launcher run during the recovery, the put-back-fell-short line opens "the canvas was reloaded after <reason>, but", and carries no went-down sentence');
    deepEq(r?.why, { 'asset:rc-q2-0': 'no answer', 'asset:rc-q2-1': 'no answer', 'asset:rc-q2-2': 'no answer' }, 'Q: every asset the page did not send is unread, with no answer (no crash)');
    eq(relaunches(server2._log.slice(mark)), 0, 'Q: no canvas is relaunched (no crash)');
    const next = await postJson(port, '/exec', { code: "return { cut: !!editor.getShape('shape:rc-q2-cut'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { cut: true, corrupted: false }, 'Q: the reloaded canvas holds the box the write cut off, from the put-back, on a clean store (no crash)');
  } finally {
    await stopCanvasServer(server2, seen2);
    removeBoard(board2);
  }
}

async function phaseR() {
  console.log('\n[PHASE R] the canvas crashes after the recovery\'s reload, and its relaunch is slow: an answer that says recovered comes when a read shows the put-back');
  const board = 'wbtest_render_cap_crashafter';
  // The launcher's first relaunch (launch 2) loads and stops answering, so the canvas is back only on its
  // second attempt, about 17 s after the crash.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_TEST_WEDGE_LAUNCH: '2' });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'R: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-r-pre')).reached, 'R: the board has a shape');
    // A 40 MiB image in the room: the reloaded page takes about half a second, once loaded, to join the
    // room and connect its bridge socket, which is when the renderer is killed.
    const big = await postJson(port, '/exec', { code: "editor.createAssets([{ id: 'asset:rc-r-big', typeName: 'asset', type: 'image', props: { name: 'big.png', src: 'data:image/png;base64,' + 'R'.repeat(40 * 1024 * 1024), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }]); editor.createShapes([{ id: 'shape:rc-r-bigimg', type: 'image', x: 0, y: 600, props: { assetId: 'asset:rc-r-big', w: 10, h: 10 } }]); return 1" });
    ok(big.body.ok === true, 'R: the board holds a large image');
    await sleep(3000);
    trackChromium(server, seen);
    const mark = server._log.length;
    const pending = postJson(port, '/exec', { idempotencyKey: 'rc-r', code: "editor.store.markAsPossiblyCorrupted(); editor.createShapes([{ id: 'shape:rc-r-cut', type: 'geo', x: 300, y: 0 }]); return 1" });
    ok(await waitFor(() => /render-canvas disconnected/.test(server._log.slice(mark)), 30000, 5), 'R: the recovery\'s reload has begun');
    await sleep(50);
    const killed = killRenderers(server);
    const crashed = await pending;
    const shapes = await fetch(`http://127.0.0.1:${port}/shapes`).then(async (x) => ({ status: x.status, body: await x.text() })).catch((e) => ({ status: 0, body: e.message }));
    const st = await statusOrDown(port);
    trackChromium(server, seen);
    const log = server._log.slice(mark);
    const r = crashed.body.recovery;
    console.log(`  [info] R: ${JSON.stringify(r)}; /shapes on the answer ${shapes.status}, relaunching ${st.relaunching}`);
    ok(crashed.status === 200 && crashed.body.ok === false && /^sync-severed/.test(crashed.body.error ?? ''), `R: the write the corrupted store cut off answers ok:false, sync-severed (renderers killed: ${killed})`);
    const crashAt = log.indexOf('page crashed');
    const decidedAt = log.search(/\[recover\] room '[^']*' (NOT )?recovered/);
    ok(crashAt >= 0 && decidedAt > crashAt, 'R: the renderer died before the recovery decided its outcome');
    ok(r?.recovered === true ? shapes.status === 200 && shapes.body.includes('shape:rc-r-cut') : /relaunching it from the room/.test(r?.text ?? ''),
      `INVARIANT: R: an answer that says recovered comes when a read of /shapes shows the put-back, and one that does not says the server is relaunching the canvas (/shapes ${shapes.status})`);
    ok(await waitFor(async () => { const s2 = await statusOrDown(port); return s2.connected === true && s2.relaunching === false && s2.browserUp === true; }, 90000, 500), 'R: the relaunched canvas comes back');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { cut: !!editor.getShape('shape:rc-r-cut'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { cut: true, corrupted: false }, 'R: the relaunched canvas holds the box the write cut off, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function phaseS() {
  console.log('\n[PHASE S] a reload the recovery could give only milliseconds: the line names the time it had, never 0.0 s');
  const board = 'wbtest_render_cap_tinyreload';
  // A ws timeout longer than the recovery's 30 s, so the read of the asset is bounded by the recovery's time.
  const server = boot(board, { ...CANVAS_ON, WHITEBOARD_WS_TIMEOUT_MS: '40000' });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'S: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-s-pre')).reached, 'S: the board has a shape');
    trackChromium(server, seen);
    // The blob corrupts the store, writes an asset and a box, and returns, so the write comes back
    // severed. The recovery's time starts when the server reads the page's answer to its first probe. The
    // page answers the read of the asset 25 ms before that time ends, then blocks, so the recovery begins
    // a reload with about 25 ms left, and the reload does not finish.
    const asset = "{ id: 'asset:rc-s-0', typeName: 'asset', type: 'image', props: { name: 's.png', src: 'data:image/png;base64,' + 'T'.repeat(4096), w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }";
    const late = "const send = WebSocket.prototype.send; let probed = 0; WebSocket.prototype.send = function (d) { if (typeof d === 'string' && !probed && d.includes('\"sync-health-result\"')) probed = Date.now(); if (typeof d === 'string' && d.includes('\"shapes-result\"') && !d.includes('\"digested\"') && d.includes('asset:rc-s-0')) { setTimeout(() => { send.call(this, d); const end = Date.now() + 200000; while (Date.now() < end) {} }, Math.max(0, probed + 30000 - 25 - Date.now())); return; } send.call(this, d); };";
    const tiny = await postJson(port, '/exec', { idempotencyKey: 'rc-s', code: `editor.store.markAsPossiblyCorrupted(); editor.createAssets([${asset}]); editor.createShapes([{ id: 'shape:rc-s-cut', type: 'geo', x: 300, y: 0 }]); ${late} return 1` });
    trackChromium(server, seen);
    const r = tiny.body.recovery;
    console.log(`  [info] S: ${JSON.stringify(r)}`);
    ok(tiny.status === 200 && tiny.body.ok === false && /^sync-severed/.test(tiny.body.error ?? ''), `S: the write the corrupted store cut off answers ok:false, sync-severed (${tiny.body.error})`);
    ok(r?.recovered === false && /could not reload the canvas: (it did not reload within the \d+ ms the recovery had left|the recovery's time ran out before a reload could begin), so the server is relaunching it from the room/.test(r?.text ?? '') && !/0\.0 s/.test(r?.text ?? ''),
      `INVARIANT: S: the line names the milliseconds the reload had, or that none was left, and never 0.0 s (${r?.text})`);
    ok(await waitFor(async () => { const st = await statusOrDown(port); return st.connected === true && st.relaunching === false && st.browserUp === true; }, 90000, 500), 'S: the relaunched canvas comes back');
    trackChromium(server, seen);
    const next = await postJson(port, '/exec', { code: "return { cut: !!editor.getShape('shape:rc-s-cut'), asset: !!editor.getAsset('asset:rc-s-0'), corrupted: editor.store.isPossiblyCorrupted() }" });
    deepEq(next.body.result, { cut: true, asset: true, corrupted: false }, 'S: the relaunched canvas holds the asset and the box, from the put-back, on a clean store');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

// Test-only modules the server's Node process imports before it starts (NODE_OPTIONS), so a test can act
// inside the server without the server gaining a hook. Each is a .ts file beside this suite, loaded through
// tsx, so `--import tsx` comes first. NODE_OPTIONS is split on spaces, so each is named by its file URL,
// whose spaces are percent-encoded.
const preloads = (...files: string[]): { NODE_OPTIONS: string } => ({ NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', '--import=tsx', ...files.map((f) => `--import=${pathToFileURL(path.join(SERVER_DIR, f)).href}`)].join(' ').trim() });

// A server whose Node process throws, on SIGUSR2, a fault with the stack of Phase P's driver fault (an
// assertion in Playwright's dispatch of a Chromium message), from its own setImmediate, so it reaches the
// server's uncaughtException handler as that fault does (render-cap.preload-fault.ts).
const FAULT_PRELOAD = 'render-cap.preload-fault.ts';
const FAULT_ON_SIGUSR2 = preloads(FAULT_PRELOAD);

// A server whose render-canvas pages the preload arranges, through the Playwright module the server itself
// imports (render-cap.preload-canvas-page.ts):
// - every page runs, at the start of each document, a script that blocks its main thread for
//   sessionStorage 'wbtest-block' ms, once, and reloads the page while the time is before sessionStorage
//   'wbtest-reload-until', so a blob can make the next document block, or make each document reload;
// - with WBTEST_NAV_ON_BOOT_VERIFY=1, the launcher's verify of the boot launch's page (its second evaluate
//   of `() => true`, after the launch's own ready check) is preceded by that page asking for its own reload
//   and blocking its main thread 3 s, with the next document set to block 8 s, so the verify meets the
//   reload and asks the new document while it blocks. The preload logs `[wbtest]` lines as it does so.
const CANVAS_PAGE_PRELOAD = 'render-cap.preload-canvas-page.ts';
const NAV_ON_BOOT_VERIFY = { WBTEST_NAV_ON_BOOT_VERIFY: '1' };

async function phaseT() {
  console.log('\n[PHASE T] a driver fault while the canvas answers leaves it up; with no canvas up, the launcher brings one back');
  // A fault names no browser, and one the launcher replaced can still be dispatching, so a fault while the
  // current canvas answers must not close it, nor end the blob running on it.
  const board = 'wbtest_render_cap_stalefault';
  const server = boot(board, { ...CANVAS_ON, ...FAULT_ON_SIGUSR2 });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'T: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-t-pre')).reached, 'T: the board has a shape');
    trackChromium(server, seen);
    const mark = server._log.length;
    const running = postJson(port, '/exec', { idempotencyKey: 'rc-t', code: "await new Promise((r) => setTimeout(r, 3000)); editor.createShapes([{ id: 'shape:rc-t-after', type: 'geo', x: 300, y: 0 }]); return 1" });
    await sleep(1000);
    server.kill('SIGUSR2');
    const ran = await running;
    await sleep(2000);
    trackChromium(server, seen);
    const log = server._log.slice(mark);
    console.log(`  [info] T: the blob answered ${ran.status} ${JSON.stringify({ ok: ran.body.ok, error: ran.body.error })}`);
    ok(/driver faulted on a message from Chromium/.test(log), 'T: the fault came, and was taken for the canvas\'s');
    eq(`${ran.status} ${ran.body.ok}`, '200 true', 'INVARIANT: T: the blob running on the canvas through the fault answers ok');
    eq(relaunches(log), 0, 'INVARIANT: T: a canvas that answers is not relaunched on a driver fault');
    const next = await postJson(port, '/exec', { code: "return !!editor.getShape('shape:rc-t-after')" });
    eq(next.body.result, true, 'T: the canvas holds the box the blob drew after the fault');
    ok(server.exitCode === null && server.signalCode === null, 'T: the server is still serving');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
  // A canvas that is up and does not answer: a blob blocks the page's main thread for 25 s, and two faults
  // come 1 s apart. The first check runs out at 15 s and hands the canvas to the launcher; the second finds
  // the canvas replaced, so the canvas is relaunched once.
  const boardW = 'wbtest_render_cap_wedgefault';
  const serverW = boot(boardW, { ...CANVAS_ON, ...FAULT_ON_SIGUSR2 });
  const seenW = new Set<number>();
  try {
    const port = await serverW._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'T: the render-canvas is up (not answering)');
    ok((await execLands(port, boardW, 'shape:rc-tw-pre')).reached, 'T: the board has a shape (not answering)');
    trackChromium(serverW, seenW);
    const mark = serverW._log.length;
    const blocking = postJson(port, '/exec', { code: 'setTimeout(() => { const end = Date.now() + 25000; while (Date.now() < end) {} }, 0); return 1' });
    await sleep(1000);
    serverW.kill('SIGUSR2');
    await sleep(1000);
    serverW.kill('SIGUSR2');
    ok(await waitFor(() => /relaunched after driver faulted/.test(serverW._log.slice(mark)), 60000, 200), 'INVARIANT: T: a fault while the canvas does not answer has the launcher bring one back');
    await blocking;
    ok(await waitFor(() => canvasUp(port), 30000), 'T: the render-canvas is up after the relaunch (not answering)');
    await sleep(2000);
    trackChromium(serverW, seenW);
    const log = serverW._log.slice(mark);
    eq((log.match(/driver faulted on a message from Chromium/g) ?? []).length, 2, 'T: both faults came, and were taken for the canvas\'s (not answering)');
    eq(relaunches(log), 1, 'INVARIANT: T: two faults on a canvas that does not answer relaunch it once');
    ok(!/still answers/.test(log), 'T: neither check read the canvas as answering');
    ok((await execLands(port, boardW, 'shape:rc-tw-after')).reached, 'INVARIANT: T: the next /exec lands on the relaunched canvas');
    ok(serverW.exitCode === null && serverW.signalCode === null, 'T: the server is still serving (not answering)');
  } finally {
    await stopCanvasServer(serverW, seenW);
    removeBoard(boardW);
  }
  // The boot launch gives up (WHITEBOARD_TEST_FAIL_LAUNCHES), so no canvas is up and no launcher runs.
  const board2 = 'wbtest_render_cap_deadfault';
  const server2 = boot(board2, { ...CANVAS_ON, WHITEBOARD_TEST_FAIL_LAUNCHES: '3', ...FAULT_ON_SIGUSR2 });
  const seen2 = new Set<number>();
  try {
    const port = await server2._port;
    ok(await waitFor(() => server2._log.includes('NOT recovered after 3 attempts (the boot launch)'), 20000), 'T: the boot launch gives up');
    const mark = server2._log.length;
    server2.kill('SIGUSR2');
    ok(await waitFor(() => /relaunched after (its )?driver faulted/.test(server2._log.slice(mark)), 30000), 'INVARIANT: T: with no canvas up, the fault hands the canvas to the launcher, which brings it back');
    ok(/\[canvas\] render-canvas driver faulted; relaunching into room/.test(server2._log.slice(mark)), 'T: the launcher\'s log line reads as a sentence');
    ok(await waitFor(() => canvasUp(port), 10000), 'T: the render-canvas is up');
    trackChromium(server2, seen2);
  } finally {
    await stopCanvasServer(server2, seen2);
    removeBoard(board2);
  }
}

async function phaseU() {
  console.log('\n[PHASE U] a driver fault while the canvas reloads: the check that it answers asks the new page, so it stays up');
  // The page asks for its own reload, then blocks its main thread for 3 s, so the reload's commit waits
  // there, ahead of anything sent to the page later. The fault comes 1 s in, so the check's evaluate waits
  // behind the commit, and Playwright rejects it when the document it was sent to goes.
  const board = 'wbtest_render_cap_reloadfault';
  const server = boot(board, { ...CANVAS_ON, ...FAULT_ON_SIGUSR2 });
  const seen = new Set<number>();
  const TRIES = 3;
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'U: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-u-pre')).reached, 'U: the board has a shape');
    const tries: { decided: boolean; fault: boolean; reloaded: boolean; askedAgain: boolean; stays: boolean; relaunched: number }[] = [];
    for (let i = 0; i < TRIES; i++) {
      await waitFor(() => canvasUp(port), 60000, 200);
      await sleep(1500);
      trackChromium(server, seen);
      const mark = server._log.length;
      const reloading = postJson(port, '/exec', { code: 'setTimeout(() => { location.reload(); const end = Date.now() + 3000; while (Date.now() < end) {} }, 0); return 1' });
      await sleep(1000);
      server.kill('SIGUSR2');
      const decided = await waitFor(() => /still answers|relaunching into room/.test(server._log.slice(mark)), 30000, 50);
      await reloading;
      await waitFor(() => canvasUp(port), 60000, 300);
      trackChromium(server, seen);
      const log = server._log.slice(mark);
      tries.push({ decided, fault: /driver faulted on a message from Chromium/.test(log), reloaded: /render-canvas disconnected/.test(log), askedAgain: /\[canvas\] the render-canvas navigated while it was checked and was asked again (once|\d+ times); it answered/.test(log), stays: /still answers, so it stays up/.test(log), relaunched: relaunches(log) });
    }
    console.log(`  [info] U: ${JSON.stringify(tries)}`);
    ok(tries.every((t) => t.decided && t.fault && t.reloaded), `U: in each of ${TRIES} tries the fault came, was taken for the canvas's, and the page reloaded`);
    ok(tries.every((t) => t.askedAgain), `INVARIANT: U: in each of ${TRIES} tries the check met the reload, and asked the page again`);
    ok(tries.every((t) => t.stays && t.relaunched === 0), `INVARIANT: U: a canvas that answers across its reload is not relaunched on a driver fault (relaunches per try: ${tries.map((t) => t.relaunched).join(', ')})`);
    ok((await execLands(port, board, 'shape:rc-u-after')).reached, 'U: the next /exec lands');
    ok(server.exitCode === null && server.signalCode === null, 'U: the server is still serving');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

// A server's Chromium browser processes, sent the signal at once (SIGKILL unless named); the count signalled.
function killBrowsers(server: Server, signal: NodeJS.Signals = 'SIGKILL'): number {
  const mains = chromiumMains(server.pid);
  for (const pid of mains) { try { process.kill(pid, signal); } catch {} }
  return mains.length;
}

async function phaseV() {
  console.log('\n[PHASE V] a fresh canvas that dies while the launcher\'s verify asks it again reads dead when it dies');
  // The preload has the boot launch's page reload itself as the launcher verifies it, and the new document
  // block 8 s at its start, so the verify asks again and waits on a document that has not answered. 1.5 s
  // into that wait the renderer is killed, or the whole browser is killed or sent SIGTERM, on which it quits.
  // The crash hook defers to the launcher that is running, so only the verify can notice, and the launcher
  // spends its first attempt on that verdict.
  const legs: [string, (server: Server) => number, string][] = [
    ['renderer', killRenderers, 'it crashed'],
    ['browser', (server) => killBrowsers(server), 'its browser disconnected'],
    ['browser sent SIGTERM', (server) => killBrowsers(server, 'SIGTERM'), 'its browser disconnected'],
  ];
  for (const [leg, kill, ended] of legs) {
    const board = `wbtest_render_cap_verifydies_${leg.replace(/ /g, '_').toLowerCase()}`;
    const server = boot(board, { ...CANVAS_ON, ...NAV_ON_BOOT_VERIFY, ...preloads(CANVAS_PAGE_PRELOAD) });
    const seen = new Set<number>();
    try {
      const port = await server._port;
      ok(await waitFor(() => server._log.includes('[wbtest] the verify asks the new document'), 60000, 20), `V (${leg}): the boot launch's verify met the page's reload and asked the new document`);
      await sleep(1500);
      trackChromium(server, seen);
      const t0 = Date.now();
      const killed = kill(server);
      const read = await waitFor(() => /relaunch attempt 1\/3 produced a dead canvas/.test(server._log), 20000, 20);
      const took = Date.now() - t0;
      const line = server._log.match(/\[canvas\] the render-canvas navigated[^\n]*/)?.[0] ?? '(none)';
      console.log(`  [info] V (${leg}): killed ${killed}; the verify read the canvas dead ${took} ms after the kill; ${line}`);
      ok(read && took < 5000, `INVARIANT: V (${leg}): the verify reads the canvas dead when it dies, not at its 15 s deadline (${took} ms after the kill)`);
      ok(line.endsWith(`; ${ended}`), `V (${leg}): the check's line says how it ended, \`${ended}\` (${line})`);
      ok(await waitFor(() => /render-canvas up \(attempt 2\)/.test(server._log), 60000, 100), `V (${leg}): the launcher brings the canvas up on its next attempt`);
      trackChromium(server, seen);
      ok((await execLands(port, board, `shape:rc-v-${leg}`)).reached, `V (${leg}): the next /exec lands`);
    } finally {
      await stopCanvasServer(server, seen);
      removeBoard(board);
    }
  }
}

async function phaseW() {
  console.log('\n[PHASE W] a page that navigates again and again while it is checked is asked again at a bounded pace, and logged once');
  // A blob has each document reload itself at its start for 8 s, and the fault comes 1 s in, so every ask
  // of the check meets a navigation until the page stops reloading, about 7 s into the check.
  const board = 'wbtest_render_cap_reloadloop';
  const server = boot(board, { ...CANVAS_ON, ...preloads(FAULT_PRELOAD, CANVAS_PAGE_PRELOAD) });
  const seen = new Set<number>();
  try {
    const port = await server._port;
    ok(await waitFor(() => canvasUp(port), 30000), 'W: the render-canvas is up');
    ok((await execLands(port, board, 'shape:rc-w-pre')).reached, 'W: the board has a shape');
    trackChromium(server, seen);
    const mark = server._log.length;
    await postJson(port, '/exec', { code: "sessionStorage.setItem('wbtest-reload-until', String(Date.now() + 8000)); setTimeout(() => location.reload(), 0); return 1" });
    await sleep(1000);
    const faulted = Date.now();
    server.kill('SIGUSR2');
    const decided = await waitFor(() => /still answers|relaunching into room/.test(server._log.slice(mark)), 30000, 50);
    // The check runs between the fault and its decision, and each ask again follows a whole 250 ms pause
    // inside it, so it asks again at most once per 250 ms of that time.
    const ran = Date.now() - faulted;
    const most = Math.floor(ran / 250) + 1;
    await waitFor(() => canvasUp(port), 60000, 300);
    trackChromium(server, seen);
    const log = server._log.slice(mark);
    const lines = log.match(/^.*while it was checked.*$/gm) ?? [];
    const m = lines[0]?.match(/was asked again (once|(\d+) times)/);
    const asked = m ? (m[1] === 'once' ? 1 : Number(m[2])) : NaN;
    console.log(`  [info] W: ${lines.length} line(s) about the navigations; first: ${lines[0] ?? '(none)'}; the check ran ${ran} ms`);
    ok(decided && /driver faulted on a message from Chromium/.test(log), 'W: the fault came, and was taken for the canvas\'s');
    eq(lines.length, 1, 'INVARIANT: W: the check writes one line about the navigations, when it ends');
    ok(asked >= 2 && asked <= most, `INVARIANT: W: the check asks again at most once per 250 ms of the time it ran (asked again ${asked} in ${ran} ms; at most ${most})`);
    ok(/still answers, so it stays up/.test(log) && relaunches(log) === 0, `W: a canvas that answers once it stops reloading is not relaunched (relaunches: ${relaunches(log)})`);
    ok((await execLands(port, board, 'shape:rc-w-after')).reached, 'W: the next /exec lands');
  } finally {
    await stopCanvasServer(server, seen);
    removeBoard(board);
  }
}

async function main() {
  await phaseA();
  await phaseB();
  await phaseC();
  await phaseD();
  await phaseE();
  await phaseF();
  await phaseG();
  await phaseH();
  await phaseI();
  await phaseJ();
  await phaseK();
  await phaseL();
  await phaseM();
  await phaseN();
  await phaseO();
  await phaseP();
  await phaseQ();
  await phaseR();
  await phaseS();
  await phaseT();
  await phaseU();
  await phaseV();
  await phaseW();
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });

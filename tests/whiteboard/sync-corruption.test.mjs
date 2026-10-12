// Regression test for the whiteboard sync-corruption bug (SPEC §5 [v9.5]).
//
// The bug: a schema-invalid /exec (a geo shape with a top-level `w` outside `props`) flips the
// render-canvas store's sticky `isPossiblyCorrupted` flag; while it is set, @tldraw/sync-core
// suppresses EVERY outbound push, so later well-formed execs return ok:true, render locally, and
// never reach the authoritative TLSocketRoom. The board silently freezes at the poison point.
//
// This test reproduces that at the WS seam the SERVER owns, with no Chromium and no App.tsx build.
// It stands up a faithful headless render-canvas: a real @tldraw store + TLSyncClient joined to the
// room (so a local put genuinely pushes to the room, and a corrupted store genuinely suppresses the
// push, using the installed 5.4.2 sync client), plus an /events control socket that answers the
// exec / get-shapes / sync-health / export-image commands exactly as App.tsx does. The ONE thing it
// simulates is the editor flipping the corruption flag on a bad put (that lives in @tldraw/editor,
// an app dep the server never loads) — everything downstream (push suppression, the reload clearing
// it, re-hydration) is the real library.
//
//   node tests/whiteboard/sync-corruption.test.mjs
//
// Boots the real bridge over tsx with WHITEBOARD_NO_CANVAS (no Playwright), ephemeral ports, in
// this suite's own throwaway repository. Exit 0 = pass.
//
// How it bites: board X runs with the v9.5 guard ON (default) — a poison then a well-formed exec,
// and the well-formed shape reaches the room via server-owned recovery. Board Y runs the SAME
// sequence with WHITEBOARD_NO_SYNC_GUARD=1 (the guard disabled, i.e. pre-v9.5 behavior) and the
// well-formed shape NEVER reaches the room: that is the frozen board the fix repairs. Board Z proves
// the honest contract: a silent poison (corrupt-without-throwing) that App.tsx reports ok:true for
// is reported ok:false by the server, because the write did not reach the room. Board E reuses the
// headless canvas to change a board that cannot be saved: a switch away from it is refused, and
// the board stays served, locked and unchanged until it can be saved.

import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CANVAS_KEY, SERVER_DIR, sandbox, startServer, stopServer, stopAllServers } from './harness.mjs';

const SB = sandbox('sync-corruption');
// ws comes from the skill's server/node_modules: this suite lives outside the skill folder.
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { WebSocket: WsClient } = serverRequire('ws');
const fromServer = async (spec) => serverRequire(spec); // test-local objects only, so the CJS build is fine


const X = 'wbsync_x'; // guard ON: poison → well-formed reaches the room via recovery
const Y = 'wbsync_y'; // guard OFF: same sequence freezes the board (the bug the fix repairs)
const Z = 'wbsync_z'; // honest contract: a silent poison the app calls ok:true is reported ok:false
const ROOM = Object.fromEntries([X, Y, Z].map((b) => [b, SB.room(SB.board(b))]));

// --- browser-global shim (mirrors server/headless-shim.ts) BEFORE any tldraw client code --------
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false, visibilityState: 'visible' };
globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 16);
globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);

// tldraw client stack, imported after the shim so module-init global reads succeed.
const { Store } = await fromServer('@tldraw/store');
const { createTLSchema } = await fromServer('@tldraw/tlschema');
const syncCore = await fromServer('@tldraw/sync-core');
const { TLSyncClient, ClientWebSocketAdapter } = syncCore;
const { atom } = await fromServer('@tldraw/state');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// --- tiny assertion harness (mirrors integration.test.mjs) ------------------
let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// --- boot a bridge in this suite's own throwaway repository -----------------
function boot(board, extraEnv = {}) {
  const child = startServer(SB, SB.board(board), extraEnv);
  child.kill = (signal = 'SIGTERM') => { void stopServer(child, signal); return true; };
  return child;
}

const getJson = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json());
const post = (port, p, body) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

// A valid geo shape record, full props (headless has no shape-util defaults to lean on).
function geoRecord(id, x) {
  return {
    id, typeName: 'shape', type: 'geo', x, y: 0, rotation: 0, index: 'a1', parentId: 'page:page',
    isLocked: false, opacity: 1, meta: {},
    props: {
      geo: 'rectangle', w: 100, h: 100, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw',
      size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1,
      flipX: false, flipY: false, richText: { type: 'doc', content: [{ type: 'paragraph' }] },
    },
  };
}
// Exec blobs the fake canvas runs against its editor facade, mirroring App.tsx's AsyncFunction.
const validCode = (id, x) => `editor.store.put([${JSON.stringify(geoRecord(id, x))}]);`;
// Poison: a geo shape with a top-level `w` (outside props). store.put throws
// "At shape(type = geo).w: Unexpected property"; the editor facade flips corruption on the throw.
const poisonCode = (id) => `editor.store.put([${JSON.stringify({ ...geoRecord(id, 0), w: 50 })}]);`;
// Silent poison: corrupts the store WITHOUT throwing, so the app reports ok:true. The server must
// still report ok:false because the write never reaches the room (honest-contract override).
const silentPoisonCode = 'editor.store.markAsPossiblyCorrupted();';

// A faithful headless render-canvas: a real tldraw store + sync client (pushes to / is suppressed
// by the room exactly like the browser), plus the /events control socket App.tsx speaks over.
class FakeCanvas {
  constructor(port, roomId) {
    this.port = port;
    this.roomId = roomId;
    this.closing = false;
  }

  buildSyncClient() {
    this.store = new Store({ schema: createTLSchema(), props: {} });
    this.socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${this.port}/sync/${this.roomId}`);
    this.loaded = new Promise((resolve) => {
      this.syncClient = new TLSyncClient({
        store: this.store,
        socket: this.socket,
        presence: atom('presence', null),
        onLoad: () => resolve(),
        onSyncError: (reason) => console.warn(`[fake] sync error: ${reason}`),
      });
    });
  }

  // Mirrors App.tsx's exec scope: an `editor` whose store.put flips the corruption flag if a put
  // throws (what @tldraw/editor does internally, the one piece the server never loads).
  editorFacade() {
    const store = this.store;
    return {
      store: {
        put: (recs) => { try { store.put(recs); } catch (e) { store.markAsPossiblyCorrupted(); throw e; } },
        markAsPossiblyCorrupted: () => store.markAsPossiblyCorrupted(),
        isPossiblyCorrupted: () => store.isPossiblyCorrupted(),
      },
      getCurrentPageShapes: () => store.allRecords().filter((r) => r.typeName === 'shape'),
    };
  }

  send(frame) {
    if (this.ev && this.ev.readyState === WsClient.OPEN) this.ev.send(JSON.stringify(frame));
  }

  async handleFrame(frame) {
    switch (frame.type) {
      case 'exec': {
        const editor = this.editorFacade();
        try {
          const fn = new AsyncFunction('editor', 'createShapeId', 'createBindingId', 'toRichText', frame.code);
          await fn(editor, (x) => x, (x) => x, (x) => x);
          this.send({ type: 'exec-result', id: frame.id, ok: true });
        } catch (err) {
          this.send({ type: 'exec-result', id: frame.id, ok: false, error: String(err) });
        }
        break;
      }
      case 'get-shapes': {
        let shapes;
        try { shapes = JSON.parse(JSON.stringify(this.store.allRecords().filter((r) => r.typeName === 'shape'))); }
        catch { shapes = []; }
        this.send({ type: 'shapes-result', id: frame.id, ok: true, shapes, page: { id: 'page:page', name: 'Page' }, camera: { x: 0, y: 0, z: 1 }, selection: [] });
        break;
      }
      case 'sync-health': {
        this.send({
          type: 'sync-health-result',
          id: frame.id,
          possiblyCorrupted: this.store.isPossiblyCorrupted(),
          connectedToRoom: !!this.syncClient?.isConnectedToRoom,
          speculativeAdded: 0,
          lastServerClock: typeof this.syncClient?.lastServerClock === 'number' ? this.syncClient.lastServerClock : null,
        });
        break;
      }
      case 'export-image':
        this.send({ type: 'image', id: frame.id, ok: false });
        break;
      default:
        break;
    }
  }

  connectEvents() {
    this.ev = new WsClient(`ws://127.0.0.1:${this.port}/events?role=agent&canvasKey=${CANVAS_KEY}`);
    this.ev.on('message', (raw) => { try { this.handleFrame(JSON.parse(raw.toString())); } catch { /* ignore */ } });
    // A server-driven recovery reloads the canvas by dropping this socket; a real page would come
    // back with a fresh, uncorrupted store. Mirror that: rebuild the store + sync client + socket.
    this.ev.on('close', () => { if (!this.closing) this.reconnectFresh(); });
    this.ev.on('error', () => {});
  }

  reconnectFresh() {
    try { this.syncClient.close(); } catch { /* already closed */ }
    try { this.socket.close(); } catch { /* already closed */ }
    try { this.store.dispose(); } catch { /* already disposed */ }
    this.buildSyncClient();
    this.connectEvents();
  }

  async connect() {
    this.buildSyncClient();
    this.connectEvents();
    await this.loaded;
    await sleep(300); // let the server register the render-canvas socket
  }

  close() {
    this.closing = true;
    try { this.ev?.close(); } catch { /* ignore */ }
    try { this.syncClient?.close(); } catch { /* ignore */ }
    try { this.socket?.close(); } catch { /* ignore */ }
    try { this.store?.dispose(); } catch { /* ignore */ }
  }
}

// Poll /canvas-status until the room's shape count reaches `want`, or the deadline passes.
async function waitRoomShapes(port, want, ms = 4000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await getJson(port, '/canvas-status').catch(() => ({}));
    if (typeof s.roomShapes === 'number' && s.roomShapes >= want) return s.roomShapes;
    if (Date.now() >= deadline) return typeof s.roomShapes === 'number' ? s.roomShapes : -1;
    await sleep(150);
  }
}

async function main() {

  // ── Board X: guard ON. Poison then well-formed; the well-formed shape reaches the room. ──────
  const srvX = boot(X);
  const portX = await srvX._port;
  const fakeX = new FakeCanvas(portX, ROOM[X]);
  await fakeX.connect();
  console.log(`\n[X guard ON] port=${portX}`);

  const baseX = await getJson(portX, '/canvas-status');
  ok(baseX.roomShapes === 0, 'X: room starts with 0 shapes');

  const poisonX = await post(portX, '/exec', { code: poisonCode('shape:x_poison') });
  ok(poisonX.ok === false, 'X: the poison exec returns ok:false (not ok:true)');

  const wellX = await post(portX, '/exec', { code: validCode('shape:x_good', 200) });
  const reachedX = await waitRoomShapes(portX, 1, 5000);
  ok(reachedX >= 1, `X: the well-formed shape reached the room after recovery (roomShapes=${reachedX})`);
  console.log(`  [X] well-formed exec returned ok=${wellX.ok}`);

  const msgsX = await getJson(portX, '/messages');
  const announced = (msgsX.messages ?? []).some((m) => typeof m.text === 'string' && m.text.includes('Recovered the board'));
  ok(announced, 'X: recovery posted a visible panel line naming the recovery');

  fakeX.close();
  srvX.kill('SIGTERM');
  await sleep(500);

  // ── Board Y: guard OFF (pre-v9.5). The SAME sequence freezes the board — this is the bite. ───
  const srvY = boot(Y, { WHITEBOARD_NO_SYNC_GUARD: '1' });
  const portY = await srvY._port;
  const fakeY = new FakeCanvas(portY, ROOM[Y]);
  await fakeY.connect();
  console.log(`\n[Y guard OFF] port=${portY}`);

  await post(portY, '/exec', { code: poisonCode('shape:y_poison') });
  await post(portY, '/exec', { code: validCode('shape:y_good', 200) });
  const reachedY = await waitRoomShapes(portY, 1, 3000);
  ok(reachedY === 0, `Y: without the guard the well-formed shape never reaches the room (roomShapes=${reachedY}) — the frozen board the fix repairs`);

  fakeY.close();
  srvY.kill('SIGTERM');
  await sleep(500);

  // ── Board Z: honest contract. A silent poison the app reports ok:true → server reports ok:false. ─
  const srvZ = boot(Z);
  const portZ = await srvZ._port;
  const fakeZ = new FakeCanvas(portZ, ROOM[Z]);
  await fakeZ.connect();
  console.log(`\n[Z honest contract] port=${portZ}`);

  const silentZ = await post(portZ, '/exec', { code: silentPoisonCode });
  ok(silentZ.ok === false, 'Z: a silent corrupting exec (app-side ok:true) is reported ok:false by the server');
  ok(silentZ.error === 'sync-severed' || typeof silentZ.error === 'string', `Z: the severed exec carries an error (${silentZ.error})`);

  fakeZ.close();
  srvZ.kill('SIGTERM');
  await sleep(300);

  // ── Board E: a switch away from a board whose changes cannot be saved is refused. ─────────────
  // Its folder is read-only, so the room changes but cannot be flushed. Evicting it would lose the
  // change, so the server keeps it, its peers and its lock, and refuses the switch.
  const roDir = path.join(SB.root, 'read-only');
  fs.mkdirSync(roDir);
  const boardE = path.join(roDir, 'e.tldr');
  const roomE = SB.room(boardE);
  const srvE = startServer(SB, boardE);
  const portE = await srvE._port;
  const fakeE = new FakeCanvas(portE, roomE);
  await fakeE.connect();
  console.log(`\n[E unsaveable switch] port=${portE}`);
  fs.chmodSync(roDir, 0o555);
  try {
    await post(portE, '/exec', { code: validCode('shape:e_good', 0) });
    ok((await waitRoomShapes(portE, 1, 4000)) >= 1, 'E: the change reached the room');
    const target = SB.board('wbsync_e_target');
    const switched = await fetch(`http://127.0.0.1:${portE}/board/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: target }),
    });
    ok(switched.status === 503, `E: the switch is refused (status ${switched.status})`);
    const status = await getJson(portE, '/canvas-status');
    ok(status.activeRoom === roomE, 'E: the server still serves the board it could not save');
    ok(status.roomShapes >= 1, 'E: and its room still holds the change');
    ok(fs.existsSync(SB.files(boardE).lock), 'E: its lock is kept');
    ok(!fs.existsSync(SB.files(target).lock), 'E: the target board\'s lock was released');
    const msgs = (await getJson(portE, '/messages')).messages ?? [];
    ok(msgs.some((m) => typeof m.text === 'string' && m.text.startsWith('Switching boards was refused')), 'E: the panel says the switch was refused, and why');
  } finally {
    fs.chmodSync(roDir, 0o755);
  }
  fakeE.close();
  await post(portE, '/done', {});
  await srvE.exited;
  ok(fs.existsSync(boardE) && fs.readFileSync(boardE, 'utf8').includes('shape:e_good'), 'E: once the folder is writable again, closing saves the change');

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error('\nERROR', e); process.exitCode = 1; })
  .finally(async () => { await stopAllServers(); process.exit(process.exitCode ?? 0); });

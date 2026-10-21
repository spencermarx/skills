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
//   node --import tsx tests/whiteboard/sync-corruption.test.ts   (run from the skill's server/)
//
// Boots the real bridge over tsx with WHITEBOARD_NO_CANVAS (no Playwright), ephemeral ports, in this
// suite's own throwaway repository. Boards R, R6, B, L and A run the real render-canvas and skip
// without Playwright's Chromium and the built app. Exit 0 = pass.
//
// How it bites: board X runs with the v9.5 guard ON (default) — a poison then a well-formed exec,
// and the well-formed shape reaches the room via server-owned recovery. Board Y runs the SAME
// sequence with WHITEBOARD_NO_SYNC_GUARD=1 (the guard disabled, i.e. pre-v9.5 behavior) and the
// well-formed shape NEVER reaches the room: that is the frozen board the fix repairs. Board Z proves
// the honest contract: a silent poison (corrupt-without-throwing) that App.tsx reports ok:true for
// is reported ok:false by the server, because the write did not reach the room.
//
// Recovery's report and what it puts back (the fake canvas, then the real one):
//   - Board P: an operator (a headless sync peer) moves a shape while recovery reloads the canvas; the
//     move stays, and the write the corrupted store cut off still reaches the room.
//   - Board U: a cut-off update, with a canvas whose writes after the reload never land and a peer's
//     edit moving the room meanwhile; the report says recovered exactly when the update is in the room.
//   - Board H: a cut-off create on a canvas that does not answer the harvest; the create is not in the
//     room, so the report says NOT recovered.
//   - Board D: a cut-off delete reaches the room, while a shape on another page and one a peer creates
//     during the reload stay.
//   - Board G: on other pages, a peer's change during the reload stands, and recovery leaves nothing
//     pointing at a record the room lacks: a cut-off create on a page the operator removed is not put
//     back, and a page the cut-off write removed stays under a shape the operator moved.
//   - Board R (the real render-canvas and app, as render-cap.test.ts boots them, plus a headless
//     operator): a throw inside editor.run, bare and the create guard's, on a healthy board is reported
//     healthy and leaves every shape, stamps included, as it was; a move the operator makes during a
//     recovery's reload stays, and the cut-off write keeps its own author stamps; an editor.undo() at the
//     top of the next blob reverts nothing of a recovery; a cut-off delete reaches the room; a create
//     and a throw in one editor.run leave the canvas and the room agreeing, and a report that says so,
//     whether tldraw rolls the create back (Board R) or keeps it (Board R6, a fresh board's first exec).
//   - Board M: a record the room's schema refuses is not put back, nor a shape inside it or a binding to
//     that shape, and the /exec answer carries the outcome as `recovery`, naming all three in `missing`.
//   - Board K: a binding the operator makes during the reload keeps the shape the cut-off write deleted,
//     an image the operator moves keeps the asset the cut-off write removed, and a cut-off image whose
//     asset the operator removed is not put back; the panel line counts no deletion, and the answer
//     names every record it counts as staying in `kept`.
//   - Board N: two assets the canvas cannot send whole, once never answered, once answered without
//     records, and once answered with more than the bridge's 100 MiB message limit, cost those assets
//     and the image that needs one: the cut-off box still reaches the room, the room's copy of the
//     renamed asset stays, `missing` names the three, and `why` gives each asset its cause. A canvas
//     that leaves one unanswered is not asked for the other, and an oversized answer fails at once.
//   - Board S: a canvas that stops answering after the harvest's first answer costs the answer one
//     request's bound, not one per asset.
//   - Board V: an asset gone from the canvas between the harvest's list and its fetch: deleted by the
//     operator, it and the image on it are held back and named, not put back pointing at nothing;
//     removed by the canvas alone, the room's copy stays.
//   - Board E: a recovery that throws (WHITEBOARD_TEST_RECOVERY_THROW=1) is answered and posted as a
//     manual recovery, and the boot warns that the hook is armed; set to 0 it arms nothing (E0).
//   - Board T: a blob that corrupts the store, draws, and outlives the ws timeout is recovered, and the
//     answer carries the outcome (render-cap.test.ts Phase L runs it on the real canvas). Boards T and
//     D answer recovered only once the reloaded canvas, whose room changes arrive 400 ms late, shows
//     the put-back; Board C, whose canvas never catches up, is not reported recovered, and its line
//     asks for a second read before a redraw.
//   - Board Q: a canvas no reload repairs, with no server-owned page to relaunch: the line says the
//     board could not be repaired, with "tried 1 time" or "tried 2 times" after that many reloads, and
//     with the recovery's time running out when none could begin (Q0, "tried 0 times" before this).
//     Q0e is Q0 with every server timer waking before its Date.now() bound, as setTimeout can
//     (sync-corruption.preload-early-timers.mjs): before the recovery's waits re-armed to Date.now(), a
//     reload began with milliseconds left, its probe went unanswered, and the line said "reloaded".
//   - Board L (the real render-canvas): a board holding 108 MiB of inline images, more than one
//     websocket message to the bridge may carry, recovers a cut-off write; the harvest sends each asset's
//     data as a digest and asks for whole only the assets the room does not hold the same.
//   Every recovery's /exec answer carries its outcome as `recovery` (Boards X, H, M, K, N, E, T, B and
//   L); a blob's own error that leaves the store clean carries none (Board R).
//   - Board B (the real render-canvas): recovery puts back every document record a cut-off blob wrote,
//     on every page: an arrow's two bindings, a create on another page, and a shape moved to another
//     page followed by a return to the first, which it never deletes; the panel line counts records by
//     kind. It also fails if the canvas stops exposing window.tlsync, whose lastServerClock is the
//     harvest's clock. Against the recovery before round 13 of the PR #236 review, which harvested only
//     the current page's shapes, 5 of Board B's checks fail: both bindings missing, the other page's
//     create missing, the moved shape deleted, and the two report lines.
//
// Who owns a copy (SPEC §8.6), on the real render-canvas, a headless operator peer and a real operator
// tab (Board A): a duplicate or a paste a blob makes is stamped with the blob's agent, whoever drew the
// original, and the operator tab's keyboard duplicate and copy-paste stamp every copy as the operator's;
// the originals keep their stamps; a shape restored by undo, redo or moveShapesToPage keeps its own
// stamps, including one the canvas already held when it loaded. Against the working tree before this
// change (which kept a createdBy the record carried and restamped lastEditedBy on every local create),
// 10 of its 30 checks fail: every copy names the original's author, and every restore names the
// undoer in lastEditedBy.
//
// Toggle-proof: against 825f571b, whose recovery reapplied every harvested shape through the canvas
// as an exec stamped `Claude` and counted itself successful when the room clock had moved, 20 of the
// suite's 60 checks fail: Board P's move and recolor are reverted, Board U and Board H report
// recovered with the write missing from the room, Board D's and Board R's cut-off deletes never reach
// the room, and in Boards R and R6 every throw reports NOT recovered and restamps every shape, the move
// is reverted, the cut-off shape is restamped at recovery time, and the undo reverts the reapply's
// stamps.

import { spawn, execFileSync, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { Browser } from 'playwright';
// Types only: erased at run time, so nothing of tldraw loads before the browser-global shim below.
import type { IdOf } from '@tldraw/store';
import type {
  TLArrowBinding, TLAssetId, TLBindingId, TLGeoShape, TLImageAsset, TLImageShape, TLPage, TLPageId, TLRecord,
  TLShape, TLShapeId, TLStore, TLStoreProps,
} from '@tldraw/tlschema';
import type { TLSyncClient as TLSyncClientType } from '@tldraw/sync-core';
import { createRequire } from 'node:module';
import { CANVAS_KEY, SERVER_DIR, hasAppBuild, hasChromium, sandbox } from './harness.mjs';

// The store's corruption flag, excluded from @tldraw/store's published typings but public at run time
// in the installed 5.4.2; App.tsx's exec scope reaches it as editor.store.isPossiblyCorrupted().
interface CorruptionFlag { markAsPossiblyCorrupted(): void; isPossiblyCorrupted(): boolean }
type CanvasStore = TLStore & CorruptionFlag;

// This suite lives outside the skill, in tests/whiteboard/: the server and its packages come from
// the skill's server/, and every board from this suite's own throwaway repository.
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { WebSocket: WsClient } = serverRequire('ws') as typeof import('ws');
type WsClient = import('ws').WebSocket;
const { chromium } = serverRequire('playwright') as typeof import('playwright');
// No suite server may ring a real session's inbox, take its identity, or read an exported PORT.
const SCRUBBED_ENV = { CLAUDE_CODE_MESSAGING_SOCKET: undefined, CLAUDE_CODE_MESSAGING_TOKEN: undefined,
  CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PID: undefined, CLAUDE_JOB_DIR: undefined, PORT: undefined };
// Boot the server the way the skill does (node with the tsx loader in-process, no tsx CLI
// wrapper), so the spawned child IS the server and killing it never orphans a board.
const BOOT_ARGS = ['--import', 'tsx', 'index.ts'];

// This suite's own throwaway repository (WHITEBOARD_REPO); HOME is its boards folder.
const SB = sandbox('sync-corruption');
const HOME: string = SB.home;

const X = 'wbsync_x'; // guard ON: poison → well-formed reaches the room via recovery
const Y = 'wbsync_y'; // guard OFF: same sequence freezes the board (the bug the fix repairs)
const Z = 'wbsync_z'; // honest contract: a silent poison the app calls ok:true is reported ok:false
const P = 'wbsync_p'; // a peer's move during recovery's reload stays
const U = 'wbsync_u'; // a cut-off update the canvas never lands: the report matches the room
const HV = 'wbsync_h'; // a harvest the corrupted canvas does not answer: NOT recovered
const D = 'wbsync_d'; // a cut-off delete reaches the room; another page's shape and a peer's new one stay
const R = 'wbsync_r'; // the real render-canvas and app
const R6 = 'wbsync_r6'; // the real render-canvas: a create and a throw in one editor.run as a fresh board's first exec
const A = 'wbsync_a'; // the real render-canvas: a duplicate or a paste belongs to whoever made it
const G = 'wbsync_g'; // on other pages, a peer's change during the reload stands, and nothing is left pointing at a missing record
const B = 'wbsync_b'; // the real render-canvas: recovery puts back bindings, other pages' writes, and a moved shape
const M = 'wbsync_m'; // a record the room refuses: the answer names it
const K = 'wbsync_k'; // what a peer's change needs stays, and nothing put back needs what a peer removed
const L = 'wbsync_l'; // the real render-canvas: a board with 108 MiB of images recovers
const N = 'wbsync_n'; // an asset the canvas never sends whole costs that asset alone
const N2 = 'wbsync_n2'; // an asset fetch answered without records is a failed read, not a deletion
const N3 = 'wbsync_n3'; // an asset whose answer is over the bridge's message limit fails at once, as too large
const E = 'wbsync_e'; // a recovery that throws answers as a manual recovery
const E0 = 'wbsync_e0'; // the test-only fault set to anything but 1 arms nothing
const T = 'wbsync_t'; // a blob that corrupts the store, then outlives the ws timeout, is recovered
const S = 'wbsync_s'; // a canvas that stops answering part-way through the harvest costs one request bound
const V = 'wbsync_v'; // an asset a peer deletes between the harvest's list and its fetch is held back
const V2 = 'wbsync_v2'; // an asset the canvas removes between the list and its fetch keeps the room's copy
const C = 'wbsync_c'; // a reloaded canvas that never shows the put-back is not reported recovered
const Q0 = 'wbsync_q0'; // a canvas still corrupted and no reload begun: the line says the time ran out
const Q0E = 'wbsync_q0e'; // Q0 with the server's timers waking early: still no reload begun
const Q1 = 'wbsync_q1'; // a canvas still corrupted after one reload: "tried 1 time"
const Q2 = 'wbsync_q2'; // a canvas still corrupted after two reloads: "tried 2 times"
const US = 'wbsync_us'; // a switch away from a board whose change cannot be saved is refused
const boards = [X, Y, Z, P, U, HV, D, G, M, K, N, N2, N3, E, E0, T, S, V, V2, C, Q0, Q0E, Q1, Q2, US, R, R6, B, L, A];

// --- browser-global shim (mirrors server/headless-shim.ts) BEFORE any tldraw client code --------
const g = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
  requestAnimationFrame?: (cb: (t: number) => void) => unknown;
  cancelAnimationFrame?: (id: unknown) => void;
};
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
g.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false, visibilityState: 'visible' };
g.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame ??= (id) => clearTimeout(id as ReturnType<typeof setTimeout>);

// tldraw client stack, imported after the shim so module-init global reads succeed.
const { Store } = serverRequire('@tldraw/store') as typeof import('@tldraw/store');
const { createTLSchema } = serverRequire('@tldraw/tlschema') as typeof import('@tldraw/tlschema');
const { TLSyncClient } = serverRequire('@tldraw/sync-core') as typeof import('@tldraw/sync-core');
// The published typings omit ClientWebSocketAdapter; the server's client-adapter.ts types the runtime
// export.
const { ClientWebSocketAdapter } = serverRequire('@tldraw/sync-core') as unknown as typeof import('../../skills/_incubating/whiteboard/server/client-adapter.js');
const { atom } = serverRequire('@tldraw/state') as typeof import('@tldraw/state');

type SyncClient = TLSyncClientType<TLRecord, TLStore>;
type ClientSocket = InstanceType<typeof ClientWebSocketAdapter>;

// An exec blob's scope, as App.tsx builds it: the blob's code is the body of an async function.
type ExecFn = (editor: unknown, createShapeId: (x: unknown) => unknown, createBindingId: (x: unknown) => unknown, toRichText: (x: unknown) => unknown) => Promise<unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...params: string[]) => ExecFn;

// --- tiny assertion harness (mirrors integration.test.ts) ------------------
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}

// --- boot a bridge, resolve its port from stdout (mirrors integration.test.ts) ----------------
type BootedServer = ChildProcessByStdio<null, Readable, Readable> & { _log: string; _port: Promise<number> };
function boot(board: string, extraEnv: Record<string, string> = {}): BootedServer {
  const boardPath = path.join(HOME, `${board}.tldr`);
  const child = spawn(process.execPath, BOOT_ARGS, {
    cwd: SERVER_DIR,
    env: { ...process.env, ...SCRUBBED_ENV, ...SB.env, WHITEBOARD_CANVAS_KEY: CANVAS_KEY, WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: boardPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as BootedServer;
  child._log = '';
  child.stdout.on('data', (d: Buffer) => { child._log += d.toString(); });
  child.stderr.on('data', (d: Buffer) => { child._log += d.toString(); });
  child._port = new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d: Buffer) => { if (/Error|error:/.test(d.toString())) buf += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  return child;
}

// --- what the bridge answers (index.ts) -----------------------------------------------------------
// GET /canvas-status, the fields read here.
interface CanvasStatus { roomShapes?: number; browserUp?: boolean; connected?: boolean; relaunching?: boolean }
// A recovery's outcome on an /exec answer (index.ts RecoveryOutcome).
interface RecoveryOutcome { recovered: boolean; text: string; missing?: string[]; why?: Record<string, string>; kept?: string[] }
// POST /exec. `result` is whatever the blob returned; a check that reads it as a list says so.
interface ExecAnswer<R = unknown> { ok: boolean; result?: R; error?: string; recovery?: RecoveryOutcome }
// GET /messages, the fields read here.
interface PanelMessage { text: string; author?: { name?: string } }
interface MessagesAnswer { messages?: PanelMessage[] }
// POST /session/register.
interface RegisterAnswer { sessionId: string }

const getJson = <T>(port: number, p: string): Promise<T> => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json() as Promise<T>);
const post = <T = ExecAnswer>(port: number, p: string, body: unknown): Promise<T> =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<T>);

// --- a record as the checks read it back from a store ----------------------------------------------
// tldraw types `meta` as open JSON and `props` per record kind; the checks read the author stamps the
// server writes into `meta` (SPEC §8.6) and a record's props by name, so they read through this view.
interface Stamp { kind: string; name: string; sessionId: string | null; at: number }
interface RoomRecord {
  id: string;
  typeName: string;
  x?: number;
  parentId?: string;
  fromId?: string;
  toId?: string;
  props?: Record<string, unknown>;
  meta?: { createdBy?: Stamp; lastEditedBy?: Stamp };
}
type RoomShape = RoomRecord & { parentId: string };
const asRoom = (r: TLRecord | undefined) => r as unknown as RoomRecord | undefined;
const asRooms = (rs: TLRecord[]) => rs as unknown as RoomRecord[];

// A valid geo shape record, full props (headless has no shape-util defaults to lean on).
function geoRecord(id: string, x: number): TLGeoShape {
  return {
    id: id as TLShapeId, typeName: 'shape', type: 'geo', x, y: 0, rotation: 0, index: 'a1' as TLShape['index'], parentId: 'page:page' as TLPageId,
    isLocked: false, opacity: 1, meta: {},
    props: {
      geo: 'rectangle', w: 100, h: 100, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw',
      size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1,
      flipX: false, flipY: false, richText: { type: 'doc', content: [{ type: 'paragraph' }] },
    },
  };
}
// Exec blobs the fake canvas runs against its editor facade, mirroring App.tsx's AsyncFunction.
const validCode = (id: string, x: number) => `editor.store.put([${JSON.stringify(geoRecord(id, x))}]);`;
// Poison: a geo shape with a top-level `w` (outside props). store.put throws
// "At shape(type = geo).w: Unexpected property"; the editor facade flips corruption on the throw.
const poisonCode = (id: string) => `editor.store.put([${JSON.stringify({ ...geoRecord(id, 0), w: 50 })}]);`;
// Silent poison: corrupts the store WITHOUT throwing, so the app reports ok:true. The server must
// still report ok:false because the write never reaches the room (honest-contract override).
const silentPoisonCode = 'editor.store.markAsPossiblyCorrupted();';
// An image asset with a one-pixel inline PNG, and an image shape showing an asset.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const assetRecord = (id: string): TLImageAsset => ({ id: id as TLAssetId, typeName: 'asset', type: 'image', meta: {}, props: { name: 'x.png', src: PIXEL, w: 1, h: 1, mimeType: 'image/png', isAnimated: false } });
const imageRecord = (id: string, assetId: string, x: number): TLImageShape => ({
  id: id as TLShapeId, typeName: 'shape', type: 'image', x, y: 0, rotation: 0, index: 'a2' as TLShape['index'], parentId: 'page:page' as TLPageId, isLocked: false, opacity: 1, meta: {},
  props: { w: 10, h: 10, playing: true, url: '', assetId: assetId as TLAssetId, crop: null, flipX: false, flipY: false, altText: '' },
});

// A faithful headless render-canvas: a real tldraw store + sync client (pushes to / is suppressed
// by the room exactly like the browser), plus the /events control socket App.tsx speaks over.
//   opts.onReload        called when the bridge reloads this canvas (drops its socket), before it rejoins
//   opts.landAfterReload false: once reloaded, an exec answers ok and writes nothing (a write that never lands)
//   opts.harvestCorrupted false: a get-shapes asked while the store is corrupted is never answered
//   opts.extraRecord     a record, or an array of them, the harvest's answer carries besides the store's
//   opts.assetFetch      'silent': a request for one asset whole is never answered, as by a page that
//                        has stopped answering; 'norecords': it is answered without records;
//                        'toolarge': it is answered with more than one websocket message to the bridge
//                        may carry (100 MiB), so the bridge closes the socket, and the page reconnects it
//                        a second later, store and all, as App.tsx does
//   opts.beforeAssetFetch called before a request for one asset whole is answered from the store
//   opts.silentAfterHarvest true: once it has answered recovery's first harvest request, it answers
//                        nothing more until it is reloaded, as a page whose main thread then blocks
//   opts.patchLagAfterReload  ms: once reloaded, the room's changes reach its store this much later
//   opts.clockAfterReload a number: once reloaded, its sync-health reports this as lastServerClock
//   opts.corruptAfterReload true: once reloaded, its sync-health still reports the store corrupted, as a
//                        canvas a reload does not repair
//   opts.assetAnswerAt   ms: a request for one asset whole is answered this long after the harvest's first
//                        request reached the canvas, so a test can place the reload near the recovery's end
interface FakeCanvasOpts {
  onReload?: () => Promise<void>;
  landAfterReload?: boolean;
  harvestCorrupted?: boolean;
  extraRecord?: object | object[];
  assetFetch?: 'silent' | 'norecords' | 'toolarge';
  beforeAssetFetch?: () => Promise<void>;
  silentAfterHarvest?: boolean;
  patchLagAfterReload?: number;
  clockAfterReload?: number;
  corruptAfterReload?: boolean;
  assetAnswerAt?: number;
}

// The frames the bridge sends the render-canvas (index.ts FrameToApp); the fake answers the first four.
type CanvasFrame =
  | { type: 'exec'; id: string; code: string }
  | { type: 'get-shapes'; id: string; records?: boolean; digestAssets?: boolean; ids?: string[] }
  | { type: 'sync-health' | 'export-image'; id: string }
  | { type: 'agent-message' | 'message' | 'message-state' | 'agent-status' | 'server-closing'; id?: string };

// The sync client's members the fake reads and wraps, private or excluded from the published typings
// but present at run time in the installed 5.4.2 (App.tsx reads the same off window.tlsync).
interface SyncClientInternals {
  lastServerClock?: unknown;
  isConnectedToRoom?: unknown;
  handleServerEvent(event: { type: string }): void;
}

class FakeCanvas {
  port: number;
  roomId: string;
  closing: boolean;
  opts: FakeCanvasOpts;
  reloads: number;
  assetRequests: number;
  silent: boolean;
  store!: CanvasStore;
  socket!: ClientSocket;
  syncClient!: SyncClient;
  loaded!: Promise<void>;
  ev!: WsClient;
  harvestAt?: number;
  reconnectEventsOnly?: boolean;

  constructor(port: number, roomId: string, opts: FakeCanvasOpts = {}) {
    this.port = port;
    this.roomId = roomId;
    this.closing = false;
    this.opts = opts;
    this.reloads = 0;
    this.assetRequests = 0;
    this.silent = false;
  }

  // The sync client's private members, which the fake reads as App.tsx reads window.tlsync's.
  get syncInternals(): SyncClientInternals | undefined {
    return this.syncClient as unknown as SyncClientInternals | undefined;
  }

  buildSyncClient() {
    this.store = new Store<TLRecord, TLStoreProps>({ schema: createTLSchema(), props: {} as TLStoreProps }) as CanvasStore;
    this.socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${this.port}/sync/${this.roomId}`);
    this.loaded = new Promise<void>((resolve) => {
      this.syncClient = new TLSyncClient<TLRecord, TLStore>({
        store: this.store,
        socket: this.socket,
        presence: atom<TLRecord | null>('presence', null),
        onLoad: () => resolve(),
        onSyncError: (reason: string) => console.warn(`[fake] sync error: ${reason}`),
      });
    });
    const lag = this.reloads > 0 ? this.opts.patchLagAfterReload : 0;
    if (lag) {
      const client = this.syncClient as unknown as SyncClientInternals;
      const handle = client.handleServerEvent.bind(client);
      client.handleServerEvent = (event) => {
        if (event.type === 'data' || event.type === 'patch') setTimeout(() => handle(event), lag);
        else handle(event);
      };
    }
  }

  // Mirrors App.tsx's exec scope: an `editor` whose store.put flips the corruption flag if a put
  // throws (what @tldraw/editor does internally, the one piece the server never loads).
  editorFacade() {
    const store = this.store;
    return {
      store: {
        put: (recs: TLRecord[]) => { try { store.put(recs); } catch (e) { store.markAsPossiblyCorrupted(); throw e; } },
        get: (id: IdOf<TLRecord>) => store.get(id),
        remove: (ids: IdOf<TLRecord>[]) => store.remove(ids),
        markAsPossiblyCorrupted: () => store.markAsPossiblyCorrupted(),
        isPossiblyCorrupted: () => store.isPossiblyCorrupted(),
      },
      getCurrentPageShapes: () => store.allRecords().filter((r) => r.typeName === 'shape'),
    };
  }

  send(frame: object) {
    if (this.silent) return;
    if (this.ev && this.ev.readyState === WsClient.OPEN) this.ev.send(JSON.stringify(frame));
  }

  async handleFrame(frame: CanvasFrame) {
    // Every request for one asset whole is counted, answered or not.
    if (frame.type === 'get-shapes' && frame.records === true && Array.isArray(frame.ids)) this.assetRequests++;
    if (frame.type === 'get-shapes' && frame.digestAssets === true && !Array.isArray(frame.ids)) this.harvestAt = Date.now();
    if (this.silent) return;
    switch (frame.type) {
      case 'exec': {
        if (this.reloads > 0 && this.opts.landAfterReload === false) {
          this.send({ type: 'exec-result', id: frame.id, ok: true });
          break;
        }
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
        if (this.opts.harvestCorrupted === false && this.store.isPossiblyCorrupted()) break;
        const only = frame.records === true && Array.isArray(frame.ids);
        if (only && this.opts.assetFetch === 'silent') break;
        if (only && this.opts.assetFetch === 'norecords') {
          this.send({ type: 'shapes-result', id: frame.id, ok: true, shapes: [], page: { id: 'page:page', name: 'Page' }, camera: { x: 0, y: 0, z: 1 }, selection: [] });
          break;
        }
        if (only && this.opts.assetFetch === 'toolarge') {
          const asked = asRoom(this.store.get(frame.ids![0] as IdOf<TLRecord>));
          const huge = { ...asked, props: { ...asked!.props, src: `data:image/png;base64,${'A'.repeat(101 * 1024 * 1024)}` } };
          this.reconnectEventsOnly = true;
          this.send({ type: 'shapes-result', id: frame.id, ok: true, shapes: [], records: [huge], page: { id: 'page:page', name: 'Page' }, camera: { x: 0, y: 0, z: 1 }, selection: [] });
          break;
        }
        if (only) await this.opts.beforeAssetFetch?.();
        if (only && typeof this.opts.assetAnswerAt === 'number') await sleep(Math.max(0, this.harvestAt! + this.opts.assetAnswerAt - Date.now()));
        let shapes: unknown;
        let records: unknown;
        let digested: string[] | undefined;
        try {
          // An `ids` request carries those records and no page shapes, as App.tsx answers it.
          shapes = only ? [] : JSON.parse(JSON.stringify(this.store.allRecords().filter((r) => r.typeName === 'shape' && r.parentId === 'page:page')));
          // Recovery's harvest asks for the whole document, every page, as App.tsx answers it: with
          // `digestAssets`, each asset's inline data as its SHA-256 digest; with `ids`, those records whole.
          if (frame.records === true) {
            const ids = only ? new Set(frame.ids) : null;
            let chosen = asRooms(Object.values(this.store.serialize('document')));
            if (ids) chosen = chosen.filter((r) => ids.has(r.id));
            else if (this.opts.extraRecord) chosen.push(...([] as object[]).concat(this.opts.extraRecord) as RoomRecord[]);
            if (frame.digestAssets === true && !ids) {
              digested = [];
              chosen = chosen.map((r) => {
                if (r.typeName !== 'asset' || typeof r.props?.src !== 'string') return r;
                digested!.push(r.id);
                return { ...r, props: { ...r.props, src: `sha256:${createHash('sha256').update(r.props.src, 'utf8').digest('hex')}` } };
              });
            }
            records = JSON.parse(JSON.stringify(chosen));
          }
        } catch { shapes = []; }
        this.send({ type: 'shapes-result', id: frame.id, ok: true, shapes, ...(records ? { records } : {}), ...(digested ? { digested } : {}), page: { id: 'page:page', name: 'Page' }, camera: { x: 0, y: 0, z: 1 }, selection: [] });
        if (digested && this.opts.silentAfterHarvest) this.silent = true;
        break;
      }
      case 'sync-health': {
        const clock = this.reloads > 0 && typeof this.opts.clockAfterReload === 'number' ? this.opts.clockAfterReload
          : typeof this.syncInternals?.lastServerClock === 'number' ? this.syncInternals.lastServerClock : null;
        this.send({
          type: 'sync-health-result',
          id: frame.id,
          possiblyCorrupted: this.store.isPossiblyCorrupted() || (this.reloads > 0 && this.opts.corruptAfterReload === true),
          connectedToRoom: !!this.syncInternals?.isConnectedToRoom,
          speculativeAdded: 0,
          lastServerClock: clock,
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
    this.ev.on('close', () => {
      if (this.closing) return;
      // The bridge closed the socket on an oversized message: the page keeps its store and reconnects.
      if (this.reconnectEventsOnly) {
        this.reconnectEventsOnly = false;
        setTimeout(() => { if (!this.closing) this.connectEvents(); }, 1000);
        return;
      }
      this.reconnectFresh();
    });
    this.ev.on('error', () => {});
  }

  async reconnectFresh() {
    this.reloads++;
    this.silent = false;
    try { this.syncClient.close(); } catch { /* already closed */ }
    try { this.socket.close(); } catch { /* already closed */ }
    try { this.store.dispose(); } catch { /* already disposed */ }
    await this.opts.onReload?.();
    await sleep(150); // a page takes a moment to load before it rejoins
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
async function waitRoomShapes(port: number, want: number, ms = 4000): Promise<number> {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await getJson<CanvasStatus>(port, '/canvas-status').catch((): CanvasStatus => ({}));
    if (typeof s.roomShapes === 'number' && s.roomShapes >= want) return s.roomShapes;
    if (Date.now() >= deadline) return typeof s.roomShapes === 'number' ? s.roomShapes : -1;
    await sleep(150);
  }
}

function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(isDeepStrictEqual(actual, expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

async function waitFor(pred: () => unknown, ms = 5000, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { if (await pred()) return true; } catch { /* not yet */ }
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}

// A headless operator tab: a real tldraw store and sync client joined to the room, so its edits reach
// the render-canvas as a peer's do, and its store mirrors what the room holds.
interface Peer {
  put(rec: TLRecord): void;
  move(id: string, x: number): void;
  remove(ids: string[]): void;
  get(id: string | undefined): RoomRecord | undefined;
  bindings(): RoomRecord[];
  all(): RoomRecord[];
  shapes(): Record<string, RoomShape>;
  close(): void;
}
async function syncPeer(port: number, room: string): Promise<Peer> {
  const store: TLStore = new Store<TLRecord, TLStoreProps>({ schema: createTLSchema(), props: {} as TLStoreProps });
  const socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${port}/sync/${room}`);
  let client!: SyncClient;
  await new Promise<void>((resolve) => {
    client = new TLSyncClient<TLRecord, TLStore>({ store, socket, presence: atom<TLRecord | null>('presence', null), onLoad: () => resolve(), onSyncError: () => {} });
  });
  return {
    put: (rec) => store.put([rec]),
    move: (id, x) => store.put([{ ...store.get(id as TLShapeId), x } as TLShape]),
    remove: (ids) => store.remove(ids as IdOf<TLRecord>[]),
    get: (id) => asRoom(store.get(id as IdOf<TLRecord>)),
    bindings: () => asRooms(store.allRecords().filter((r) => r.typeName === 'binding')),
    all: () => asRooms(store.allRecords().filter((r) => ['page', 'asset', 'shape', 'binding'].includes(r.typeName))),
    shapes: () => Object.fromEntries(store.allRecords().filter((r) => r.typeName === 'shape').map((r) => [r.id, JSON.parse(JSON.stringify(r))])),
    close: () => {
      try { client.close(); } catch { /* already closed */ }
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

// The panel lines recovery posted.
const panelLines = async (port: number) => ((await getJson<MessagesAnswer>(port, '/messages')).messages ?? []).filter((m) => m.author?.name === 'Whiteboard').map((m) => m.text);
const RECOVERED = /^Recovered the board/;
const FAILED = /Manual recovery needed/;

// ── Board P: a peer's move made while recovery reloads the canvas stays. ─────────────────────────
async function boardP() {
  const srv = boot(P);
  const port = await srv._port;
  let peer: Peer | undefined;
  const fake = new FakeCanvas(port, P, { onReload: async () => { if (peer && fake.reloads === 1) { peer.move('shape:p_op', 2500); await sleep(100); } } });
  try {
    await fake.connect();
    console.log(`\n[P a peer's move during the reload] port=${port}`);
    peer = await syncPeer(port, P);
    peer.put(geoRecord('shape:p_op', 0));
    ok(await waitFor(() => !!fake.store.get('shape:p_op' as TLShapeId)), "P: the operator's shape reaches the render-canvas");
    // The cut-off blob creates one shape and recolors the operator's; the operator then moves that shape
    // while recovery reloads the canvas. The room moved past the harvest there, so the room's version stands.
    const recolor = "editor.store.put([{ ...editor.store.get('shape:p_op'), props: { ...editor.store.get('shape:p_op').props, color: 'red' } }]);";
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:p_cut', 400)} ${recolor}` });
    ok(ans.ok === false, 'P: the write the corrupted store cut off answers ok:false');
    await sleep(500);
    ok(fake.reloads >= 1, 'P: recovery reloaded the canvas, and the operator moved its shape meanwhile');
    eq(peer.get('shape:p_op')?.x, 2500, "INVARIANT: the operator's move made during recovery stays, not the harvested copy");
    eq(peer.get('shape:p_op')?.props?.color, 'black', "P: the operator's shape is the operator's version, without the cut-off recolor the room moved past");
    ok(!!peer.get('shape:p_cut'), 'P: the cut-off write reaches the room');
    const lines = await panelLines(port);
    ok(lines.some((t) => RECOVERED.test(t)) && !lines.some((t) => FAILED.test(t)), `P: recovery reports recovered (${JSON.stringify(lines)})`);
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board U: a cut-off update the reloaded canvas never lands, while a peer's edit moves the room. ───
async function boardU() {
  const srv = boot(U);
  const port = await srv._port;
  let peer: Peer | undefined;
  const fake = new FakeCanvas(port, U, { landAfterReload: false, onReload: async () => { if (peer && fake.reloads === 1) { peer.move('shape:u_op', 900); await sleep(100); } } });
  try {
    await fake.connect();
    console.log(`\n[U a cut-off update] port=${port}`);
    peer = await syncPeer(port, U);
    peer.put(geoRecord('shape:u_op', 0));
    await post(port, '/exec', { code: validCode('shape:u_a', 100) });
    ok(await waitFor(() => peer!.get('shape:u_a')?.x === 100 && !!fake.store.get('shape:u_op' as TLShapeId)), 'U: the agent shape is in the room and the operator shape on the canvas');
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:u_a', 400)}` });
    ok(ans.ok === false, 'U: the update the corrupted store cut off answers ok:false');
    await sleep(500);
    const landed = peer.get('shape:u_a')?.x === 400;
    const lines = await panelLines(port);
    const recovered = lines.some((t) => RECOVERED.test(t)) && !lines.some((t) => FAILED.test(t));
    ok(recovered === landed, `INVARIANT: recovery reports recovered exactly when the cut-off update is in the room (update in room: ${landed}; panel: ${JSON.stringify(lines)})`);
    ok(landed, 'U: the cut-off update reaches the room');
    eq(peer.get('shape:u_op')?.x, 900, "U: the peer's edit during recovery stays");
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board H: the corrupted canvas does not answer the harvest, so the cut-off create cannot reach the room. ─
async function boardH() {
  const srv = boot(HV, { WHITEBOARD_WS_TIMEOUT_MS: '2000' });
  const port = await srv._port;
  const fake = new FakeCanvas(port, HV, { harvestCorrupted: false });
  try {
    await fake.connect();
    console.log(`\n[H an unanswered harvest] port=${port}`);
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:h_cut', 0)}` });
    ok(ans.ok === false, 'H: the create the corrupted store cut off answers ok:false');
    await sleep(500);
    const st = await getJson<CanvasStatus>(port, '/canvas-status');
    const lines = await panelLines(port);
    eq(st.roomShapes, 0, 'H: the cut-off create is not in the room');
    ok(!lines.some((t) => RECOVERED.test(t)) && lines.some((t) => FAILED.test(t)), `INVARIANT: a recovery that could not deliver the cut-off create reports NOT recovered (${JSON.stringify(lines)})`);
    ok(/NOT recovered/.test(srv._log), 'H: the server logs NOT recovered');
    ok(ans.recovery?.recovered === false && lines.includes(ans.recovery.text) && !('missing' in ans.recovery),
      `INVARIANT: H: the answer carries the outcome the panel shows, and names no record, since the harvest read none (${JSON.stringify(ans.recovery)})`);
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board D: a cut-off delete reaches the room; what the canvas never held stays. ─────────────────
async function boardD() {
  const srv = boot(D);
  const port = await srv._port;
  let peer: Peer | undefined;
  // The room's changes reach the reloaded canvas 400 ms late, so an answer sent before the canvas shows
  // the put-back is caught.
  const fake = new FakeCanvas(port, D, { patchLagAfterReload: 400, onReload: async () => { if (peer && fake.reloads === 1) { peer.put(geoRecord('shape:d_new', 600)); await sleep(100); } } });
  try {
    await fake.connect();
    console.log(`\n[D a cut-off delete] port=${port}`);
    peer = await syncPeer(port, D);
    peer.put({ id: 'page:other' as TLPageId, typeName: 'page', name: 'Other', index: 'a2' as TLPage['index'], meta: {} });
    peer.put({ ...geoRecord('shape:d_elsewhere', 0), parentId: 'page:other' as TLPageId });
    await post(port, '/exec', { code: validCode('shape:d_gone', 100) });
    await post(port, '/exec', { code: validCode('shape:d_stay', 300) });
    ok(await waitFor(() => !!peer!.get('shape:d_gone') && !!fake.store.get('shape:d_elsewhere' as TLShapeId)), 'D: the agent shapes are in the room and the other page\'s shape on the canvas');
    const ans = await post(port, '/exec', { code: "editor.store.markAsPossiblyCorrupted(); editor.store.remove(['shape:d_gone']);" });
    const onAnswer = !!fake.store.get('shape:d_gone' as TLShapeId);
    ok(ans.ok === false, 'D: the delete the corrupted store cut off answers ok:false');
    ok(ans.recovery?.recovered === true && !onAnswer, `INVARIANT: D: a recovered answer comes once the reloaded canvas shows the put-back, so a read made on it lacks the deleted shape (canvas still held it: ${onAnswer})`);
    await sleep(500);
    ok(!peer.get('shape:d_gone'), 'INVARIANT: the cut-off delete reaches the room');
    ok(!!peer.get('shape:d_stay') && !!peer.get('shape:d_elsewhere'), "D: the canvas's other shape and the other page's shape stay");
    ok(!!peer.get('shape:d_new'), 'D: a shape a peer created during the reload stays');
    const lines = await panelLines(port);
    ok(lines.some((t) => RECOVERED.test(t)) && !lines.some((t) => FAILED.test(t)), `D: recovery reports recovered (${JSON.stringify(lines)})`);
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board G: on other pages, a peer's change made during the reload stands, and recovery leaves the
// room with nothing pointing at a record it does not hold. ─────────────────────────────────────────
async function boardG() {
  const srv = boot(G);
  const port = await srv._port;
  let peer: Peer | undefined;
  // During the reload the operator removes one page and moves a shape on the other.
  const fake = new FakeCanvas(port, G, { onReload: async () => { if (peer && fake.reloads === 1) { peer.remove(['page:g_gone']); peer.move('shape:g_kept', 700); await sleep(100); } } });
  try {
    await fake.connect();
    console.log(`\n[G a peer's change on another page] port=${port}`);
    peer = await syncPeer(port, G);
    peer.put({ id: 'page:g_gone' as TLPageId, typeName: 'page', name: 'Gone', index: 'a2' as TLPage['index'], meta: {} });
    peer.put({ id: 'page:g_stay' as TLPageId, typeName: 'page', name: 'Stay', index: 'a3' as TLPage['index'], meta: {} });
    peer.put({ ...geoRecord('shape:g_kept', 0), parentId: 'page:g_stay' as TLPageId });
    ok(await waitFor(() => !!fake.store.get('shape:g_kept' as TLShapeId) && !!fake.store.get('page:g_gone' as TLPageId)), 'G: both pages and the shape reach the canvas');
    // One cut-off blob: a create on the page the operator then removes, and the removal of the other
    // page with its shape, which the operator then moves.
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.store.put([${JSON.stringify({ ...geoRecord('shape:g_cut', 0), parentId: 'page:g_gone' })}]); editor.store.remove(['page:g_stay', 'shape:g_kept']);` });
    ok(ans.ok === false, 'G: the write the corrupted store cut off answers ok:false');
    await sleep(500);
    ok(fake.reloads >= 1, 'G: recovery reloaded the canvas, and the operator changed both pages meanwhile');
    ok(!peer.get('page:g_gone') && !peer.get('shape:g_cut'), "INVARIANT: a cut-off create on a page the operator removed during the reload is not put back on a page the room lacks");
    eq(peer.get('shape:g_kept')?.x, 700, "G: the shape the operator moved during the reload stays, with the move");
    ok(!!peer.get('page:g_stay'), 'INVARIANT: the page under that shape stays, though the cut-off write removed it');
    const all = Object.values(peer.shapes());
    ok(all.every((s) => !!peer!.get(s.parentId)), `G: every shape in the room sits on a page or shape the room holds (${JSON.stringify(all.map((s) => [s.id, s.parentId]))})`);
    const lines = await panelLines(port);
    ok(lines.some((t) => RECOVERED.test(t)) && !lines.some((t) => FAILED.test(t)), `G: recovery reports recovered (${JSON.stringify(lines)})`);
    ok(lines.some((t) => /put back nothing\./.test(t)) && !lines.some((t) => /missing nothing/.test(t)), `INVARIANT: G: the line does not say the room was missing nothing, since it lacked the cut-off create (${JSON.stringify(lines)})`);
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board M: a record the room's schema refuses is not put back, nor is what needs it, and the answer
// names them all. ─────────────────────────────────────────────────────────────────────────────────────
async function boardM() {
  const srv = boot(M);
  const port = await srv._port;
  const good = geoRecord('shape:m_bad', 0);
  // Besides the refused shape, the harvest carries a shape inside it and a binding to that shape: the
  // room lacks what each needs, because the room refused it.
  const child = { ...geoRecord('shape:m_child', 10), parentId: 'shape:m_bad' };
  const bind = { id: 'binding:m', typeName: 'binding', type: 'arrow', fromId: 'shape:m_cut', toId: 'shape:m_child', meta: {},
    props: { terminal: 'end', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } };
  const fake = new FakeCanvas(port, M, { extraRecord: [{ ...good, props: { ...good.props, w: 'wide' } }, child, bind] });
  try {
    await fake.connect();
    console.log(`\n[M a record the room refuses] port=${port}`);
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:m_cut', 0)}` });
    ok(ans.ok === false, 'M: the create the corrupted store cut off answers ok:false');
    await sleep(500);
    const lines = await panelLines(port);
    ok(ans.recovery?.recovered === false && FAILED.test(ans.recovery?.text ?? ''), `INVARIANT: M: the answer carries the outcome, a manual recovery (${JSON.stringify(ans.recovery)})`);
    eq(ans.recovery?.missing, ['shape:m_bad', 'shape:m_child', 'binding:m'], 'INVARIANT: M: the answer names the record recovery could not put back, and each record held back because it needs that one');
    ok(/3 changes could not be put back/.test(ans.recovery?.text ?? ''), `M: the line counts every record the room lacks (${ans.recovery?.text})`);
    ok((lines as readonly unknown[]).includes(ans.recovery?.text), `M: the answer's outcome is the line the panel shows (${JSON.stringify(lines)})`);
    eq((await getJson<CanvasStatus>(port, '/canvas-status')).roomShapes, 1, 'M: the cut-off create the room accepts is put back');
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board K: a peer's change that needs a record the cut-off write removed keeps it, and nothing the
// put-back writes needs a record a peer removed: a binding to a deleted shape, and an image's asset. ──
async function boardK() {
  const srv = boot(K);
  const port = await srv._port;
  let peer: Peer | undefined;
  const peerBinding: TLArrowBinding = { id: 'binding:k_peer' as TLBindingId, typeName: 'binding', type: 'arrow', fromId: 'shape:k_ar' as TLShapeId, toId: 'shape:k_x' as TLShapeId, meta: {},
    props: { terminal: 'start', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } };
  // During the reload the operator binds an arrow to the shape the cut-off write deleted, removes the
  // asset the cut-off write's new image shows, and moves the image whose asset the cut-off write removed.
  const fake = new FakeCanvas(port, K, { onReload: async () => {
    if (peer && fake.reloads === 1) { peer.put(peerBinding); peer.remove(['asset:k_a1']); peer.move('shape:k_img2', 700); await sleep(100); }
  } });
  try {
    await fake.connect();
    console.log(`\n[K what a peer's change needs, and what a put-back needs] port=${port}`);
    peer = await syncPeer(port, K);
    peer.put(geoRecord('shape:k_x', 0));
    peer.put(geoRecord('shape:k_ar', 300));
    peer.put(assetRecord('asset:k_a1'));
    peer.put(assetRecord('asset:k_a2'));
    peer.put(imageRecord('shape:k_img2', 'asset:k_a2', 600));
    ok(await waitFor(() => !!fake.store.get('shape:k_img2' as TLShapeId) && !!fake.store.get('asset:k_a1' as TLAssetId) && !!fake.store.get('shape:k_x' as TLShapeId)), 'K: the shapes and assets reach the canvas');
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.store.remove(['shape:k_x', 'shape:k_img2', 'asset:k_a2']); editor.store.put([${JSON.stringify(imageRecord('shape:k_img', 'asset:k_a1', 900))}]);` });
    ok(ans.ok === false, 'K: the write the corrupted store cut off answers ok:false');
    await sleep(500);
    ok(fake.reloads >= 1, 'K: recovery reloaded the canvas, and the operator changed the board meanwhile');
    ok(!!peer.get('binding:k_peer'), 'INVARIANT: K: the binding the operator made during the reload stays');
    ok(!!peer.get('shape:k_x'), 'INVARIANT: K: the shape that binding binds stays, though the cut-off write deleted it');
    ok(!peer.get('shape:k_img'), 'INVARIANT: K: a cut-off image whose asset the operator removed during the reload is not put back');
    eq(peer.get('shape:k_img2')?.x, 700, 'K: the image the operator moved during the reload stays, with the move');
    ok(!!peer.get('asset:k_a2'), 'INVARIANT: K: the asset that image shows stays, though the cut-off write removed it');
    const held = new Set<unknown>(peer.all().map((r) => r.id));
    const dangling = peer.all().filter((r) => (r.typeName === 'shape' && (!held.has(r.parentId) || (r.props?.assetId && !held.has(r.props.assetId))))
      || (r.typeName === 'binding' && (!held.has(r.fromId) || !held.has(r.toId))));
    eq(dangling.map((r) => r.id), [], 'INVARIANT: K: no record in the room points at a page, shape or asset the room lacks');
    const line = (await panelLines(port)).find((t) => RECOVERED.test(t)) ?? '';
    ok(ans.recovery?.recovered === true && ans.recovery.text === line, `K: the answer carries the outcome the panel shows (${JSON.stringify(ans.recovery)})`);
    eq(line, "Recovered the board after a corrupted canvas store. Reloaded the canvas and put back nothing. 2 shapes, 1 binding and 1 asset stay as the room holds them, after someone's change during the recovery. 1 shape and 1 asset the canvas removed stay, because a record in the room needs them.",
      'INVARIANT: K: the panel line says what was left to a peer and what was kept for a record that needs it, and counts no deletion');
    eq([...(ans.recovery?.kept ?? [])].sort(), ['asset:k_a1', 'asset:k_a2', 'binding:k_peer', 'shape:k_img', 'shape:k_img2', 'shape:k_x'],
      'INVARIANT: K: the answer names every record the line counts as staying as the room holds it, in `kept`');
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board N: an asset the canvas cannot send whole costs only that asset and what needs it. ──────────
// mode 'silent': the request for it is never answered, so the canvas is taken to have stopped answering
// and is not asked for the other; mode 'norecords': it is answered without records, which is a failed
// read, not a deletion; mode 'toolarge': its answer is over the bridge's 100 MiB message limit, so the
// bridge closes the socket, and the read fails at once rather than at the ws timeout.
const PIXEL2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
type AssetFetchMode = 'silent' | 'norecords' | 'toolarge';
async function boardN(mode: AssetFetchMode) {
  const board = mode === 'silent' ? N : mode === 'norecords' ? N2 : N3;
  const WS = mode === 'toolarge' ? 8000 : 2000;
  const srv = boot(board, { WHITEBOARD_WS_TIMEOUT_MS: String(WS) });
  const port = await srv._port;
  let peer: Peer | undefined;
  const fake = new FakeCanvas(port, board, { assetFetch: mode });
  try {
    await fake.connect();
    console.log(`\n[N an asset the canvas cannot send whole: ${mode}] port=${port}`);
    peer = await syncPeer(port, board);
    peer.put(assetRecord('asset:n_old'));
    peer.put(imageRecord('shape:n_img_old', 'asset:n_old', 0));
    ok(await waitFor(() => !!fake.store.get('shape:n_img_old' as TLShapeId) && !!fake.store.get('asset:n_old' as TLAssetId)), 'N: the image and its asset reach the canvas');
    // One cut-off blob: a new asset and an image showing it, a box, and a rename of the room's asset.
    const renamed = { ...assetRecord('asset:n_old'), props: { ...assetRecord('asset:n_old').props, name: 'renamed.png' } };
    const fresh = { ...assetRecord('asset:n_new'), props: { ...assetRecord('asset:n_new').props, src: PIXEL2 } };
    const sent = Date.now();
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.store.put([${JSON.stringify(fresh)}, ${JSON.stringify(renamed)}, ${JSON.stringify(imageRecord('shape:n_img', 'asset:n_new', 300))}]); ${validCode('shape:n_box', 600)}` });
    const took = Date.now() - sent;
    ok(ans.ok === false, 'N: the write the corrupted store cut off answers ok:false');
    const cause = { silent: 'no answer', norecords: 'unreadable', toolarge: 'too large' }[mode];
    eq(ans.recovery?.why, { 'asset:n_new': cause, 'asset:n_old': cause }, `INVARIANT: N: the answer says why each unread asset is in \`missing\` (${mode})`);
    if (mode === 'silent') eq(fake.assetRequests, 1, 'INVARIANT: N: a canvas that left one asset unanswered is not asked for the next');
    if (mode === 'toolarge') ok(took < WS, `INVARIANT: N: a read whose socket the bridge closed fails at once, not at the ${WS} ms ws timeout (two oversized assets answered in ${took} ms)`);
    await sleep(500);
    ok(!!peer.get('shape:n_box'), 'INVARIANT: N: the cut-off box reaches the room, though two assets could not be read whole');
    ok(!peer.get('asset:n_new') && !peer.get('shape:n_img'), 'INVARIANT: N: the unread new asset is not in the room, nor the image that needs it');
    eq(peer.get('asset:n_old')?.props?.name, 'x.png', "INVARIANT: N: the room's copy of an asset the canvas could not send stays, unchanged and not removed");
    ok(!!peer.get('shape:n_img_old'), 'N: the image on that asset stays');
    const lines = await panelLines(port);
    ok(ans.recovery?.recovered === false && lines.includes(ans.recovery.text) && !lines.some((t) => RECOVERED.test(t)), `INVARIANT: N: the answer says not recovered, with the line the panel shows (${JSON.stringify(ans.recovery)})`);
    eq([...(ans.recovery?.missing ?? [])].sort(), ['asset:n_new', 'asset:n_old', 'shape:n_img'], 'INVARIANT: N: `missing` names both unread assets and the image held back for one');
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board E: a recovery that throws is answered, and posted, as a manual recovery. ───────────────────
async function boardE() {
  const srv = boot(E, { WHITEBOARD_TEST_RECOVERY_THROW: '1' });
  const port = await srv._port;
  const fake = new FakeCanvas(port, E);
  try {
    await fake.connect();
    console.log(`\n[E a recovery that throws] port=${port}`);
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:e_cut', 0)}` });
    ok(ans.ok === false, 'E: the write the corrupted store cut off answers ok:false');
    await sleep(300);
    const lines = await panelLines(port);
    eq(ans.recovery?.text, 'Manual recovery needed: the recovery after a corrupted canvas store stopped on an error (a test-only fault after the reload), so the last write may be missing from the board. Read the board and redraw what is missing.',
      'INVARIANT: E: a recovery that throws answers with the manual line for it');
    ok(ans.recovery?.recovered === false && !('missing' in ans.recovery) && !('kept' in ans.recovery), `E: not recovered, and naming no record, since the put-back never ran (${JSON.stringify(ans.recovery)})`);
    ok((lines as readonly unknown[]).includes(ans.recovery?.text), `INVARIANT: E: the panel shows the same line (${JSON.stringify(lines)})`);
    ok(/WARNING: test-only hooks armed: WHITEBOARD_TEST_RECOVERY_THROW\b/.test(srv._log), 'INVARIANT: E: the server warns at boot that a test-only hook is armed');
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
  // The fault set to anything but 1 arms nothing: the recovery runs, and the boot warns of nothing.
  const srv0 = boot(E0, { WHITEBOARD_TEST_RECOVERY_THROW: '0' });
  const port0 = await srv0._port;
  const fake0 = new FakeCanvas(port0, E0);
  try {
    await fake0.connect();
    console.log(`\n[E0 the test-only fault set to 0] port=${port0}`);
    const ans = await post(port0, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:e0_cut', 0)}` });
    ok(ans.recovery?.recovered === true, `INVARIANT: E0: WHITEBOARD_TEST_RECOVERY_THROW=0 arms nothing, so the recovery recovers (${JSON.stringify(ans.recovery)})`);
    ok(!/test-only hooks armed/.test(srv0._log), 'E0: and the boot warns of no armed hook');
  } finally {
    fake0.close();
    srv0.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board T: a blob that corrupts the store and then outlives the ws timeout is recovered. ────────────
async function boardT() {
  const srv = boot(T, { WHITEBOARD_WS_TIMEOUT_MS: '2000' });
  const port = await srv._port;
  // The room's changes reach the reloaded canvas 400 ms late, as in Board D.
  const fake = new FakeCanvas(port, T, { patchLagAfterReload: 400 });
  try {
    await fake.connect();
    console.log(`\n[T a timeout on a corrupted store] port=${port}`);
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:t_cut', 0)} await new Promise((r) => setTimeout(r, 3000));` });
    const onAnswer = !!fake.store.get('shape:t_cut' as TLShapeId);
    ok(ans.ok === false && /did not answer within 2 s/.test(ans.error ?? ''), `T: the blob the canvas did not answer is ok:false and says so (${ans.error})`);
    ok(onAnswer, 'INVARIANT: T: a recovered answer comes once the reloaded canvas shows the put-back, so a read made on it has the shape the blob drew');
    await sleep(300);
    eq((await getJson<CanvasStatus>(port, '/canvas-status')).roomShapes, 1, 'INVARIANT: T: what the blob drew on the corrupted store before it stalled reaches the room');
    const lines = await panelLines(port);
    ok(ans.recovery?.recovered === true && lines.includes(ans.recovery.text), `INVARIANT: T: the answer carries the recovery, the line the panel shows (${JSON.stringify(ans.recovery)})`);
    await sleep(3000);
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board S: a canvas that stops answering part-way through the harvest costs one request's bound. ───
// The blob corrupts the store, writes three assets and a box, and outlives the ws timeout; the canvas
// answers the probe and the harvest's first request, then nothing more until it is reloaded.
async function boardS() {
  const WS = 3000;
  const srv = boot(S, { WHITEBOARD_WS_TIMEOUT_MS: String(WS) });
  const port = await srv._port;
  const fake = new FakeCanvas(port, S, { silentAfterHarvest: true });
  try {
    await fake.connect();
    console.log(`\n[S a canvas that stops answering during the harvest] port=${port}`);
    const assets = ['asset:s0', 'asset:s1', 'asset:s2'].map((id, i) => ({ ...assetRecord(id), props: { ...assetRecord(id).props, src: i === 1 ? PIXEL2 : PIXEL, name: `${id}.png` } }));
    const sent = Date.now();
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.store.put(${JSON.stringify(assets)}); ${validCode('shape:s_box', 0)} await new Promise((r) => setTimeout(r, 30000));` });
    const took = Date.now() - sent;
    ok(ans.ok === false && /did not answer within 3 s/.test(ans.error ?? ''), `S: the blob the canvas did not answer is ok:false and says so (${ans.error})`);
    eq(fake.assetRequests, 1, 'INVARIANT: S: a canvas that left one asset unanswered is not asked for the others');
    ok(took < 3 * WS, `INVARIANT: S: the answer costs the exec's timeout and one asset's, not one per asset (${took} ms, bound ${3 * WS} ms)`);
    eq([...(ans.recovery?.missing ?? [])].sort(), ['asset:s0', 'asset:s1', 'asset:s2'], 'S: `missing` names the three unread assets');
    eq(ans.recovery?.why, { 'asset:s0': 'no answer', 'asset:s1': 'no answer', 'asset:s2': 'no answer' }, 'INVARIANT: S: the answer says why each is missing');
    await sleep(300);
    eq((await getJson<CanvasStatus>(port, '/canvas-status')).roomShapes, 1, 'S: the box the blob drew reaches the room');
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board V: an asset that is gone from the canvas between the harvest's list and its own fetch. ──────
// mode 'peer': the operator deletes it from the room meanwhile, so neither holds it: it and the image
// that needs it are held back and named, never put back pointing at nothing. mode 'canvas': the canvas
// removes it while the room keeps it: the room's copy stays, and the image goes in on it.
async function boardV(mode: 'peer' | 'canvas') {
  const board = mode === 'peer' ? V : V2;
  const srv = boot(board);
  const port = await srv._port;
  let peer: Peer | undefined;
  const fake = new FakeCanvas(port, board, {
    beforeAssetFetch: async () => {
      if (mode === 'peer') { peer!.remove(['asset:v_a1']); await waitFor(() => !fake.store.get('asset:v_a1' as TLAssetId), 3000, 20); }
      else fake.store.remove(['asset:v_a1' as TLAssetId]);
    },
  });
  try {
    await fake.connect();
    console.log(`\n[V an asset gone between the harvest's list and its fetch: ${mode}] port=${port}`);
    peer = await syncPeer(port, board);
    peer.put(assetRecord('asset:v_a1'));
    ok(await waitFor(() => !!fake.store.get('asset:v_a1' as TLAssetId)), 'V: the asset reaches the canvas');
    // The cut-off write renames the asset, so it is fetched whole, and creates an image on it.
    const renamed = { ...assetRecord('asset:v_a1'), props: { ...assetRecord('asset:v_a1').props, name: 'renamed.png' } };
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.store.put([${JSON.stringify(renamed)}, ${JSON.stringify(imageRecord('shape:v_img', 'asset:v_a1', 300))}]); ${validCode('shape:v_box', 600)}` });
    ok(ans.ok === false, 'V: the write the corrupted store cut off answers ok:false');
    await sleep(500);
    const held = new Set<unknown>(peer.all().map((r) => r.id));
    const dangling = peer.all().filter((r) => r.typeName === 'shape' && r.props?.assetId && !held.has(r.props.assetId)).map((r) => r.id);
    eq(dangling, [], `INVARIANT: V ${mode}: no image in the room points at an asset the room lacks`);
    ok(!!peer.get('shape:v_box'), `V ${mode}: the cut-off box reaches the room`);
    if (mode === 'peer') {
      ok(ans.recovery?.recovered === false && FAILED.test(ans.recovery?.text ?? ''), `INVARIANT: V peer: the answer does not say recovered (${JSON.stringify(ans.recovery)})`);
      eq(ans.recovery?.missing, ['shape:v_img', 'asset:v_a1'], 'INVARIANT: V peer: `missing` names the asset and the image held back for it');
      eq(ans.recovery?.why, { 'asset:v_a1': 'gone' }, 'INVARIANT: V peer: the answer says the asset is gone');
    } else {
      eq(peer.get('asset:v_a1')?.props?.name, 'x.png', "INVARIANT: V canvas: the room's copy of the asset stays");
      eq(peer.get('shape:v_img')?.props?.assetId, 'asset:v_a1', 'V canvas: the image goes in on it');
      ok(ans.recovery?.recovered === true, `V canvas: the answer says recovered (${JSON.stringify(ans.recovery)})`);
    }
  } finally {
    peer?.close();
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board C: a reloaded canvas that never shows the put-back is not reported recovered. ──────────────
// Its sync-health reports a room clock of 0 once reloaded, as a canvas the room's changes never reach.
async function boardC() {
  const srv = boot(C);
  const port = await srv._port;
  const fake = new FakeCanvas(port, C, { clockAfterReload: 0 });
  try {
    await fake.connect();
    console.log(`\n[C a reloaded canvas that never shows the put-back] port=${port}`);
    const sent = Date.now();
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); ${validCode('shape:c_cut', 0)}` });
    const took = Date.now() - sent;
    ok(ans.recovery?.recovered === false && /the reloaded canvas had not shown it/.test(ans.recovery?.text ?? ''), `INVARIANT: C: the answer says the canvas had not shown the put-back, not recovered (${JSON.stringify(ans.recovery)})`);
    ok(/Read the board again in a few seconds, then redraw what is still missing\.$/.test(ans.recovery?.text ?? ''), 'INVARIANT: C: the line asks for a second read before a redraw, since the canvas, not the room, lacks the put-back');
    ok(took < 35000, `C: the wait for the canvas ends with the recovery's time (${took} ms)`);
    eq((await getJson<CanvasStatus>(port, '/canvas-status')).roomShapes, 1, 'C: the room holds the put-back');
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// ── Board Q: a canvas no reload repairs, without a server-owned page to hand to the launcher. ────────
// The line says the board could not be repaired, and why, at each count of reloads the recovery can
// begin: none, when its time runs out first (n 0); one, when its time runs out after the first (n 1); and
// two (n 2). Its sync-health reports the store corrupted after every reload. For n 0 the request for the
// asset is never answered and the ws timeout is longer than the recovery's 30 s, so that request takes the
// recovery's time; for n 1 it is answered so the first reload begins with about 950 ms of it left.
// With `early`, the server's timers wake 5 ms early (sync-corruption.preload-early-timers.mjs).
async function boardQ(n: '0' | '1' | '2', { early = false } = {}) {
  const board = early ? Q0E : { 0: Q0, 1: Q1, 2: Q2 }[n];
  const earlyTimers = early ? { NODE_OPTIONS: `--import=${new URL('./sync-corruption.preload-early-timers.mjs', import.meta.url).href}` } : {};
  const srv = boot(board, n === '2' ? {} : { WHITEBOARD_WS_TIMEOUT_MS: '40000', ...earlyTimers });
  const port = await srv._port;
  const fake = new FakeCanvas(port, board, { corruptAfterReload: true, ...(n === '0' ? { assetFetch: 'silent' } : n === '1' ? { assetAnswerAt: 29050 } : {}) });
  try {
    await fake.connect();
    console.log(`\n[Q${n}${early ? ' with timers that wake early' : ''} a canvas no reload repairs] port=${port}`);
    const fresh = { ...assetRecord('asset:q_new'), props: { ...assetRecord('asset:q_new').props, src: PIXEL2 } };
    const ans = await post(port, '/exec', { code: `editor.store.markAsPossiblyCorrupted(); editor.store.put([${JSON.stringify(fresh)}]); ${validCode('shape:q_box', 0)}` });
    const why = n === '0' ? "the recovery's time ran out before a reload could begin" : `tried ${n} time${n === '1' ? '' : 's'}`;
    const want = `Manual recovery needed: the board could not be repaired after a corrupted canvas store (${why}). The canvas may be frozen. Reload it, or restart the whiteboard.`;
    ok(ans.recovery?.recovered === false && ans.recovery?.text === want, `INVARIANT: Q${n}: the line says the board could not be repaired, and why (${JSON.stringify(ans.recovery?.text)})`);
    ok(fake.reloads === Number(n), `Q${n}: the recovery began ${n} reload(s) (${fake.reloads})`);
    ok(((await panelLines(port)) as readonly unknown[]).includes(ans.recovery?.text), `Q${n}: the panel shows the same line`);
  } finally {
    fake.close();
    srv.kill('SIGTERM');
    await sleep(300);
  }
}

// --- the real render-canvas (Board R) ------------------------------------------------------------
// Every Chromium process here descends from the server this file booted; nothing else is signalled.
interface ProcessRow { pid: number; ppid: number; cmd: string }
function processTable(): ProcessRow[] {
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command=']).toString().split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const m = l.match(/^(\d+)\s+(\d+)\s+(.*)$/); return m ? { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3]! } : null; })
    .filter((p): p is ProcessRow => Boolean(p));
}
function chromiumUnder(rootPid: number | undefined): number[] {
  const t = processTable();
  const mine = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const p of t) if (mine.has(p.ppid) && !mine.has(p.pid)) { mine.add(p.pid); grew = true; }
  }
  return t.filter((p) => p.pid !== rootPid && mine.has(p.pid) && /chrom/i.test(p.cmd)).map((p) => p.pid);
}
async function stopCanvasServer(server: BootedServer): Promise<void> {
  const seen = new Set(chromiumUnder(server.pid));
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  await waitFor(() => server.exitCode !== null || server.signalCode !== null, 8000);
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await sleep(300);
  const still = new Set(processTable().filter((p) => /chrom/i.test(p.cmd)).map((p) => p.pid));
  for (const pid of seen) if (still.has(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

// How long after an answer the room is read: a write the render-canvas pushes after its answer has
// reached the room well inside it (one measured at 1 s behind the answer of the recovery that sent it).
const SETTLE_MS = 2500;

async function boardR() {
  const srv = boot(R, { WHITEBOARD_NO_CANVAS: '' });
  let peer: Peer | undefined;
  try {
    const port = await srv._port;
    console.log(`\n[R the real render-canvas] port=${port}`);
    const canvasUp = async () => { const st = await getJson<CanvasStatus>(port, '/canvas-status'); return st.browserUp === true && st.connected === true && !st.relaunching; };
    ok(await waitFor(canvasUp, 60000, 200), 'R: the render-canvas is up');
    const lead = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-lead', name: 'Claude' })).sessionId;
    const worker = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-worker', name: 'Claude-2' })).sessionId;
    let k = 0;
    const exec = (sessionId: string, code: string) => post(port, '/exec', { code, sessionId, idempotencyKey: `wbsync-r-${k++}` });
    const box = (id: string, x: number, y = 0) => `{ id: '${id}', type: 'geo', x: ${x}, y: ${y}, props: { geo: 'rectangle', w: 120, h: 80 } }`;
    peer = await syncPeer(port, R);

    // Shapes of three authors: the lead's (last edited by a worker), a worker's, and the operator's.
    await exec(lead, `editor.createShapes([${box('shape:r_lead', 0)}]); return 1`);
    await exec(worker, `editor.createShapes([${box('shape:r_worker', 200)}]); editor.updateShapes([{ id: 'shape:r_lead', type: 'geo', y: 50 }]); return 1`);
    peer.put(geoRecord('shape:r_op', 400));
    ok(await waitFor(async () => (await exec(lead, "return !!editor.getShape('shape:r_op')")).result === true, 5000), "R: the operator's shape reaches the render-canvas");
    eq(peer.get('shape:r_lead')?.meta?.lastEditedBy?.name, 'Claude-2', "R: the lead's shape was last edited by the worker");

    // A throw inside editor.run on a board where nothing is cut off: reported healthy, every shape as it was.
    const healthyThrow = async (label: string, code: string) => {
      await sleep(300);
      const before = peer!.shapes();
      const panelBefore = (await panelLines(port)).length;
      const logBefore = srv._log.length;
      const ans = await exec(lead, code);
      ok(ans.ok === false && /may have drawn/.test(ans.error ?? ''), `R ${label}: answers ok:false and says the blob may have drawn`);
      ok(!ans.recovery || ans.recovery.recovered === true, `R ${label}: a recovery the throw set off, if any, answers recovered (${JSON.stringify(ans.recovery)})`);
      await sleep(SETTLE_MS);
      const lines = (await panelLines(port)).slice(panelBefore);
      ok(!lines.some((t) => FAILED.test(t)) && !/NOT recovered/.test(srv._log.slice(logBefore)), `INVARIANT: R ${label} on a healthy board is reported healthy (${JSON.stringify(lines)})`);
      ok(isDeepStrictEqual(peer!.shapes(), before), `INVARIANT: R ${label} leaves every shape in the room as it was, author stamps included`);
    };
    await healthyThrow('a bare throw inside editor.run', "editor.run(() => { throw new Error('bare') }); return 1");
    await healthyThrow("the create guard's refusal inside editor.run", `editor.run(() => { editor.createShapes([${box('shape:r_worker', 900)}]) }); return 1`);
    const plain = await exec(lead, "throw new Error('plain')");
    ok(plain.ok === false && !('recovery' in plain), `R: a blob's own error that leaves the store clean answers ok:false, and no recovery ran, so the answer carries none (${JSON.stringify(plain)})`);
    const next = await exec(lead, `editor.createShapes([${box('shape:r_next', 0, 300)}]); return editor.store.isPossiblyCorrupted()`);
    ok(next.ok === true && next.result === false, 'R: the next write lands on a clean store');

    // A write a corrupted store cut off, while the operator moves a shape during recovery's reload.
    await sleep(300);
    const before = peer.shapes();
    const logBefore = srv._log.length;
    let reloadAt = 0;
    const watch = waitFor(() => srv._log.slice(logBefore).includes('render-canvas disconnected'), 10000, 5).then((seen) => {
      if (!seen) return;
      reloadAt = Date.now();
      peer!.move('shape:r_op', 2500);
    });
    const cut = await exec(lead, `editor.store.markAsPossiblyCorrupted(); editor.createShapes([${box('shape:r_cut', 600, 300)}]); return 1`);
    await watch;
    await sleep(SETTLE_MS);
    ok(cut.ok === false, 'R: the write the corrupted store cut off answers ok:false');
    ok(reloadAt > 0, 'R: recovery reloaded the canvas, and the operator moved a shape during it');
    eq(peer.get('shape:r_op')?.x, 2500, "INVARIANT: the operator's move made during recovery's reload stays");
    const cutRec = peer.get('shape:r_cut');
    ok(!!cutRec, 'R: the cut-off write reaches the room');
    ok(cutRec?.meta?.createdBy?.name === 'Claude' && cutRec?.meta?.lastEditedBy?.name === 'Claude' && cutRec.meta.lastEditedBy.at < reloadAt,
      `INVARIANT: the cut-off shape keeps the stamps it was drawn with, not recovery's (lastEditedBy.at ${cutRec?.meta?.lastEditedBy?.at} < reload ${reloadAt})`);
    const others = Object.fromEntries(Object.entries(peer.shapes()).filter(([id]) => id !== 'shape:r_op' && id !== 'shape:r_cut'));
    const othersBefore = Object.fromEntries(Object.entries(before).filter(([id]) => id !== 'shape:r_op'));
    ok(isDeepStrictEqual(others, othersBefore), "INVARIANT: recovery restamps no other shape (the worker's and the lead's keep their stamps)");
    ok(!/NOT recovered/.test(srv._log.slice(logBefore)), 'R: that recovery reports recovered');

    // An editor.undo() at the top of the next blob reverts nothing of the recovery.
    await sleep(300);
    const afterRecovery = peer.shapes();
    await exec(worker, 'editor.undo(); return 1');
    await sleep(SETTLE_MS);
    ok(isDeepStrictEqual(peer.shapes(), afterRecovery), 'INVARIANT: an undo at the top of the next blob reverts nothing of the recovery');

    // A delete a corrupted store cut off reaches the room, and the report says so.
    await sleep(300);
    const logDel = srv._log.length;
    const del = await exec(lead, "editor.store.markAsPossiblyCorrupted(); editor.deleteShapes(['shape:r_next']); return 1");
    await sleep(SETTLE_MS);
    ok(del.ok === false, 'R: the delete the corrupted store cut off answers ok:false');
    ok(!peer.get('shape:r_next') && (await exec(lead, "return !!editor.getShape('shape:r_next')")).result === false, 'INVARIANT: the cut-off delete reaches the room, and the shape does not come back on the canvas');
    ok(!/NOT recovered/.test(srv._log.slice(logDel)), 'R: that recovery reports recovered');

    // A create and a throw in one editor.run. tldraw resolves the batch either way: the create is rolled
    // back, or it stays in the canvas's corrupted store, cut off from the room. Either way the canvas and
    // the room end agreeing, and the report says the board recovered. Here, on a board with shapes and a
    // history, it has been rolled back in every measured run; Board R6 is the case where it stays.
    const outcomes: string[] = [];
    for (let trial = 0; trial < 2; trial++) {
      await sleep(300);
      const id = `shape:r_both_${trial}`;
      const shape = trial % 2 === 0 ? `{ id: '${id}', type: 'geo', x: ${800 + trial * 150}, y: 300 }` : box(id, 800 + trial * 150, 300);
      const panelBefore = (await panelLines(port)).length;
      const logAt = srv._log.length;
      const both = await exec(lead, `editor.run(() => { editor.createShapes([${shape}]); throw new Error('in run') }); return 1`);
      await sleep(SETTLE_MS);
      const onCanvas = (await exec(lead, `return !!editor.getShape('${id}')`)).result === true;
      const inRoom = !!peer.get(id);
      const lines = (await panelLines(port)).slice(panelBefore);
      outcomes.push(onCanvas ? 'kept' : 'rolled back');
      ok(both.ok === false, `R trial ${trial}: a create and a throw in one editor.run answers ok:false`);
      ok(onCanvas === inRoom, `INVARIANT: R trial ${trial}: the canvas and the room agree on that create (canvas ${onCanvas}, room ${inRoom})`);
      ok(lines.some((t) => RECOVERED.test(t)) && !lines.some((t) => FAILED.test(t)) && !/NOT recovered/.test(srv._log.slice(logAt)), `INVARIANT: R trial ${trial}: the report says the board recovered (${JSON.stringify(lines)})`);
    }
    console.log(`  [R] the create was ${outcomes.join(', ')}`);
  } finally {
    peer?.close();
    await stopCanvasServer(srv);
  }
}

// ── Board R6: a create and a throw in one editor.run, as the first exec on a fresh board. In every
// measured run tldraw kept the create in the corrupted store, cut off from the room (round 11's case).
async function boardR6() {
  const srv = boot(R6, { WHITEBOARD_NO_CANVAS: '' });
  try {
    const port = await srv._port;
    console.log(`\n[R6 a create and a throw in one editor.run, first on a fresh board] port=${port}`);
    const canvasUp = async () => { const st = await getJson<CanvasStatus>(port, '/canvas-status'); return st.browserUp === true && st.connected === true && !st.relaunching; };
    ok(await waitFor(canvasUp, 60000, 200), 'R6: the render-canvas is up');
    const both = await post(port, '/exec', { code: "editor.run(() => { editor.createShapes([{ id: 'shape:r6', type: 'geo', x: 600, y: 0 }]); throw new Error('in run') })" });
    await sleep(SETTLE_MS);
    const onCanvas = (await post(port, '/exec', { code: "return !!editor.getShape('shape:r6')" })).result === true;
    const inRoom = (await getJson<CanvasStatus>(port, '/canvas-status')).roomShapes === 1;
    const lines = await panelLines(port);
    console.log(`  [R6] the create was ${onCanvas ? 'kept' : 'rolled back'}`);
    ok(both.ok === false, 'R6: a create and a throw in one editor.run answers ok:false');
    ok(onCanvas === inRoom, `INVARIANT: R6: the canvas and the room agree on that create (canvas ${onCanvas}, room ${inRoom})`);
    ok(lines.some((t) => RECOVERED.test(t)) && !lines.some((t) => FAILED.test(t)) && !/NOT recovered/.test(srv._log), `INVARIANT: R6: the report says the board recovered (${JSON.stringify(lines)})`);
  } finally {
    await stopCanvasServer(srv);
  }
}

// ── Board B: recovery puts back every document record a cut-off blob wrote, on every page: an arrow's
// bindings, a create on another page, and a shape moved to another page, which it never deletes.
async function boardB() {
  const srv = boot(B, { WHITEBOARD_NO_CANVAS: '' });
  let peer: Peer | undefined;
  try {
    const port = await srv._port;
    console.log(`\n[B every record, every page, on the real render-canvas] port=${port}`);
    const canvasUp = async () => { const st = await getJson<CanvasStatus>(port, '/canvas-status'); return st.browserUp === true && st.connected === true && !st.relaunching; };
    ok(await waitFor(canvasUp, 60000, 200), 'B: the render-canvas is up');
    const lead = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-b-lead', name: 'Claude' })).sessionId;
    let k = 0;
    const exec = (code: string) => post(port, '/exec', { code, sessionId: lead, idempotencyKey: `wbsync-b-${k++}` });
    const box = (id: string, x: number, y = 0) => `{ id: '${id}', type: 'geo', x: ${x}, y: ${y}, props: { geo: 'rectangle', w: 120, h: 80 } }`;
    peer = await syncPeer(port, B);
    // The clock recovery keeps a peer's newer edit by is the canvas's sync client's (#67). tldraw sets
    // window.tlsync to that client; an upgrade that stops doing so fails here, not in a peer's edit.
    eq((await exec('return typeof window.tlsync?.lastServerClock')).result, 'number', 'INVARIANT: the render-canvas exposes its sync client as window.tlsync, with a numeric lastServerClock');
    const recoveredLine = async (before: number) => (await panelLines(port)).slice(before).find((t) => RECOVERED.test(t)) ?? null;

    // A cut-off arrow and the two bindings that tie it to its boxes.
    let before = (await panelLines(port)).length;
    const bind = (to: string, terminal: string) => `editor.createBinding({ type: 'arrow', fromId: 'shape:b_arrow', toId: '${to}', props: { terminal: '${terminal}', normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false, snap: 'none' } });`;
    const arrow = await exec(`editor.store.markAsPossiblyCorrupted(); editor.createShapes([${box('shape:b_from', 0)}, ${box('shape:b_to', 400)}, { id: 'shape:b_arrow', type: 'arrow' }]); ${bind('shape:b_from', 'start')} ${bind('shape:b_to', 'end')} return 1`);
    await sleep(SETTLE_MS);
    ok(arrow.ok === false, 'B: the bound arrow the corrupted store cut off answers ok:false');
    eq(peer.bindings().filter((b) => b.fromId === 'shape:b_arrow').map((b) => b.toId).sort(), ['shape:b_from', 'shape:b_to'], 'INVARIANT: the cut-off arrow reaches the room with both its bindings');
    let line = await recoveredLine(before);
    ok(!!line && /\b2 bindings\b/.test(line), `B: the report says recovered and counts the bindings (${line})`);
    ok(arrow.recovery?.recovered === true && arrow.recovery.text === line, `INVARIANT: B: the /exec answer carries the recovery's outcome, the line the panel shows (${JSON.stringify(arrow.recovery)})`);

    // A cut-off write that creates on another page as well as on the current one.
    await exec("editor.createPage({ id: 'page:b_other', name: 'Other' }); return 1");
    ok(await waitFor(() => !!peer!.get('page:b_other'), 5000), 'B: a second page reaches the room');
    before = (await panelLines(port)).length;
    const off = await exec(`editor.store.markAsPossiblyCorrupted(); editor.createShapes([{ id: 'shape:b_off', type: 'geo', parentId: 'page:b_other', x: 0, y: 0, props: { geo: 'rectangle', w: 120, h: 80 } }, ${box('shape:b_on', 0, 300)}]); return editor.getCurrentPageId()`);
    await sleep(SETTLE_MS);
    ok(off.ok === false && off.result === 'page:page', `B: the write that creates on both pages, the current one being the first, answers ok:false (${JSON.stringify(off.result)})`);
    ok(!!peer.get('shape:b_on'), 'B: the cut-off create on the current page reaches the room');
    eq(peer.get('shape:b_off')?.parentId, 'page:b_other', 'INVARIANT: the cut-off create on another page reaches the room');
    ok(!!(await recoveredLine(before)), 'B: that recovery reports recovered');

    // A cut-off move to another page, followed by a return to the first page.
    await exec(`editor.createShapes([${box('shape:b_mover', 0, 600)}]); return 1`);
    ok(await waitFor(() => peer!.get('shape:b_mover')?.parentId === 'page:page', 5000), 'B: the shape to move reaches the room');
    before = (await panelLines(port)).length;
    const mv = await exec("editor.store.markAsPossiblyCorrupted(); editor.moveShapesToPage(['shape:b_mover'], 'page:b_other'); editor.setCurrentPage('page:page'); return 1");
    await sleep(SETTLE_MS);
    ok(mv.ok === false, 'B: the move the corrupted store cut off answers ok:false');
    eq(peer.get('shape:b_mover')?.parentId, 'page:b_other', 'INVARIANT: the shape the cut-off write moved to another page is in the room on that page, not deleted');
    line = await recoveredLine(before);
    ok(!!line && !/deletion/.test(line), `B: the report says recovered and names no deletion (${line})`);
  } finally {
    peer?.close();
    await stopCanvasServer(srv);
  }
}

// ── Board L: a board holding more image data than one websocket message to the bridge may carry
// (100 MiB) recovers a cut-off write, and the write's own asset changes reach the room whole. ─────────
async function boardL() {
  const srv = boot(L, { WHITEBOARD_NO_CANVAS: '' });
  try {
    const port = await srv._port;
    console.log(`\n[L a board with 108 MiB of images, on the real render-canvas] port=${port}`);
    const canvasUp = async () => { const st = await getJson<CanvasStatus>(port, '/canvas-status'); return st.browserUp === true && st.connected === true && !st.relaunching; };
    ok(await waitFor(canvasUp, 60000, 200), 'L: the render-canvas is up');
    const lead = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-l-lead', name: 'Claude' })).sessionId;
    let k = 0;
    const exec = (code: string) => post(port, '/exec', { code, sessionId: lead, idempotencyKey: `wbsync-l-${k++}` });
    // Twelve inline images of 9 MiB each, made on the canvas so the test sends none of their data.
    const BIG = 9 * 1024 * 1024;
    const made: boolean[] = [];
    for (let a = 0; a < 12; a++) {
      made.push((await exec(`const src = 'data:image/png;base64,' + 'A'.repeat(${BIG}); editor.createAssets([{ id: 'asset:l_big${a}', typeName: 'asset', type: 'image', props: { name: 'big${a}.png', src, w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} }]); return 1`)).ok);
    }
    eq(made, Array(12).fill(true), 'L: the twelve 9 MiB images reach the room');
    // A cut-off write: a box, a new image with its own small asset, and a rename of one big image.
    const smallSrc = `data:image/png;base64,${'B'.repeat(4096)}`;
    const small = { id: 'asset:l_new', typeName: 'asset', type: 'image', props: { name: 'new.png', src: smallSrc, w: 10, h: 10, mimeType: 'image/png', isAnimated: false }, meta: {} };
    const before = (await panelLines(port)).length;
    const sent = Date.now();
    const cut = await exec(`editor.store.markAsPossiblyCorrupted(); editor.createAssets([${JSON.stringify(small)}]); editor.createShapes([{ id: 'shape:l_img', type: 'image', x: 0, y: 0, props: { assetId: 'asset:l_new', w: 10, h: 10 } }, { id: 'shape:l_cut', type: 'geo', x: 300, y: 0, props: { geo: 'rectangle', w: 120, h: 80 } }]); const big = editor.getAsset('asset:l_big0'); editor.updateAssets([{ ...big, props: { ...big.props, name: 'renamed.png' } }]); return 1`);
    const took = Date.now() - sent;
    await sleep(SETTLE_MS);
    ok(cut.ok === false, 'L: the write the corrupted store cut off answers ok:false');
    const line = (await panelLines(port)).slice(before).find((t) => RECOVERED.test(t) || FAILED.test(t)) ?? null;
    ok(cut.recovery?.recovered === true && cut.recovery.text === line, `INVARIANT: L: a board with 108 MiB of images recovers, and the answer says so (${JSON.stringify(cut.recovery ?? line)}, answered in ${took} ms)`);
    // The canvas was reloaded from the room before the put-back, and the put-back reached it as a peer's change does.
    const after = await exec(`const a = editor.getAsset('asset:l_new'); const b = editor.getAsset('asset:l_big0'); return { cut: !!editor.getShape('shape:l_cut'), img: editor.getShape('shape:l_img')?.props.assetId ?? null, src: a?.props.src === ${JSON.stringify(smallSrc)}, name: b?.props.name ?? null, big: b?.props.src?.length ?? 0, assets: editor.getAssets().length }`);
    eq(after.result, { cut: true, img: 'asset:l_new', src: true, name: 'renamed.png', big: 22 + BIG, assets: 13 },
      'INVARIANT: L: the room holds the cut-off box, the new image and its asset whole, and the renamed image with its data');
  } finally {
    await stopCanvasServer(srv);
  }
}

// ── Board A: a duplicate or a paste belongs to whoever made it; a restore keeps its stamps (SPEC §8.6).
async function boardA() {
  let srv = boot(A, { WHITEBOARD_NO_CANVAS: '' });
  let peer: Peer | undefined;
  let browser: Browser | undefined;
  try {
    let port = await srv._port;
    console.log(`\n[A who owns a copy, on the real render-canvas] port=${port}`);
    const canvasUp = async () => { const st = await getJson<CanvasStatus>(port, '/canvas-status'); return st.browserUp === true && st.connected === true && !st.relaunching; };
    ok(await waitFor(canvasUp, 60000, 200), 'A: the render-canvas is up');
    let lead = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-a-lead', name: 'Claude' })).sessionId;
    const worker = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-a-worker', name: 'Claude-2' })).sessionId;
    let k = 0;
    const exec = <R = unknown>(sessionId: string, code: string) => post<ExecAnswer<R>>(port, '/exec', { code, sessionId, idempotencyKey: `wbsync-a-${k++}` });
    // The ids a blob's writes added to the page, which a duplicate and a paste choose themselves.
    const newIds = (write: string) => `const before = new Set(editor.getCurrentPageShapeIds()); ${write}; return [...editor.getCurrentPageShapeIds()].filter((id) => !before.has(id))`;
    peer = await syncPeer(port, A);

    // The operator's shape, stamped as the operator's tab stamps it, and one the lead drew.
    const opStamp = { kind: 'human', name: 'Operator', sessionId: 'op-key', at: Date.now() - 60000 };
    peer.put({ ...geoRecord('shape:a_op', 0), meta: { createdBy: opStamp, lastEditedBy: opStamp } });
    await exec(lead, "editor.createShapes([{ id: 'shape:a_lead', type: 'geo', x: 300, y: 0, props: { geo: 'rectangle', w: 120, h: 80 } }]); return 1");
    ok(await waitFor(async () => (await exec(lead, "return !!editor.getShape('shape:a_op')")).result === true && !!peer!.get('shape:a_lead'), 5000),
      "A: the operator's shape reaches the render-canvas and the lead's the room");
    const opMeta: unknown = JSON.parse(JSON.stringify(peer.get('shape:a_op')!.meta));
    const leadMeta: unknown = JSON.parse(JSON.stringify(peer.get('shape:a_lead')!.meta));

    // (a) A duplicate, made by a blob under the agent's identity.
    const dupOp = await exec<string[]>(lead, newIds("editor.duplicateShapes(['shape:a_op'], { x: 0, y: 200 })"));
    const dupLead = await exec<string[]>(worker, newIds("editor.duplicateShapes(['shape:a_lead'], { x: 0, y: 200 })"));
    ok(dupOp.ok && dupOp.result?.length === 1 && dupLead.ok && dupLead.result?.length === 1, `A: each duplicate adds one shape (${JSON.stringify([dupOp, dupLead])})`);
    const [dOp] = dupOp.result ?? [];
    const [dLead] = dupLead.result ?? [];
    ok(await waitFor(() => !!peer!.get(dOp) && !!peer!.get(dLead), 5000), 'A: both duplicates reach the room');
    const by = (id: string | undefined, field: 'createdBy' | 'lastEditedBy') => peer!.get(id)?.meta?.[field];
    ok(by(dOp, 'createdBy')?.name === 'Claude' && by(dOp, 'createdBy')?.kind === 'agent' && by(dOp, 'lastEditedBy')?.name === 'Claude',
      `INVARIANT: the lead's duplicate of the operator's shape is the lead's (${JSON.stringify(peer.get(dOp)?.meta)})`);
    ok(by(dLead, 'createdBy')?.name === 'Claude-2' && by(dLead, 'lastEditedBy')?.name === 'Claude-2',
      `INVARIANT: the worker's duplicate of the lead's shape is the worker's (${JSON.stringify(peer.get(dLead)?.meta)})`);
    eq(peer.get('shape:a_op')?.meta, opMeta, "A: the operator's original keeps the operator's stamps");
    eq(peer.get('shape:a_lead')?.meta, leadMeta, "A: the lead's original keeps the lead's stamps");

    // A redo of the worker's duplicate, by the lead: the copy it recreates is still the worker's.
    const dupMeta: unknown = JSON.parse(JSON.stringify(peer.get(dLead)?.meta ?? null));
    const redo = await exec(lead, `editor.undo(); const gone = !editor.getShape('${dLead}'); editor.redo(); return gone && !!editor.getShape('${dLead}')`);
    await sleep(SETTLE_MS);
    ok(redo.ok && redo.result === true, `A: the lead's undo removes the worker's duplicate and its redo brings it back (${JSON.stringify(redo)})`);
    eq(peer.get(dLead)?.meta, dupMeta, 'INVARIANT: the duplicate a redo recreates keeps the stamps of whoever made it');

    // (c) A paste: the clipboard's content (getContentFromCurrentPage, through JSON as the clipboard
    // carries it) handed to tldraw's own paste handler. The OS clipboard is out of a blob's reach.
    const paste = await exec<string[]>(worker, newIds("const content = JSON.parse(JSON.stringify(editor.getContentFromCurrentPage(['shape:a_op']))); await editor.putExternalContent({ type: 'tldraw', content, point: { x: 900, y: 600 } })"));
    const [pasted] = paste.result ?? [];
    ok(paste.ok && paste.result?.length === 1 && await waitFor(() => !!peer!.get(pasted), 5000), `A: the paste adds one shape to the room (${JSON.stringify(paste)})`);
    ok(by(pasted, 'createdBy')?.name === 'Claude-2' && by(pasted, 'lastEditedBy')?.name === 'Claude-2',
      `INVARIANT: the worker's paste of the operator's shape is the worker's (${JSON.stringify(peer.get(pasted)?.meta)})`);
    eq(peer.get('shape:a_op')?.meta, opMeta, "A: the operator's original keeps its stamps after the paste");

    // (b) A deleted shape an undo restores keeps its stamps.
    await exec(lead, "editor.deleteShapes(['shape:a_op']); return 1");
    ok(await waitFor(() => !peer!.get('shape:a_op'), 5000), "A: the lead's delete of the operator's shape reaches the room");
    const undo = await exec(lead, "editor.undo(); return !!editor.getShape('shape:a_op')");
    ok(undo.ok && undo.result === true && await waitFor(() => !!peer!.get('shape:a_op'), 5000), `A: an undo restores the operator's shape (${JSON.stringify(undo)})`);
    eq(peer.get('shape:a_op')?.meta, opMeta, "INVARIANT: the shape an undo restores keeps its own stamps, not the undoer's");

    // The same undo of a shape the render-canvas held when it loaded: the board restarted from its snapshot.
    peer.close();
    await stopCanvasServer(srv);
    srv = boot(A, { WHITEBOARD_NO_CANVAS: '' });
    port = await srv._port;
    ok(await waitFor(canvasUp, 60000, 200), 'A: the render-canvas is up again, on the saved board');
    lead = (await post<RegisterAnswer>(port, '/session/register', { clientKey: 'wbsync-a-lead', name: 'Claude' })).sessionId;
    peer = await syncPeer(port, A);
    eq(peer.get('shape:a_op')?.meta, opMeta, "A: the operator's shape comes back from the snapshot with its stamps");
    await exec(lead, "editor.deleteShapes(['shape:a_op']); return 1");
    ok(await waitFor(() => !peer!.get('shape:a_op'), 5000), "A: the lead's delete of the loaded shape reaches the room");
    const undoLoaded = await exec(lead, "editor.undo(); return !!editor.getShape('shape:a_op')");
    ok(undoLoaded.ok && undoLoaded.result === true && await waitFor(() => !!peer!.get('shape:a_op'), 5000), `A: an undo restores the loaded shape (${JSON.stringify(undoLoaded)})`);
    eq(peer.get('shape:a_op')?.meta, opMeta, 'INVARIANT: a shape present when the canvas loaded, restored by undo, keeps its own stamps');

    // The operator's own tab, driven by the keyboard: select all, duplicate, then copy and paste.
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
    const tab = await ctx.newPage();
    await tab.goto(`http://127.0.0.1:${port}/?room=${A}&author=Operator&authorKey=op-key`);
    const held = Object.keys(peer.shapes()).length;
    ok(await waitFor(async () => (await tab.locator('.tl-shape').count()) >= held, 30000, 200), "A: the operator's tab shows the board");
    const keyboardCopies = async (label: string, keys: string[]) => {
      const before = peer!.shapes();
      await tab.mouse.click(1300, 450);
      for (const key of keys) { await tab.keyboard.press(key); await sleep(300); } // a copy writes the clipboard asynchronously
      ok(await waitFor(() => Object.keys(peer!.shapes()).length === 2 * Object.keys(before).length, 5000), `A: the operator's ${label} copies every shape into the room`);
      const copies = Object.values(peer!.shapes()).filter((r) => !before[r.id]);
      ok(copies.length > 0 && copies.every((r) => r.meta?.createdBy?.name === 'Operator' && r.meta?.createdBy?.kind === 'human' && r.meta?.lastEditedBy?.name === 'Operator'),
        `INVARIANT: every copy the operator's ${label} makes, of the agents' shapes and the operator's, is the operator's (${JSON.stringify(copies.map((r) => r.meta?.createdBy?.name))})`);
      eq(Object.fromEntries(Object.entries(peer!.shapes()).filter(([id]) => before[id]).map(([id, r]) => [id, r.meta])),
        Object.fromEntries(Object.entries(before).map(([id, r]) => [id, r.meta])), `A: the operator's ${label} leaves every original's stamps as they were`);
    };
    await keyboardCopies('duplicate', ['ControlOrMeta+a', 'ControlOrMeta+d']);
    await keyboardCopies('copy and paste', ['ControlOrMeta+a', 'ControlOrMeta+c', 'ControlOrMeta+v']);

    // moveShapesToPage deletes a shape and creates it again under its own id on the other page: a restore.
    const moved = await exec(lead, "editor.createPage({ id: 'page:a_other', name: 'Other' }); editor.moveShapesToPage(['shape:a_op'], 'page:a_other'); const p = editor.getShape('shape:a_op')?.parentId; editor.setCurrentPage('page:page'); return p");
    ok(moved.ok && moved.result === 'page:a_other' && await waitFor(() => peer!.get('shape:a_op')?.parentId === 'page:a_other', 5000), `A: the lead moves the operator's shape to another page (${JSON.stringify(moved)})`);
    eq(peer.get('shape:a_op')?.meta, opMeta, 'INVARIANT: a shape moveShapesToPage recreates keeps its own stamps');
  } finally {
    await browser?.close().catch(() => {});
    peer?.close();
    await stopCanvasServer(srv);
  }
}

// ── Board US: a switch away from a board whose change cannot be saved is refused. ──────────────────
// The board's folder is read-only, so the room changes but cannot be flushed. Evicting it would lose
// the change, so the server keeps it, its peers and its lock, and refuses the switch; once the folder
// is writable again, closing saves the change.
async function boardUS() {
  const roDir = path.join(SB.root, 'read-only');
  fs.mkdirSync(roDir, { recursive: true });
  const boardPath = path.join(roDir, `${US}.tldr`);
  const target = `${US}_target`;
  const srv = boot(US, { WHITEBOARD_BOARD: boardPath });
  const port = await srv._port;
  const fake = new FakeCanvas(port, US);
  try {
    await fake.connect();
    console.log(`\n[US a switch away from an unsaveable board] port=${port}`);
    fs.chmodSync(roDir, 0o555);
    await post(port, '/exec', { code: validCode('shape:us_good', 0) });
    ok((await waitRoomShapes(port, 1, 4000)) >= 1, 'US: the change reached the room');
    const switched = await fetch(`http://127.0.0.1:${port}/board/open`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: path.join(HOME, `${target}.tldr`) }),
    });
    const refusal = (await switched.json().catch(() => ({}))) as { error?: string };
    ok(switched.status === 503 && /cannot be saved/.test(refusal.error ?? ''), `US: the switch is refused, saying why (${switched.status} ${refusal.error})`);
    const status = await getJson<CanvasStatus & { activeRoom?: string }>(port, '/canvas-status');
    ok(status.activeRoom === US, `US: the server still serves the board it could not save (${status.activeRoom})`);
    ok((status.roomShapes ?? 0) >= 1, 'US: and its room still holds the change');
    ok(fs.existsSync(path.join(HOME, `${US}.lock`)), 'US: its lock is kept');
    ok(!fs.existsSync(path.join(HOME, `${target}.lock`)), "US: the target board's lock was released");
    const msgs = (await getJson<MessagesAnswer>(port, '/messages')).messages ?? [];
    ok(msgs.some((m) => typeof m.text === 'string' && m.text.startsWith('The board cannot be saved')), 'US: the panel says the board cannot be saved');
  } finally {
    fs.chmodSync(roDir, 0o755);
    fake.close();
  }
  const exited = new Promise((resolve) => srv.once('exit', resolve));
  await post(port, '/done', {});
  await exited;
  ok(fs.existsSync(boardPath) && fs.readFileSync(boardPath, 'utf8').includes('shape:us_good'), 'US: once the folder is writable again, closing saves the change');
  fs.rmSync(roDir, { recursive: true, force: true });
  for (const ext of ['tldr', 'messages.jsonl', 'recipients.json', 'lock', 'png', 'port']) fs.rmSync(path.join(HOME, `${target}.${ext}`), { force: true });
}

function cleanupFiles() {
  for (const b of boards) for (const ext of ['tldr', 'messages.jsonl', 'recipients.json', 'lock', 'png', 'port']) {
    fs.rmSync(path.join(HOME, `${b}.${ext}`), { force: true });
  }
}

async function main() {
  cleanupFiles();

  // ── Board X: guard ON. Poison then well-formed; the well-formed shape reaches the room. ──────
  const srvX = boot(X);
  const portX = await srvX._port;
  const fakeX = new FakeCanvas(portX, X);
  await fakeX.connect();
  console.log(`\n[X guard ON] port=${portX}`);

  const baseX = await getJson<CanvasStatus>(portX, '/canvas-status');
  ok(baseX.roomShapes === 0, 'X: room starts with 0 shapes');

  const poisonX = await post(portX, '/exec', { code: poisonCode('shape:x_poison') });
  ok(poisonX.ok === false, 'X: the poison exec returns ok:false (not ok:true)');

  const wellX = await post(portX, '/exec', { code: validCode('shape:x_good', 200) });
  const reachedX = await waitRoomShapes(portX, 1, 5000);
  ok(reachedX >= 1, `X: the well-formed shape reached the room after recovery (roomShapes=${reachedX})`);
  console.log(`  [X] well-formed exec returned ok=${wellX.ok}`);

  const msgsX = await getJson<MessagesAnswer>(portX, '/messages');
  const announced = (msgsX.messages ?? []).some((m) => typeof m.text === 'string' && m.text.includes('Recovered the board'));
  ok(announced, 'X: recovery posted a visible panel line naming the recovery');
  ok(poisonX.recovery?.recovered === true && (msgsX.messages ?? []).some((m) => m.text === poisonX.recovery!.text),
    `INVARIANT: X: the poison's answer carries the recovery's outcome, the line the panel shows (${JSON.stringify(poisonX.recovery)})`);

  fakeX.close();
  srvX.kill('SIGTERM');
  await sleep(500);

  // ── Board Y: guard OFF (pre-v9.5). The SAME sequence freezes the board — this is the bite. ───
  const srvY = boot(Y, { WHITEBOARD_NO_SYNC_GUARD: '1' });
  const portY = await srvY._port;
  const fakeY = new FakeCanvas(portY, Y);
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
  const fakeZ = new FakeCanvas(portZ, Z);
  await fakeZ.connect();
  console.log(`\n[Z honest contract] port=${portZ}`);

  const silentZ = await post(portZ, '/exec', { code: silentPoisonCode });
  ok(silentZ.ok === false, 'Z: a silent corrupting exec (app-side ok:true) is reported ok:false by the server');
  ok(/^sync-severed\b/.test(silentZ.error ?? ''), `Z: the severed exec carries an error (${silentZ.error})`);

  fakeZ.close();
  srvZ.kill('SIGTERM');
  await sleep(300);

  await boardP();
  await boardU();
  await boardH();
  await boardD();
  await boardG();
  await boardM();
  await boardK();
  await boardN('silent');
  await boardN('norecords');
  await boardN('toolarge');
  await boardE();
  await boardT();
  await boardS();
  await boardV('peer');
  await boardV('canvas');
  await boardC();
  await boardQ('0');
  await boardQ('0', { early: true });
  await boardQ('1');
  await boardQ('2');
  await boardUS();
  // Boards R, R6, B, L and A run the real render-canvas: Playwright's Chromium and the built app.
  if (hasChromium() && hasAppBuild()) {
    await boardR();
    await boardR6();
    await boardB();
    await boardL();
    await boardA();
  } else {
    console.log('\n[SKIP] Boards R, R6, B, L and A: they need Playwright\'s Chromium and the built app (scripts/whiteboard.sh install)');
  }

  cleanupFiles();
  const left = fs.readdirSync(HOME).filter((f) => boards.some((b) => f.startsWith(`${b}.`)));
  eq(left, [], "the suite leaves none of its boards' files behind, recipients.json included");

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('\nERROR', e); process.exit(1); });

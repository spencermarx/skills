#!/usr/bin/env -S npx tsx
// Whiteboard v4 server (SPEC §3-§8). ONE Node process per board, 127.0.0.1 only, on an
// OS-assigned ephemeral port (PORT env overrides). Records its port in <name>.lock.
// TypeScript / ESM (NodeNext) / Node 22, run via tsx.
//
// Hosts, in one process:
//   1. tldraw SYNC server: a `TLSocketRoom` (@tldraw/sync-core) per board at WS
//      `/sync/:roomId`. Every peer (operator browser + headless render-canvas) joins.
//   2. BRIDGE (HTTP + WS `/events`): the control channel the Claude sessions drive
//      (exec / shapes / image / agent voice / discovery / sessions). `/events` is
//      role-routed: role=agent is the render-canvas (exec/shapes/export target);
//      role=human sockets receive agent-message for the operator's panel log.
//   3. Playwright headless Chromium running our app in role=agent, joined to the room.
//   4. N presence-only sync CLIENTS (see ./presence) that inject one named agent cursor
//      per registered session so HUMAN peers see each agent (server store-writes and the
//      render-canvas cannot — presence is per-session; verified against 5.4.2 types).
//
// Must import ./headless-shim before any @tldraw client code (presence clients need
// browser globals Node lacks).
import './headless-shim.js';

import express, { type Request, type Response } from 'express';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TLSocketRoom } from '@tldraw/sync-core';
import { chromium, type Browser, type Page } from 'playwright';
import { PresenceManager, type PresenceState } from './presence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
// [v4 §8.3] Bind to an OS-assigned ephemeral port (127.0.0.1:0) so each board's process
// gets its own port; an explicit PORT env override still wins. The actual port is read off
// the listening socket after `listen` and used everywhere via `assignedPort`.
const PORT_OVERRIDE = process.env.PORT ? Number(process.env.PORT) : null;
let assignedPort = PORT_OVERRIDE ?? 0;
const LONGPOLL_MS = 240_000;
// Env-overridable so the render-cap regression test can force a fast export timeout
// (the no-frame path that records lastExport* health) without a 15s wait; defaults to 15s.
//
// COUPLED INVARIANT: in production this MUST exceed the app's EXPORT_TIMEOUT_MS (12s, in
// App.tsx) so a hung `toImage` is reported by the app as ok:false FIRST — carrying the real
// error into lastExportError — before this bridge-side waiter times out into the generic
// "no frame from render-canvas". The two live in different files and only this one is
// settable, so the coupling is a comment, not a runtime assert: the render-cap test
// deliberately lowers this BELOW 12s to force the no-frame path (no app is running there, so
// there is no 12s client timeout to invert). Do not add a boot-time `> 12000` assert — it
// would break that test.
//
// Parse-and-clamp (was `Number(...) || 15_000`): a negative value used to be truthy and
// passed to setTimeout as ~0 → a permanent instant-timeout 503 outage; 0/NaN silently fell
// back with no signal. Now any non-positive/non-finite value is rejected with a warning.
function parseWsTimeoutMs(): number {
  const raw = process.env.WHITEBOARD_WS_TIMEOUT_MS;
  if (raw === undefined || raw === '') return 15_000;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  console.warn(`[config] ignoring invalid WHITEBOARD_WS_TIMEOUT_MS=${JSON.stringify(raw)}; using 15000ms`);
  return 15_000;
}
const WS_REQUEST_TIMEOUT_MS = parseWsTimeoutMs();
const PERSIST_INTERVAL_MS = 2_000;
// [v5.1 §8.5] Lease / visibility timeout: a Send delivered to a lead is "leased" to it; if that
// lead goes silent (no bridge call carrying its sessionId) past STALL_MS, the lease expires and
// the Send returns to pending for redelivery. Generous by default so a normal draw turn never
// trips it; SWEEP_MS is how often expired leases are reclaimed. Both env-overridable (tests use ms).
const STALL_MS = Number(process.env.WHITEBOARD_STALL_MS) || 120_000;
const SWEEP_MS = Number(process.env.WHITEBOARD_SWEEP_MS) || 10_000;
// [v9.3 §9 #55] Lead liveness grace window. The lead has NO timed lease (its receipt is clockless):
// redelivery is liveness-driven, not clock-driven. Liveness = an armed lead listener exists OR the
// receipt holder was seen within this grace window. This is a HEALTH-CHECK timeout on the liveness
// concern, honest and separate — it is NEVER a message state, and it never puts a lead Send in
// 'stalled'. It bridges the unavoidable wake→re-arm gap (poll.sh tears the listener down to wake the
// agent), so a live lead mid-turn is normally spared. A lead that goes quiet longer than the grace is
// declared dead — which in practice is EITHER a genuine crash OR a live-but-slow turn whose own tool
// calls run past LEAD_GRACE_MS with no bridge call in between (a live dogfood proved this happens; SPEC
// §9). The 120s default sits above observed turn length so that false positive is rare, but does NOT
// eliminate it: a turn longer than the window still trips a (correct-by-signal, wrong-in-fact) death-
// declaration, which re-queues and redraws the lead's in-flight Send (idempotent via /exec + deterministic
// shape ids, so safe, but visible). Deliberately unrelated to STALL_MS (a message must not time out; a
// health check may). Env-overridable (tests set it small), same convention as STALL_MS.
const LEAD_GRACE_MS = Number(process.env.WHITEBOARD_LEAD_GRACE_MS) || 120_000;
// [v6 §5] Revive-storm guard. When the supervisor long-poll hands the lead a "revive worker-N"
// directive, that worker enters a grace window during which the bridge does NOT re-issue a revive
// for it — long enough for the lead to spawn/resume it and for the revived worker to re-poll.
// Cleared the moment a waiter parks for that recipient (revival succeeded). Env-overridable (tests
// set it small), same convention as STALL_MS/SWEEP_MS.
const REVIVE_GRACE_MS = Number(process.env.WHITEBOARD_REVIVE_GRACE_MS) || 15_000;
// [v9.6] The CC session that booted this board, recorded in the lock so a SECOND
// /whiteboard session can tell it did not boot this board and must never tear it down.
const OWNER_SESSION = process.env.WHITEBOARD_OWNER_SESSION || null;       // human-readable CC session name
const OWNER_SESSION_ID = process.env.WHITEBOARD_OWNER_SESSION_ID || null; // stable CLAUDE_CODE_SESSION_ID
const APP_DIST = path.resolve(__dirname, '..', 'app', 'dist');

// --- repo root + scratchpad home (SPEC §8) ---------------------------------
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

// The boards' home follows the repository being worked on, never the skill's install folder (a
// plugin cache or ~/.agents/skills). The repository is WHITEBOARD_REPO, else the git root of the
// working directory; the home is WHITEBOARD_HOME, else the board file's own folder, else
// <repository>/.scratchpad/whiteboard. scripts/whiteboard.sh start sets all three.
const REPO_ROOT = process.env.WHITEBOARD_REPO ? path.resolve(process.env.WHITEBOARD_REPO) : findRepoRoot(process.cwd());
const HOME = process.env.WHITEBOARD_HOME
  ? path.resolve(process.env.WHITEBOARD_HOME)
  : process.env.WHITEBOARD_BOARD
    ? path.dirname(path.resolve(process.env.WHITEBOARD_BOARD))
    : path.join(REPO_ROOT, '.scratchpad', 'whiteboard');
fs.mkdirSync(HOME, { recursive: true });

const boardName = (p: string): string => path.basename(p, path.extname(p));
const imagePathFor = (p: string): string => path.join(HOME, `${boardName(p)}.png`);

let activeBoardPath = process.env.WHITEBOARD_BOARD
  ? path.resolve(process.env.WHITEBOARD_BOARD)
  : path.join(HOME, 'board.tldr');
let activeRoomId = boardName(activeBoardPath);
let latestImagePath = imagePathFor(activeBoardPath);

// [v9.8 §6.1 #61] Export health, surfaced in /canvas-status so the render-stall (a live render-canvas
// answering export-image with ok:false while the bridge serves a frozen PNG) is observable without
// byte-diffing the file. lastExportOk:false with a stale lastImageMtime is the stall's signature;
// null on every field means no export has been attempted yet. lastImageMtime/Bytes track the last
// successful (re)write in POST /image-upload, never a stat of a stale file.
let lastExportOk: boolean | null = null;
let lastExportError: string | null = null;
let lastExportAt: number | null = null;
let lastImageMtime: number | null = null;
let lastImageBytes: number | null = null;

const slugToPath = new Map<string, string>([[activeRoomId, activeBoardPath]]);

function pathForRoom(roomId: string): string {
  const known = slugToPath.get(roomId);
  if (known) return known;
  const p = path.join(HOME, `${roomId}.tldr`);
  slugToPath.set(roomId, p);
  return p;
}

console.log(`[bridge] repo root: ${REPO_ROOT}`);
console.log(`[bridge] scratchpad home: ${HOME}`);
console.log(`[bridge] active board: ${activeBoardPath} (room '${activeRoomId}')`);

// --- lockfile: discovery + one-server-per-board guard (SPEC §8.3) [v4] ------
// `<name>.lock` = { port, pid, board, startedAt, ownerSession?, ownerSessionId? } beside `<name>.tldr`. The next
// `/whiteboard` for this board reads it to find the running port and attach; it is removed
// on graceful `/done`/shutdown. Liveness is pid + `/canvas-status`, not the file's presence.
const lockPathFor = (roomId: string): string => path.join(HOME, `${roomId}.lock`);

function writeLock(): void {
  const lock = {
    port: assignedPort, pid: process.pid, board: activeRoomId, startedAt: Date.now(),
    ...(OWNER_SESSION ? { ownerSession: OWNER_SESSION } : {}),
    ...(OWNER_SESSION_ID ? { ownerSessionId: OWNER_SESSION_ID } : {}),
  };
  try {
    fs.writeFileSync(lockPathFor(activeRoomId), JSON.stringify(lock));
    console.log(`[bridge] wrote lock ${lockPathFor(activeRoomId)} (port ${assignedPort}, pid ${process.pid})`);
  } catch (e) {
    console.warn(`[bridge] lock write failed: ${(e as Error).message}`);
  }
}

function removeLock(roomId: string = activeRoomId): void {
  try {
    fs.rmSync(lockPathFor(roomId), { force: true });
  } catch (e) {
    console.warn(`[bridge] lock remove failed: ${(e as Error).message}`);
  }
}

// [v8 §8.3] Runtime one-server guard. The boot-time attach-vs-boot check (SPEC §9) lives
// in the skill; this is its runtime twin, used when the in-app switcher opens another board
// (`/board/open`). Without it, an in-process room switch steals the target board's lock with
// no owner check — a split-brain: two processes serve one board, and a parked waiter on one
// never meets a Send that lands on the other. These helpers answer "is a LIVE FOREIGN process
// already hosting this board?" so the switch can attach to it instead of stealing it.
type LockInfo = { port: number; pid: number; board: string; startedAt: number; ownerSession?: string; ownerSessionId?: string };

function readLock(roomId: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPathFor(roomId), 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.port === 'number' && typeof parsed.pid === 'number') return parsed as LockInfo;
  } catch {
    /* no lock, or unreadable — treated as no owner */
  }
  return null;
}

// process.kill(pid, 0) probes existence without signalling. ESRCH => gone; EPERM => alive but
// owned by another user (still alive). Liveness of the pid alone is NOT proof of a whiteboard
// server (a pid can be reused) — the /canvas-status probe below is the real confirmation.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Confirms a live whiteboard server on `port` is serving `roomId` (short-timeout, loopback-only
// GET /canvas-status; `activeRoom` is exposed there for exactly this). Resolves false on any
// failure (connection refused = dead/stale owner, wrong room, timeout, bad body) — never throws.
function probeCanvasStatus(port: number, roomId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/canvas-status', timeout: 1000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve((JSON.parse(raw) as { activeRoom?: string }).activeRoom === roomId);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// The target board's live foreign owner (its port), or null. null covers: no lock; a stale lock
// (dead pid, or a live pid whose port no longer answers as this board); or the lock is OURS
// (self — an in-process switch to our own board is safe and is not a foreign steal).
async function liveForeignOwner(roomId: string): Promise<{ port: number; pid: number } | null> {
  const lock = readLock(roomId);
  if (!lock) return null;
  if (lock.pid === process.pid) return null;
  if (!pidAlive(lock.pid)) return null;
  const live = await probeCanvasStatus(lock.port, roomId);
  return live ? { port: lock.port, pid: lock.pid } : null;
}

// ===========================================================================
// SYNC SERVER — one TLSocketRoom per board (SPEC §3, §8)
// ===========================================================================
type RoomEntry = { room: TLSocketRoom; boardPath: string; dirty: boolean; saving: boolean };
const rooms = new Map<string, RoomEntry>();

function getOrCreateRoom(roomId: string): RoomEntry {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const boardPath = pathForRoom(roomId);
  let initialSnapshot: unknown;
  if (fs.existsSync(boardPath)) {
    try {
      initialSnapshot = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    } catch (e) {
      console.warn(`[sync] failed to read ${boardPath}: ${(e as Error).message} — starting empty`);
    }
  }

  const entry: RoomEntry = { room: null as unknown as TLSocketRoom, boardPath, dirty: false, saving: false };
  entry.room = new TLSocketRoom({
    // schema omitted -> defaults to createTLSchema() (default tldraw shapes).
    ...(initialSnapshot ? { initialSnapshot: initialSnapshot as never } : {}),
    onDataChange: () => {
      entry.dirty = true;
    },
    onSessionRemoved: (_room: unknown, args: { numSessionsRemaining: number }) => {
      console.log(`[sync] room '${roomId}': session left, ${args.numSessionsRemaining} remaining`);
    },
  });

  rooms.set(roomId, entry);
  console.log(`[sync] room '${roomId}' ready (loaded=${!!initialSnapshot}) -> ${boardPath}`);
  return entry;
}

async function persistRoom(roomId: string, entry: RoomEntry): Promise<void> {
  if (entry.saving) return;
  entry.saving = true;
  try {
    const snapshot = entry.room.getCurrentSnapshot();
    await fsp.writeFile(entry.boardPath, JSON.stringify(snapshot));
    console.log(`[sync] persisted room '${roomId}' -> ${entry.boardPath}`);
  } catch (e) {
    console.warn(`[sync] persist failed for '${roomId}': ${(e as Error).message}`);
  } finally {
    entry.saving = false;
  }
}

function persistRoomSync(roomId: string, entry: RoomEntry): void {
  try {
    fs.writeFileSync(entry.boardPath, JSON.stringify(entry.room.getCurrentSnapshot()));
    console.log(`[sync] flushed room '${roomId}' -> ${entry.boardPath}`);
  } catch (e) {
    console.warn(`[sync] flush failed for '${roomId}': ${(e as Error).message}`);
  }
}

setInterval(() => {
  for (const [roomId, entry] of rooms) {
    if (entry.dirty) {
      entry.dirty = false;
      void persistRoom(roomId, entry);
    }
  }
}, PERSIST_INTERVAL_MS);

// ===========================================================================
// MESSAGE STORE — seam-capture, per-room, JSONL sidecar (SPEC §8.2, model C) [v4]
// ===========================================================================
// The panel's chat log is durable and attributed. Both flows cross the bridge firsthand
// (operator Send via /message, agent utterance via /agent-message); each is stored on
// receipt into an in-memory per-room array and appended to a human-readable JSONL sidecar
// `<name>.messages.jsonl` beside the board's `.tldr`, reloaded into memory on boot. The
// message `id` == the message's idempotencyKey; a repeat id neither re-stores nor re-emits.
type MessageAuthor = { kind: 'human' | 'agent'; name: string; sessionId?: string; color?: string };

// [v6 §1/§2] Where a human Send is addressed. `id` is the stable RECIPIENT ID (SEAM §1): the
// reserved 'lead', or a worker's `clientKey` (stable across the worker's death/revival, unlike its
// sessionId). A broadcast omits `id` and routes to every currently-registered worker. `name` is a
// display label only. Absent recipient == the lead (the v5 default).
type Recipient = { kind: 'lead' | 'worker' | 'broadcast'; id?: string; name?: string };

// [v7 #43] The id of an actual agent: the literal 'lead', or a worker's stable clientKey.
// NOT 'everyone' (a broadcast keyword). A v7 typed constraint, validated at the seam
// (a lightweight named alias, deliberately NOT a branded rebrand of every Map<string,…>;
// the constraint is enforced at runtime by isAgentId at the three seams — see #43).
type AgentId = string;

// [v6 §2/§8.5] Per-recipient delivery/lease/completion, used ONLY on a broadcast Message. Each
// worker leases and completes its own entry independently; the top-level fields become the AGGREGATE
// (completedAt set only once every broadcastTo entry has completed).
// [v9.7 §8.5 #60] receivedAt: the LEAD's consumer-side acknowledgment — set by POST
// /instruction-received when the lead's poller has actually taken the bytes off the socket (before
// poll.sh exits on a 200). It separates "handed to the transport" (deliveredAt, producer-side) from
// "confirmed received by the consumer" (receivedAt), so a delivery lost to a half-open socket is
// distinguishable from a consumed one. Lead-only: workers keep the STALL_MS lease clock (§8.5).
type DeliveryEntry = { deliveredAt?: number; receivedAt?: number; completedAt?: number; deliveredBy?: string };

type Message = {
  id: string;
  room: string;
  ts: number;
  author: MessageAuthor;
  text: string;
  selection?: string[];
  // [v6 §2] Present on human Sends only. Absent => addressed to the lead (the v5 default).
  recipient?: Recipient;
  // [v6 §2] Broadcast only: snapshot of the worker recipient ids this Send fans to, taken at send
  // time. Empty (no workers were registered) => the broadcast is vacuously done.
  broadcastTo?: string[];
  // [v6 §2] Broadcast only: per-recipient delivery state keyed by recipient id.
  delivery?: Record<string, DeliveryEntry>;
  // [v5 §8.2] Delivery telemetry; only ever set on author.kind==='human' Sends.
  // deliveredAt: handed to its recipient via /next-instruction. completedAt: the durable
  // completion gate — a Send is pending until it is set (§8.5).
  // [v5.1] deliveredBy: the sessionId holding the lease, for staleness attribution (§8.5).
  // [v6] For a non-broadcast Send these are the single recipient's state (unchanged); for a
  // broadcast they are the AGGREGATE (see delivery + §6).
  deliveredAt?: number;
  // [v9.7 §8.5 #60] receivedAt: the lead's consumer-side receipt ack (see DeliveryEntry). For a
  // non-broadcast lead Send this is the single recipient's ack; unused for workers and broadcasts.
  receivedAt?: number;
  completedAt?: number;
  deliveredBy?: string;
};

// [v5.1 §8.2] A Send's lifecycle state, computed server-side (single source of truth) and
// pushed to the panel. queued: awaiting its recipient. working: held — a worker's live lease OR
// the lead's clockless receipt (§8.5 #55). stalled: WORKER-ONLY — a worker's delivered lease
// expired (holder went silent past STALL_MS), re-queued for redelivery; the LEAD never reaches
// 'stalled' (its redelivery is liveness-driven, not clock-driven — see #55). done: completed.
type SendState = 'queued' | 'working' | 'stalled' | 'done';

// [v6 §7] Per-agent status, one row per addressable recipient, rendered by the panel's status strip.
// `parked` = a live long-poll waiter exists for this recipient right now. `lifecycle` is the
// listening/working signal generalized from v5.1's single `agentParked` boolean.
type AgentStatus = {
  id: string; // recipient id ('lead' or a worker clientKey)
  name: string;
  color: string; // identity hex ('#7C4DFF'): the live presence color, else a deterministic fallback
  role: 'lead' | 'worker';
  parked: boolean;
  lifecycle: 'idle' | 'queued' | 'working' | 'stalled' | 'absent';
};

// [v6 §5] The lead's supervise long-poll's revive outcome: wake worker `revive` (by its recipient
// id). [v7 #45] Carries a fixed bootstrap `nudge` the lead relays VERBATIM to the revived worker;
// `nudge` is required (every revive directive carries it) and is keyed ONLY on the AgentId — no
// pending-instruction text can flow through it (see buildNudge).
type ReviveDirective = { revive: string; name?: string; nudge: string };

// [v9.1 §9 #53] The lead's supervise long-poll's teardown outcome — the operator pressed the
// confirm-gated close-session affordance (surfaced from the per-room teardownRequested flag, §8.2).
// A distinct discriminant key (`teardown`) alongside the revive directive's `revive`, so the skill
// pattern-matches the supervisor poll's outcomes by which key the payload carries: `.instruction`
// (its own Send), `.revive` (revive a worker), `.teardown` (perform the graceful /done), else a 204
// (timeout, re-arm). NOT a chat Message: it never enters the attributed log or a recipient queue.
type TeardownDirective = { teardown: true; room: string };

const messagesByRoom = new Map<string, Message[]>();
const messageIdsByRoom = new Map<string, Set<string>>();

const messagesPathFor = (roomId: string): string => path.join(HOME, `${roomId}.messages.jsonl`);

// Load a room's sidecar into memory once (subsequent calls return the live array).
function loadMessages(roomId: string): Message[] {
  const existing = messagesByRoom.get(roomId);
  if (existing) return existing;
  const arr: Message[] = [];
  const ids = new Set<string>();
  const p = messagesPathFor(roomId);
  if (fs.existsSync(p)) {
    try {
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const m = JSON.parse(trimmed) as Message;
          if (m && typeof m.id === 'string' && !ids.has(m.id)) {
            arr.push(m);
            ids.add(m.id);
          }
        } catch {
          /* skip a malformed line rather than fail the whole load */
        }
      }
      arr.sort((a, b) => a.ts - b.ts);
    } catch (e) {
      console.warn(`[messages] failed to load ${p}: ${(e as Error).message}`);
    }
  }
  messagesByRoom.set(roomId, arr);
  messageIdsByRoom.set(roomId, ids);
  return arr;
}

function hasMessage(roomId: string, id: string): boolean {
  loadMessages(roomId);
  return messageIdsByRoom.get(roomId)?.has(id) ?? false;
}

// Append-and-persist. Returns false (no-op) if the id is already stored — the id dedupe.
function appendMessage(msg: Message): boolean {
  loadMessages(msg.room);
  const ids = messageIdsByRoom.get(msg.room);
  const arr = messagesByRoom.get(msg.room);
  if (!ids || !arr) return false;
  if (ids.has(msg.id)) return false;
  arr.push(msg);
  ids.add(msg.id);
  try {
    fs.appendFileSync(messagesPathFor(msg.room), `${JSON.stringify(msg)}\n`);
  } catch (e) {
    console.warn(`[messages] append failed for '${msg.room}': ${(e as Error).message}`);
  }
  return true;
}

// [v5 §8.2] A delivery-state change (deliveredAt/completedAt) on an existing message
// re-serializes the WHOLE sidecar from the in-memory array (ts-ordered), rather than
// appending a duplicate line. New messages still append (appendMessage). POC scale — a
// full rewrite on each state change is fine.
function rewriteMessages(roomId: string): void {
  const arr = messagesByRoom.get(roomId);
  if (!arr) return;
  const ordered = [...arr].sort((a, b) => a.ts - b.ts);
  const body = ordered.map((m) => JSON.stringify(m)).join('\n');
  try {
    fs.writeFileSync(messagesPathFor(roomId), ordered.length ? `${body}\n` : '');
  } catch (e) {
    console.warn(`[messages] rewrite failed for '${roomId}': ${(e as Error).message}`);
  }
}

// ===========================================================================
// WS frame contracts (the app-slice seam) — discriminated unions
// ===========================================================================
// [v5 §8.6] The author identity carried on an exec frame so the app can stamp
// meta.createdBy / meta.lastEditedBy for the shapes this blob creates. Resolved from the
// registered session; sessionId may be null and name falls back to 'Claude' when unknown.
type ExecAuthor = { kind: 'agent'; sessionId: string | null; name: string; color?: string };

// [render-cap] A page-coordinate region for a zoomed-in export. Absent ⇒ the app
// renders a downscaled bird's-eye of the whole board; present ⇒ it crops to this box
// (an agent leaning in on a piece of the diagram). Forwarded verbatim to the app.
// MIRROR of App.tsx's ExportRegion + parseRegion — the app re-validates whatever this
// bridge forwards (a genuine trust boundary; keep them, don't collapse). Keep the two in
// sync: a rule added to parseBoundsParam here (e.g. a max-size clamp) belongs in
// parseRegion there too.
type ExportRegion = { x: number; y: number; w: number; h: number };

type FrameToApp =
  | { type: 'exec'; id: string; code: string; author: ExecAuthor }
  | { type: 'export-image'; id: string; bounds?: ExportRegion }
  | { type: 'get-shapes'; id: string }
  // [v9.5 §5] Read the render-canvas store's sync health so the server can tell a write that
  // reached the room from one silently suppressed by a corrupted store. Handler in App.tsx.
  | { type: 'sync-health'; id: string }
  | { type: 'agent-message'; text: string; sessionId: string | null; id: string; ts: number; name: string }
  | { type: 'message'; message: Message }
  // [v5 §8.2] A Send's lifecycle change, pushed to human peers. [v5.1] `state` is authoritative.
  // [v6 §4] `recipient` lets the panel key the badge to the right per-recipient state; for a
  // broadcast, `state` is the aggregate and `recipient` is `{kind:'broadcast'}`.
  | { type: 'message-state'; id: string; state: SendState; recipient?: Recipient; deliveredAt?: number; completedAt?: number }
  // [v5 §8.6/§11] agentParked flipped (the LEAD parked/unparked); pushed to human peers.
  | { type: 'parked'; agentParked: boolean }
  // [v9.3 §9 #55] leadAlive flipped (the lead confirmed alive/dead, bridging the wake→re-arm gap);
  // pushed to human peers. Distinct from `parked`: leadAlive stays true through a normal turn's gap.
  | { type: 'lead-alive'; leadAlive: boolean }
  // [v6 §4/§7] The per-agent roster/status changed; pushed to human peers (deduped by value).
  | { type: 'agent-status'; agents: AgentStatus[] }
  // [v9.6 fix 4] The room is closing; connected operator browsers should export now — the socket is
  // about to drop and the client keeps no local persistence, so unsynced edits after close are lost.
  | { type: 'server-closing'; room: string };

type FrameFromApp =
  | { type: 'message'; text?: string; selection?: string[] }
  | { type: 'exec-result'; id: string; ok: boolean; result?: unknown; error?: string }
  | {
      type: 'shapes-result';
      id: string;
      ok?: boolean;
      shapes?: unknown;
      page?: unknown;
      camera?: unknown;
      selection?: unknown;
      error?: string;
    }
  | { type: 'image' | 'image-result'; id: string; ok?: boolean; path?: string; error?: string }
  // [v9.5 §5] Reply to a sync-health request. `possiblyCorrupted` mirrors
  // editor.store.isPossiblyCorrupted(); the rest come from the exposed sync client (window.tlsync).
  | {
      type: 'sync-health-result';
      id: string;
      possiblyCorrupted?: boolean;
      connectedToRoom?: boolean;
      speculativeAdded?: number;
      lastServerClock?: number | null;
    }
  | { type: 'store-change'; diff?: unknown };

// ===========================================================================
// HTTP + WS wiring
// ===========================================================================
const app = express();
app.use(express.json({ limit: '32mb' }));
app.use((req: Request, _res: Response, next: () => void) => {
  console.log(`[bridge] ${req.method} ${req.url}`);
  next();
});

const server = http.createServer(app);
const eventsWss = new WebSocketServer({ noServer: true });
const syncWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${HOST}:${assignedPort}`);
  } catch {
    socket.destroy();
    return;
  }
  const pathname = url.pathname;
  if (pathname === '/events') {
    const role = url.searchParams.get('role') ?? 'agent';
    eventsWss.handleUpgrade(req, socket, head, (ws) => onEventsConnection(ws, role));
  } else if (pathname.startsWith('/sync/')) {
    const roomId = decodeURIComponent(pathname.slice('/sync/'.length));
    if (!roomId) {
      socket.destroy();
      return;
    }
    syncWss.handleUpgrade(req, socket, head, (ws) => {
      const entry = getOrCreateRoom(roomId);
      const syncSessionId = randomUUID();
      try {
        entry.room.handleSocketConnect({ sessionId: syncSessionId, socket: ws });
        console.log(`[sync] peer joined room '${roomId}' (${syncSessionId.slice(0, 8)})`);
      } catch (e) {
        console.warn(`[sync] handleSocketConnect failed for '${roomId}': ${(e as Error).message}`);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      }
    });
  } else {
    socket.destroy();
  }
});

// ===========================================================================
// BRIDGE /events — role-routed (SPEC §4, FIX 3)
// ===========================================================================
// role=agent  -> the render-canvas: the single target for exec / get-shapes / export.
// role=human  -> operator browsers: receive agent-message for their panel log.
// A human connect/disconnect must never disturb the render-canvas socket.
let renderCanvasSocket: WebSocket | null = null;
const humanSockets = new Set<WebSocket>();

function sendToRenderCanvas(frame: FrameToApp): boolean {
  if (!renderCanvasSocket || renderCanvasSocket.readyState !== WebSocket.OPEN) return false;
  renderCanvasSocket.send(JSON.stringify(frame));
  return true;
}

function broadcastToHumans(frame: FrameToApp): number {
  let n = 0;
  for (const ws of humanSockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      n++;
    }
  }
  return n;
}

// Correlated request/response over the render-canvas WS (exec, get-shapes).
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
const pending = new Map<string, Pending>();

function wsRequest<T>(type: 'exec' | 'get-shapes' | 'sync-health', extra: Record<string, unknown> = {}, timeoutMs = WS_REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!renderCanvasSocket || renderCanvasSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('render-canvas not connected'));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`ws request '${type}' timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    sendToRenderCanvas({ type, id, ...extra } as FrameToApp);
  });
}

function settlePending(id: string, err: Error | null, value?: unknown): boolean {
  const p = pending.get(id);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(id);
  if (err) p.reject(err);
  else p.resolve(value);
  return true;
}

type ImageWaiter = { id: string; resolve: (p: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
const imageWaiters: ImageWaiter[] = [];

function requestImage(timeoutMs = WS_REQUEST_TIMEOUT_MS, bounds?: ExportRegion): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!renderCanvasSocket || renderCanvasSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('render-canvas not connected'));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      const i = imageWaiters.findIndex((w) => w.id === id);
      if (i !== -1) imageWaiters.splice(i, 1);
      // [render-cap] The render-canvas never answered this export at all (a hang, or a page
      // that is gone). The app-side timeout normally reports ok:false FIRST (→ rejectImage,
      // which records health); this covers the case where the app never runs, so no frame
      // ever arrives. Without recording here the field stayed null — the original stall's
      // "all lastExport* null" signature. Record it so /canvas-status shows the timeout.
      lastExportOk = false;
      lastExportError = 'export timed out (no frame from render-canvas)';
      lastExportAt = Date.now();
      reject(new Error('export-image timed out'));
    }, timeoutMs);
    imageWaiters.push({ id, resolve, reject, timer });
    sendToRenderCanvas({ type: 'export-image', id, ...(bounds ? { bounds } : {}) });
  });
}

// [#61] Exact-id match ONLY. The former `if (idx === -1 && imageWaiters.length) idx = 0` fallback
// resolved the OLDEST waiter for an unmatched/absent id — under concurrent /image calls a mismatched
// id handed a waiter a path meant for a different request (a second way a caller got a frame it should
// not). An id that matches nothing now leaves every waiter untouched; it simply times out honestly.
// The sole caller is POST /image-upload, which always passes the freshly-written outPath.
function resolveImage(id: string | null, resultPath?: string): void {
  const idx = id ? imageWaiters.findIndex((w) => w.id === id) : -1;
  if (idx === -1) return;
  const [w] = imageWaiters.splice(idx, 1);
  if (!w) return;
  clearTimeout(w.timer);
  w.resolve(resultPath || latestImagePath);
}

// [#61] A failed export (the app answered export-image with ok:false — no upload happened) must reject
// the matching /image waiter so GET /image returns a non-200 with the error, NEVER a stale 200. Same
// exact-id discipline as resolveImage: an unmatched id rejects nothing (the successful upload already
// removed the waiter, since the app awaits POST /image-upload before it sends the frame). Returns true
// iff a waiter was actually matched and rejected — the caller uses that to decide whether an ok:false
// reflects a real in-flight /image request (worth recording as unhealthy) or a stray/superseded frame.
function rejectImage(id: string | null, error: string): boolean {
  const idx = id ? imageWaiters.findIndex((w) => w.id === id) : -1;
  if (idx === -1) return false;
  const [w] = imageWaiters.splice(idx, 1);
  if (!w) return false;
  clearTimeout(w.timer);
  w.reject(new Error(error));
  return true;
}

function onEventsConnection(ws: WebSocket, role: string): void {
  if (role === 'human') {
    humanSockets.add(ws);
    console.log(`[bridge] operator browser connected on /events (role=human, ${humanSockets.size} total)`);
    ws.on('close', () => {
      humanSockets.delete(ws);
      console.log('[bridge] operator browser disconnected');
    });
    ws.on('error', (e) => console.warn('[bridge] /events(human) ws error:', e.message));
    return;
  }

  // role=agent (or unspecified): the render-canvas.
  renderCanvasSocket = ws;
  console.log(`[bridge] render-canvas connected on /events (role=${role})`);

  ws.on('message', (raw: RawData) => {
    let msg: FrameFromApp;
    try {
      msg = JSON.parse(raw.toString()) as FrameFromApp;
    } catch {
      console.warn('[bridge] non-JSON ws frame ignored');
      return;
    }
    switch (msg.type) {
      case 'message': {
        // [v5 §8.5] A WS-origin Send must also become a durable stored Message so pending is a
        // pure projection over the store; store it, then deliver from the stored record.
        const stored: Message = {
          id: randomUUID(),
          room: activeRoomId,
          ts: Date.now(),
          author: { kind: 'human', name: 'You' },
          text: typeof msg.text === 'string' ? msg.text : '',
          selection: Array.isArray(msg.selection) ? msg.selection.filter((s): s is string => typeof s === 'string') : [],
        };
        appendMessage(stored);
        broadcastToHumans({ type: 'message', message: stored });
        deliverInstruction(stored);
        broadcastAgentStatusIfChanged();
        break;
      }
      case 'exec-result':
        settlePending(msg.id, null, { ok: msg.ok, result: msg.result, error: msg.error });
        break;
      case 'shapes-result':
        settlePending(msg.id, null, {
          shapes: msg.shapes,
          page: msg.page,
          camera: msg.camera,
          selection: msg.selection,
        });
        break;
      case 'sync-health-result':
        settlePending(msg.id, null, {
          possiblyCorrupted: msg.possiblyCorrupted === true,
          connectedToRoom: msg.connectedToRoom === true,
          speculativeAdded: typeof msg.speculativeAdded === 'number' ? msg.speculativeAdded : 0,
          lastServerClock: typeof msg.lastServerClock === 'number' ? msg.lastServerClock : null,
        });
        break;
      case 'image':
      case 'image-result':
        // [#61 §6.1] The app's image frame is ok/err SIGNALLING only — never a resolve-with-path. On
        // success the app awaits POST /image-upload (which resolves the waiter with the freshly-written
        // path) BEFORE it sends this frame, so on ok:true the waiter is already gone and there is
        // nothing to do. On ok:false there was NO upload, so the waiter must be REJECTED — resolving it
        // here would hand GET /image a 200 pointing at the stale latestImagePath (the render-stall bug).
        // An absent ok (legacy frame) is treated as success: the upload path is the source of truth.
        if (msg.ok === false) {
          const errStr = typeof msg.error === 'string' && msg.error ? msg.error : null;
          // Reject the matching /image waiter (if any) → GET /image returns 503, never a stale 200.
          const rejected = rejectImage(msg.id, `export-image failed: ${errStr ?? 'no image produced'}`);
          // [#61 §6.1] Only a genuine export FAILURE of a real /image request is "the stall": record
          // it as unhealthy ONLY when this ok:false both carried an error AND matched an outstanding
          // waiter. An empty board (ok:false, no error — nothing to render) is not a failure, and a
          // stray/superseded frame that matched no waiter (e.g. a post-/exec auto-export under a
          // different id) is not a /image outcome — neither may flip the health signal false, or the
          // signal cries wolf on a normal turn. (A concurrent /image whose sibling succeeds can still
          // leave a transient false via last-writer-wins; a per-request health record would be needed
          // to close that, which is out of scope here.)
          if (rejected && errStr) {
            lastExportOk = false;
            lastExportError = errStr;
            lastExportAt = Date.now();
          }
        }
        break;
      case 'store-change':
        break;
      default:
        console.log(`[bridge] unhandled ws frame: ${(msg as { type: string }).type}`);
    }
  });

  ws.on('close', () => {
    if (renderCanvasSocket === ws) renderCanvasSocket = null;
    console.log('[bridge] render-canvas disconnected');
  });
  ws.on('error', (e) => console.warn('[bridge] /events(agent) ws error:', e.message));
}

// ===========================================================================
// SESSIONS & PRESENCE (SPEC §4/§7, FIX 2 + FIX 4A)
// ===========================================================================
const presence = new PresenceManager(
  // Evaluated per connection (after `listen`), so `assignedPort` is resolved by then.
  (roomId: string) => `ws://${HOST}:${assignedPort}/sync/${encodeURIComponent(roomId)}`,
  activeRoomId,
);

const CURSOR_COLORS = ['#7C4DFF', '#00B8D9', '#FF5630', '#36B37E', '#FFAB00', '#6554C0'];
let sessionCount = 0;

// Idempotent identity: clientKey <-> sessionId (FIX 4A). A repeated register with the
// same live clientKey rebinds to the same cursor instead of spawning a second.
const clientKeyToSession = new Map<string, string>();
const sessionToClientKey = new Map<string, string>();
// [v4 §4] The caller's Claude Code transcript path, recorded for attribution and the
// on-demand reconciler (§8.2). Optional; never blocks registration; not built against yet.
const sessionToTranscriptPath = new Map<string, string>();

// [v7 #43] The AgentId registry: every recipient id ever registered, seeded with the reserved
// lead id. Added-to on every /session/register (below), and NEVER removed — not on unregister,
// not on death. That is exactly what keeps a dead worker addressable so a Send can wait for it
// (a registered-then-dead worker stays a valid recipient). 'everyone' is a broadcast keyword and
// is never added here.
const knownRecipientIds = new Set<string>(['lead']);
const RESERVED_EVERYONE = 'everyone';
// A valid AgentId = 'lead' or an ever-registered worker clientKey. Not 'everyone'. The type
// predicate is where the runtime seam check narrows an untrusted string to a typed AgentId.
function isAgentId(id: string): id is AgentId {
  return id !== RESERVED_EVERYONE && knownRecipientIds.has(id);
}

type RegisterBody = { name?: unknown; color?: unknown; clientKey?: unknown; transcriptPath?: unknown };

app.post('/session/register', (req: Request, res: Response) => {
  const { name, color, clientKey, transcriptPath } = (req.body ?? {}) as RegisterBody;
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'body.name (string) required' });
    return;
  }
  const cleanName = name.trim();
  const cleanColor =
    typeof color === 'string' && color
      ? color
      : CURSOR_COLORS[sessionCount % CURSOR_COLORS.length] ?? '#7C4DFF';
  const key = typeof clientKey === 'string' && clientKey ? clientKey : null;
  const transcript = typeof transcriptPath === 'string' && transcriptPath ? transcriptPath : null;

  // [v7 #43] Record this agent id as ever-registered (both the rebind and new-session paths flow
  // through here). Never removed later, so the id stays a valid recipient across death/revival.
  if (key) knownRecipientIds.add(key);

  if (key) {
    const existing = clientKeyToSession.get(key);
    if (existing && presence.has(existing)) {
      presence.update(existing, { name: cleanName, color: cleanColor });
      if (transcript) sessionToTranscriptPath.set(existing, transcript);
      touch(existing);
      console.log(`[bridge] session rebind on clientKey: '${cleanName}' -> ${existing.slice(0, 8)}`);
      // [v6] A rebind can re-mark an absent worker present + rename it — refresh the strip.
      broadcastAgentStatusIfChanged();
      res.json({ sessionId: existing });
      return;
    }
  }

  const sessionId = randomUUID();
  sessionCount++;
  presence.register(sessionId, cleanName, cleanColor);
  touch(sessionId);
  if (key) {
    clientKeyToSession.set(key, sessionId);
    sessionToClientKey.set(sessionId, key);
  }
  if (transcript) sessionToTranscriptPath.set(sessionId, transcript);
  console.log(`[bridge] session registered: '${cleanName}' (${sessionId.slice(0, 8)}${key ? `, key=${key}` : ''})`);
  // [v6] A new registered worker joins the roster (or an absent one becomes present) — refresh.
  broadcastAgentStatusIfChanged();
  res.json({ sessionId });
});

app.post('/session/unregister', (req: Request, res: Response) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: unknown };
  if (typeof sessionId !== 'string') {
    res.status(400).json({ error: 'body.sessionId (string) required' });
    return;
  }
  // Idempotent: removing an already-removed session is a no-op success.
  const removed = presence.unregister(sessionId);
  const key = sessionToClientKey.get(sessionId);
  if (key) {
    clientKeyToSession.delete(key);
    sessionToClientKey.delete(sessionId);
  }
  sessionToTranscriptPath.delete(sessionId);
  if (removed) console.log(`[bridge] session unregistered: ${sessionId.slice(0, 8)}`);
  // [v6] The roster shrank (a worker may now read as absent if it still has pending Sends) — refresh.
  broadcastAgentStatusIfChanged();
  res.json({ ok: true, removed });
});

app.post('/presence', (req: Request, res: Response) => {
  const { sessionId, state } = (req.body ?? {}) as { sessionId?: unknown; state?: unknown };
  if (typeof sessionId !== 'string' || !presence.has(sessionId)) {
    res.status(404).json({ error: 'unknown sessionId' });
    return;
  }
  if (state !== 'idle' && state !== 'thinking' && state !== 'drawing') {
    res.status(400).json({ error: 'state must be idle|thinking|drawing' });
    return;
  }
  touch(sessionId); // [v5.1] a presence update is proof the session is alive
  presence.setState(sessionId, state);
  res.json({ ok: true, sessionId, state });
});

// ===========================================================================
// INSTRUCTION QUEUE + LONG-POLL (SPEC §3/§4)
// ===========================================================================
// [v7 #42] Two concerns live in this section and the ones below, deliberately un-split (a
// documentation seam, no behavior change). This map is the authoritative membership; the code
// is interleaved by v6 data-flow, so each function also carries an inline concern tag where it
// falls outside its banner's run:
//
//   ROUTER (routing/projection): moves a Send to the right per-recipient queue and delivers it;
//     knows nothing about liveness. recipientIdOf, targetIdsOf, slotOf/writableSlotOf,
//     isAddressedTo, isCompletedFor, pendingFor, nextPendingFor, subStateFor/sendState/
//     broadcastMessageState (message-state projection), instructionPayload, markDelivered,
//     deliverInstruction, parseRecipient, currentWorkerRecipientIds, the lease helpers
//     (isLeased/addLease/dropLease) and the waiter helpers, plus the endpoints
//     /next-instruction (routing half), /message, /instruction-complete, and the exec/shapes/
//     image relays.
//   LIFECYCLE MONITOR (health): signals, never acts. agentParked/broadcastParkedIfChanged,
//     candidateWorkerIds, agentDisplayName, workerNeedingRevive (+ buildNudge/bridgeBaseUrl),
//     sweepStalledLeases, present/lifecycleFor/computeAgents/broadcastAgentStatusIfChanged,
//     the revive-grace helpers, and lastSeenBySession/touch.
//
// "supervisor" is reserved for the LEAD's role (an agent supervising its workers). The bridge's
// health half is the "lifecycle monitor": it SIGNALS a revive; only the lead ACTS on it (§3, #41).
//
// ===== ROUTER =====
// [v5 §8.5] The instruction queue is NO LONGER a separate in-memory array. Pending is a
// read-model PROJECTION over the message store. [v6 §8.5] That projection is now filtered
// PER RECIPIENT: one message log, N filtered views (`pendingFor`), not N physical queues. A
// recipient's pending = a human Message addressed to it with no completion FOR it, oldest-first by
// `ts`. Completion is the durable gate; `deliveredAt`/`deliveredBy` are per-recipient telemetry;
// the per-recipient lease (`inFlightByRecipient`) guards against double-serve to a live consumer and
// is NOT persisted, so on boot every not-completed human Send re-drains — the crash-recovery path.
//
// [v4 §8.2] The payload's `id` is the originating human Send's message id, threaded through
// so the agent's transcript tool_result carries it (correlation for the reconciler).
// [v6 §3] The instruction payload. `for` echoes which recipient this was served to; `broadcast`
// is set iff the source Message is a broadcast, so the consumer knows to pass `for` on complete.
// [v9.4 §9 #56] `reArmFirst` is the FIRST field so it serializes at the top of the wake body: a
// fixed, in-band re-arm reminder the woken session reads before the instruction — the point-of-wake
// arm of guarantee (1) (relaunch-first, §2 step (a′)), on the drained-Send wake specifically (a
// revive-directive wake also exits the poller and still needs the re-arm, but rides SKILL prose,
// not this field — §9). Content-free per recipient class, like the revive nudge (#45), so no Send
// text can ride it. The "first field" property rides V8's insertion-order preservation in
// JSON.stringify — keep reArmFirst first if you reorder the literal (the integration test locks it
// via Object.keys()[0]).
// [v9.7 §8.5 #60] deliveredAt: the delivery nonce carried on the payload so the receipt ack can be
// scoped to THIS delivery, not just the message id — a stale ack from an earlier (superseded) delivery
// of the same id is then a no-op, so it can never immunize a later lost delivery against reclaim.
type Instruction = { reArmFirst: string; instruction: string; selection: string[]; id: string | null; at: number; deliveredAt?: number; for: string; broadcast?: boolean };
// [v6] A waiter is bound to the recipient id it parked for; `supervise` marks the lead's merged
// supervisor long-poll (it also receives revive directives, §5).
type Waiter = { res: Response; timer: NodeJS.Timeout; sessionId: string | null; recipientId: string; supervise: boolean };
const waiters: Waiter[] = [];
// [v6 §8] Per-recipient lease set: recipient id -> the message ids that recipient currently holds
// a live lease on. Replaces v5.1's single global inFlight set. NOT persisted, so on boot every
// not-completed human Send re-drains (the crash-recovery path).
const inFlightByRecipient = new Map<string, Set<string>>();
function isLeased(recipientId: string, id: string): boolean {
  return inFlightByRecipient.get(recipientId)?.has(id) ?? false;
}
function addLease(recipientId: string, id: string): void {
  let set = inFlightByRecipient.get(recipientId);
  if (!set) inFlightByRecipient.set(recipientId, (set = new Set<string>()));
  set.add(id);
}
function dropLease(recipientId: string, id: string): void {
  inFlightByRecipient.get(recipientId)?.delete(id);
}
// [v9.3 §8.5 #55] NAMED SEAM for the lead/worker delivery divergence. `inFlightByRecipient` holds two
// DIFFERENT concepts behind one map, told apart only by the recipient key:
//   - a worker key ('worker-N') → a TIMED LEASE: renewed by every sessionId-bearing call, reclaimed by
//     sweepStalledLeases once its holder is silent past STALL_MS (a genuine Competing-Consumers
//     visibility timeout);
//   - the 'lead' key → a CLOCKLESS RECEIPT: never time-swept; reclaimed only by sweepDeadLead when its
//     holder is liveness-confirmed dead (no armed listener, unseen past LEAD_GRACE_MS).
// Read the lead's held marker through holdsLeadReceipt() rather than a bare isLeased('lead', …) so the
// receipt concept is NAMED at every read site. This is a documentary/greppable seam, not a type
// boundary — holdsLeadReceipt shares isLeased's map; the mechanical divergence lives in the sweeps
// below (sweepStalledLeases skips 'lead'; sweepDeadLead owns it). The naming is what guards against a
// future site re-reading the lead's receipt as a worker-style timed lease — the one-mechanism-two-
// consumers overload that produced P6. The sites that special-case the lead: subStateFor,
// sweepStalledLeases (skips it), sweepDeadLead, leadAlive; lifecycleFor's lead classification branches
// on leadAlive (its generic 'working' check does read this marker).
function holdsLeadReceipt(id: string): boolean {
  return isLeased('lead', id);
}
// [v9.7 §8.5 #60] A held lead receipt whose delivery was handed to the transport (deliveredAt) but
// NEVER consumer-acknowledged (no receivedAt) and not yet completed. This is a delivery that MAY have
// been lost to a half-open socket — the producer wrote the bytes, but no consumer ever confirmed
// taking them. The reclaim seam below promotes "may have been lost" to "provably lost" using the
// re-arm signal (the holder opening a fresh listener proves the delivering socket is gone).
function holdsUnreceivedLeadReceipt(msg: Message): boolean {
  if (!holdsLeadReceipt(msg.id)) return false;
  return msg.deliveredAt != null && msg.receivedAt == null && msg.completedAt == null;
}
// [v9.3 §9 #55] The single definition of "was this delivery's holder seen within a window?" — the
// liveness probe shared by leadAlive and sweepDeadLead (window = LEAD_GRACE_MS) and the worker
// sweepStalledLeases (window = STALL_MS). `deliveredBy` is the holder session (null on an undelivered
// slot); fall back to `deliveredAt` when there is no holder session to look up. Kept in one place so the
// banner (leadAlive) and the reclaim (sweepDeadLead) can never drift apart on a one-sided edit to the
// rule — only the window argument distinguishes lead from worker.
function holderSeenWithin(
  deliveredBy: string | null | undefined,
  deliveredAt: number | null | undefined,
  windowMs: number,
  now: number,
): boolean {
  const seen = (deliveredBy ? lastSeenBySession.get(deliveredBy) : undefined) ?? deliveredAt;
  return seen != null && now - seen <= windowMs;
}

// [LIFECYCLE MONITOR] [v6 §5] Revive-storm guard: recipient id -> epoch ms until which a revive is
// suppressed for it.
const reviveGraceUntil = new Map<string, number>();
function openReviveGrace(recipientId: string): void {
  reviveGraceUntil.set(recipientId, Date.now() + REVIVE_GRACE_MS);
}
function clearReviveGrace(recipientId: string): void {
  reviveGraceUntil.delete(recipientId);
}
function inReviveGrace(recipientId: string): boolean {
  const until = reviveGraceUntil.get(recipientId);
  return until != null && until > Date.now();
}

// [v9.1 §8.2/§9 #53] Operator teardown-request: a per-room in-memory control flag, NOT a chat
// Message. The drawer's confirm-gated close-session affordance POSTs /request-teardown to set it;
// the lead's supervisor long-poll surfaces it as a teardown directive, on which the lead performs
// the graceful /done (§8.3). In-memory only — a teardown is a live-session action, with nothing to
// persist (a forced/auto end still tears down nothing, #50). The flag is cleared the moment the
// directive is handed to the lead (consumption), so a re-arming supervisor never re-issues it, and
// again on /done as defensive cleanup for the natural-language-Send fallback path (which reaches
// /done without ever consuming a directive). A dropped directive response loses the signal; the
// operator simply presses close again — acceptable for the POC, and it can never loop.
const teardownRequestedRooms = new Set<string>();
function isTeardownRequested(roomId: string): boolean {
  return teardownRequestedRooms.has(roomId);
}
function setTeardownRequested(roomId: string): void {
  teardownRequestedRooms.add(roomId);
}
function clearTeardownRequested(roomId: string): void {
  teardownRequestedRooms.delete(roomId);
}
function teardownDirectiveFor(roomId: string): TeardownDirective {
  return { teardown: true, room: roomId };
}

// [LIFECYCLE MONITOR] [v5.1 §8.5] Per-session liveness heartbeat: bumped by any bridge call carrying
// a sessionId. A lease's holder is "alive" if seen within STALL_MS; otherwise the lease expires
// (sweep below).
const lastSeenBySession = new Map<string, number>();
function touch(sessionId: string | null | undefined): void {
  if (sessionId) lastSeenBySession.set(sessionId, Date.now());
}

// ---- recipient resolution + per-recipient projection over the one message log (§1, §8.5) -------

// [v6 §1] A Message's recipient id: 'everyone' for a broadcast, else its stored id, else 'lead'.
function recipientIdOf(msg: Message): string {
  return msg.recipient?.kind === 'broadcast' ? 'everyone' : msg.recipient?.id ?? 'lead';
}

// The recipient ids a human Message is actually pending for: a broadcast fans to each broadcastTo
// id, a non-broadcast is exactly its one recipient.
function targetIdsOf(msg: Message): string[] {
  return msg.recipient?.kind === 'broadcast' ? msg.broadcastTo ?? [] : [recipientIdOf(msg)];
}

// The delivery "slot" for (msg, recipientId): a broadcast keeps one DeliveryEntry per id in its
// `delivery` map; a non-broadcast keeps the single recipient's state in the Message's own top-level
// fields (so v5 behavior is byte-identical). Read-only lookups may get undefined for a broadcast id
// never delivered; the writable variant creates the entry.
function slotOf(msg: Message, recipientId: string): DeliveryEntry | undefined {
  return msg.recipient?.kind === 'broadcast' ? msg.delivery?.[recipientId] : msg;
}
function writableSlotOf(msg: Message, recipientId: string): DeliveryEntry {
  if (msg.recipient?.kind !== 'broadcast') return msg;
  const map = msg.delivery ?? (msg.delivery = {});
  return map[recipientId] ?? (map[recipientId] = {});
}

function isAddressedTo(msg: Message, recipientId: string): boolean {
  if (msg.author.kind !== 'human') return false;
  return targetIdsOf(msg).includes(recipientId);
}
function isCompletedFor(msg: Message, recipientId: string): boolean {
  return slotOf(msg, recipientId)?.completedAt != null;
}

// [v6 §8.5] Pending for a recipient = human Sends addressed to it, not completed for it, oldest-first
// (includes leased ones — the caller distinguishes working vs available). One message log, N filtered
// views: there are NOT N physical queues.
function pendingFor(roomId: string, recipientId: string): Message[] {
  return loadMessages(roomId)
    .filter((m) => isAddressedTo(m, recipientId) && !isCompletedFor(m, recipientId))
    .sort((a, b) => a.ts - b.ts);
}
// The oldest pending Send for a recipient NOT already leased by it (available to serve/re-serve).
function nextPendingFor(roomId: string, recipientId: string): Message | null {
  for (const m of pendingFor(roomId, recipientId)) {
    if (!isLeased(recipientId, m.id)) return m;
  }
  return null;
}

// ---- waiter helpers (per recipient) ------------------------------------------------------------
function waitersFor(recipientId: string): Waiter[] {
  return waiters.filter((w) => w.recipientId === recipientId);
}
function removeWaiter(w: Waiter): boolean {
  const i = waiters.indexOf(w);
  if (i === -1) return false;
  waiters.splice(i, 1);
  return true;
}
// Take (and remove) the first waiter parked for a recipient — a supervisor waiter (recipientId
// 'lead') is eligible to receive the lead's OWN pending Send, which is why it is included here.
function takeWaiterFor(recipientId: string): Waiter | null {
  const i = waiters.findIndex((w) => w.recipientId === recipientId);
  return i === -1 ? null : waiters.splice(i, 1)[0] ?? null;
}
function takeSupervisorWaiter(): Waiter | null {
  const i = waiters.findIndex((w) => w.supervise);
  return i === -1 ? null : waiters.splice(i, 1)[0] ?? null;
}
function recipientIdsWithWaiters(): string[] {
  return [...new Set(waiters.map((w) => w.recipientId))];
}

// [LIFECYCLE MONITOR] agentParked = the LEAD has a live long-poll waiter (§8.6) — UNCHANGED meaning
// (test D relies on it): a supervise poll is a lead waiter too. Broadcast a `parked` frame on a
// 0<->>0 transition.
let lastAgentParked = false;
function agentParked(): boolean {
  return waitersFor('lead').length > 0;
}
function broadcastParkedIfChanged(): void {
  const now = agentParked();
  if (now !== lastAgentParked) {
    lastAgentParked = now;
    broadcastToHumans({ type: 'parked', agentParked: now });
  }
}

// [LIFECYCLE MONITOR] [v9.3 §9 #55] leadAlive: the honest liveness signal for the lead, distinct from
// the transient agentParked. True when the lead is alive AND able to hear messages: an armed lead
// listener exists, OR (bridging the wake→re-arm gap where no listener is parked) a held lead receipt
// whose holder session was seen within the grace window. False only when the lead is CONFIRMED dead
// (no listener, and every held receipt's holder is past the grace). This is what the panel keys the
// "no one on the board" banner and the lead avatar's dim on — NOT agentParked===false, which is false
// on every normal turn while the poller is torn down to wake the agent. A bare heartbeat does not
// count: liveness requires an armed listener or a recently-seen receipt holder, never a socketless
// touch alone (an agent that stops listening silently drops messages).
function leadAlive(now: number): boolean {
  if (waitersFor('lead').length > 0) return true; // an armed listener → alive and hearing
  for (const m of loadMessages(activeRoomId)) {
    if (!holdsLeadReceipt(m.id)) continue; // a held lead receipt (being handled)
    if (holderSeenWithin(m.deliveredBy, m.deliveredAt, LEAD_GRACE_MS, now)) return true; // holder within grace → still alive
  }
  return false;
}

// [v9.3 §9 #55] Broadcast a lead-alive frame on a false<->true transition (deduped by value), so the
// panel reacts without polling. Folded into broadcastAgentStatusIfChanged (below) so it fires on
// every transition that already refreshes the roster, plus the grace-expiry sweep.
let lastLeadAlive = false;
function broadcastLeadAliveIfChanged(): void {
  const now = leadAlive(Date.now());
  if (now !== lastLeadAlive) {
    lastLeadAlive = now;
    broadcastToHumans({ type: 'lead-alive', leadAlive: now });
  }
}

// ---- lifecycle state (§6) ----------------------------------------------------------------------
// A single recipient's sub-state on a Send: identical rules to v5.1, keyed per recipient.
function subStateFor(msg: Message, recipientId: string): SendState {
  const slot = slotOf(msg, recipientId);
  if (slot?.completedAt != null) return 'done';
  // [v9.3 §8.5 #55] The LEAD has no timed lease and no 'stalled' state. Its receipt (the clockless
  // inFlightByRecipient marker) held → 'working'; not held → 'queued' (awaiting a lead, including
  // after a confirmed-dead re-queue that dropped the receipt). Redelivery is liveness-driven, so a
  // live-but-silent lead stays 'working' through the wake→re-arm gap and never reads 'stalled'.
  if (recipientId === 'lead') return holdsLeadReceipt(msg.id) ? 'working' : 'queued';
  if (slot?.deliveredAt == null) return 'queued';
  return isLeased(recipientId, msg.id) ? 'working' : 'stalled';
}

// [v6 §6] Authoritative lifecycle. Non-broadcast: the single recipient's sub-state. Broadcast:
// done iff every broadcastTo entry is done (or none); else working if any is working; else stalled
// if any is stalled; else queued.
function sendState(msg: Message): SendState {
  if (msg.recipient?.kind !== 'broadcast') return subStateFor(msg, recipientIdOf(msg));
  const ids = msg.broadcastTo ?? [];
  if (ids.length === 0) return 'done';
  const subs = ids.map((id) => subStateFor(msg, id));
  if (subs.every((s) => s === 'done')) return 'done';
  if (subs.some((s) => s === 'working')) return 'working';
  if (subs.some((s) => s === 'stalled')) return 'stalled';
  return 'queued';
}

function broadcastMessageState(msg: Message): void {
  const frame: FrameToApp = { type: 'message-state', id: msg.id, state: sendState(msg) };
  if (msg.recipient) frame.recipient = msg.recipient;
  frame.deliveredAt = msg.deliveredAt; // top-level: single recipient (non-broadcast) or unused (broadcast)
  frame.completedAt = msg.completedAt; // broadcast: set only once every recipient completed (§6)
  broadcastToHumans(frame);
}

// [v9.4 §9 #56] The in-band re-arm reminder: a FIXED directive carried as the first field of every
// delivered Send payload (see the Instruction type). Delivering a Send exits the lead's background
// poller (poll.sh exits on the 200 — that exit IS the wake), so at the instant the woken session
// reads this body its listener is already down; the reminder restates guarantee (1) (relaunch-first,
// §2 step (a′)) at the point of highest attention, cutting the chance the session yields idle before
// re-arming. Content-free like buildNudge (#45): no Send text flows in, so it is byte-identical per
// recipient class and can never carry a paraphrase. The lead relaunches the background poller; a
// worker (which does not use poll.sh — SKILL §4) re-arms its own long-poll instead.
function reArmDirectiveFor(recipientId: string): string {
  return recipientId === 'lead'
    ? 'RE-ARM FIRST — delivering this Send exited the background poller, so your listener is DOWN and the next message will not be heard until you relaunch it. Before acting on the instruction below, your FIRST action must be to relaunch the background poller, server/poll.sh, exactly as you launched it at boot (the skill loop, step (a′)).'
    : 'RE-ARM FIRST — before acting on the instruction below, re-issue your long-poll GET /next-instruction?for=<your id>&sessionId=<sid> so the next Send is heard. The for=<your id> param is required: omit it and the endpoint defaults to for=lead, draining the lead\'s queue, not yours. A 204 is a re-arm, not an exit.';
}

function instructionPayload(msg: Message, recipientId: string): Instruction {
  const payload: Instruction = {
    reArmFirst: reArmDirectiveFor(recipientId),
    instruction: msg.text,
    selection: msg.selection ?? [],
    id: msg.id,
    at: msg.ts,
    for: recipientId,
  };
  // [v9.7 §8.5 #60] Carry the delivery nonce so poll.sh's receipt ack names THIS delivery. Read after
  // markDelivered has stamped the slot (every send site calls markDelivered first), so it is set.
  const deliveredAt = slotOf(msg, recipientId)?.deliveredAt;
  if (deliveredAt != null) payload.deliveredAt = deliveredAt;
  if (msg.recipient?.kind === 'broadcast') payload.broadcast = true;
  return payload;
}

// Serve a stored Send to a recipient: lease it under that recipient, stamp its delivery slot,
// persist the rewrite, broadcast the state change, and move the session's cursor to 'thinking'.
// Taking work is proof the recipient is present, so clear any revive grace it was under.
function markDelivered(msg: Message, recipientId: string, sessionId: string | null): void {
  addLease(recipientId, msg.id);
  const slot = writableSlotOf(msg, recipientId);
  slot.deliveredAt = Date.now();
  // [v9.7 §8.5 #60] A (re)delivery is a NEW hand-off: its receipt is not yet confirmed. Clear any
  // prior receivedAt so this delivery must be re-acked — otherwise a Send received by an earlier lead
  // and then re-queued (sweepDeadLead) would carry a stale ack and be immune to the lost-delivery
  // reclaim if THIS delivery is lost. Load-bearing: every lead redelivery path flows through here.
  delete slot.receivedAt;
  if (sessionId) slot.deliveredBy = sessionId;
  else delete slot.deliveredBy; // an anonymous poll holds a lease that expires from deliveredAt
  touch(sessionId);
  clearReviveGrace(recipientId);
  rewriteMessages(msg.room);
  broadcastMessageState(msg);
  if (sessionId && presence.has(sessionId)) presence.setState(sessionId, 'thinking');
}

// ===== LIFECYCLE MONITOR =====
// From here the section is predominantly the lifecycle monitor (health signalling): revival
// detection, the stalled-lease sweep, and the per-agent status roster. The monitor only ever
// SIGNALS — it raises a revive directive; the lead is what ACTS on it (§3, #41). The one router
// function in this run (deliverInstruction) is tagged inline; serviceWaiters is the entanglement
// seam where the two halves meet.
//
// ---- revival detection (§5) --------------------------------------------------------------------
// Candidate worker recipient ids: those on pending (not-completed-for-them) human Sends, minus the
// reserved lead/everyone.
function candidateWorkerIds(roomId: string): Set<string> {
  const ids = new Set<string>();
  for (const m of loadMessages(roomId)) {
    if (m.author.kind !== 'human') continue;
    for (const rid of targetIdsOf(m)) {
      if (rid === 'lead' || rid === 'everyone') continue;
      if (!isCompletedFor(m, rid)) ids.add(rid);
    }
  }
  return ids;
}
// A display name for a recipient id: prefer a live registered session's name, else a name carried
// on a Send addressed to it, else the id itself.
function agentDisplayName(recipientId: string): string {
  const sid = clientKeyToSession.get(recipientId);
  const info = sid ? presence.info(sid) : undefined;
  if (info?.name) return info.name;
  for (const m of loadMessages(activeRoomId)) {
    if (m.recipient?.kind === 'worker' && m.recipient.id === recipientId && m.recipient.name) return m.recipient.name;
  }
  return recipientId === 'lead' ? 'Lead' : recipientId;
}
// The identity color for a recipient id, mirroring agentDisplayName's resolution: prefer the live
// registered session's presence color (the source of truth, assigned from CURSOR_COLORS at
// register). With no live session (an absent/dead worker still in the roster), fall back to a
// deterministic pick so the avatar stays stable across appearances — a stable hash of the id
// indexes the palette. Never undefined.
function agentColor(recipientId: string): string {
  const sid = clientKeyToSession.get(recipientId);
  const info = sid ? presence.info(sid) : undefined;
  if (info?.color) return info.color;
  let h = 0;
  for (let i = 0; i < recipientId.length; i++) h = (h * 31 + recipientId.charCodeAt(i)) | 0;
  return CURSOR_COLORS[Math.abs(h) % CURSOR_COLORS.length] ?? '#7C4DFF';
}
// [v7 #45] The bridge base URL, a process constant derived from the actual bound port (the same
// value the server logs on boot and writes to the lockfile via `assignedPort`). NOT read from the
// socket per call and NOT instruction-derived.
function bridgeBaseUrl(): string {
  return `http://${HOST}:${assignedPort}`;
}

// [v7 #45] The revival nudge: a FIXED bootstrap the lead relays VERBATIM to the revived worker.
// Its ONLY variable is `agentId`; the bridge URL is a process constant. It has no parameter and no
// closure through which a pending instruction could flow — so it is byte-identical for a given
// agentId on every revival, regardless of any pending Send's content (the "no field can hold a
// paraphrase" guarantee, #45). NO instruction/payload may ever enter here.
function buildNudge(agentId: string): string {
  return [
    `You are whiteboard agent "${agentId}" on the shared board.`,
    `The bridge is at ${bridgeBaseUrl()}.`,
    `Re-register your session, then DRAIN YOUR OWN QUEUE and self-park:`,
    `  1. POST /session/register {"name":"<your display name>","clientKey":"${agentId}"} -> {sessionId}`,
    `  2. long-poll GET /next-instruction?for=${agentId}&sessionId=<sessionId>`,
    `  3. run the read-act turn on each returned Send, POST /instruction-complete {id,for:"${agentId}"}, re-arm.`,
    `A 204 is a re-arm, not an exit. Do not stop looping while alive and cheap.`,
  ].join('\n');
}

// The worker most in need of a revive directive right now, or null. Prefers the oldest-waiting one.
function workerNeedingRevive(roomId: string): ReviveDirective | null {
  let best: { id: string; ts: number } | null = null;
  for (const rid of candidateWorkerIds(roomId)) {
    if (waitersFor(rid).length > 0) continue; // a live poller for it → no revive
    if (inReviveGrace(rid)) continue; // already being revived
    const msg = nextPendingFor(roomId, rid); // an unleased pending Send exists (after the sweep)
    if (!msg) continue;
    if (best === null || msg.ts < best.ts) best = { id: rid, ts: msg.ts };
  }
  if (!best) return null;
  // [v7 #45] Populate `nudge` here so BOTH raise-sites (the inline supervise branch in
  // /next-instruction and the deferred serviceWaiters branch) carry the same fixed text.
  const directive: ReviveDirective = { revive: best.id, nudge: buildNudge(best.id) };
  const name = agentDisplayName(best.id);
  if (name && name !== best.id) directive.name = name;
  return directive;
}

// [v6] Service every parked waiter against the current log: hand each recipient (lead included) its
// own oldest pending Send first (lead's own work outranks a revive directive, §5), then hand any
// supervisor waiter a revive directive for a worker that needs one.
function serviceWaiters(roomId: string): void {
  let changed = false;
  for (;;) {
    let progress = false;
    for (const rid of recipientIdsWithWaiters()) {
      const msg = nextPendingFor(roomId, rid);
      if (!msg) continue;
      const waiter = takeWaiterFor(rid);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      markDelivered(msg, rid, waiter.sessionId);
      waiter.res.json(instructionPayload(msg, rid));
      progress = true;
      changed = true;
    }
    if (!progress) break;
  }
  // [v9.1 §9 #53] Operator teardown-request. Once the router has drained the lead's own pending
  // Sends (loop above), a set teardownRequested flag is handed to a parked supervisor (the lead) as
  // the teardown directive. It outranks a revive (reviving a worker is moot while the session is
  // closing) and its own Send always drains first (a just-sent instruction is never stranded by the
  // close). Cleared on consumption so a re-arm does not re-issue it (also cleared on /done).
  if (isTeardownRequested(roomId)) {
    const waiter = takeSupervisorWaiter();
    if (waiter) {
      clearTimeout(waiter.timer);
      clearTeardownRequested(roomId);
      waiter.res.json(teardownDirectiveFor(roomId));
      console.log(`[bridge] supervisor issued teardown directive for room '${roomId}'`);
      changed = true;
    }
  }
  // [v7 #42] ENTANGLEMENT SEAM. The router delivered Sends first (loop above); now the lifecycle
  // monitor's revive directives are handed to a parked supervisor (the lead). The monitor SIGNALS
  // (raises the directive); the LEAD acts (only an agent can revive — §3, decision #41).
  for (;;) {
    const target = workerNeedingRevive(roomId);
    if (!target) break;
    const waiter = takeSupervisorWaiter();
    if (!waiter) break;
    clearTimeout(waiter.timer);
    openReviveGrace(target.revive);
    waiter.res.json(target);
    console.log(`[bridge] supervisor issued revive directive for ${target.revive}`);
    changed = true;
  }
  if (changed) {
    broadcastParkedIfChanged();
    broadcastAgentStatusIfChanged();
  }
}

// [ROUTER] [v5 §8.5] Notify path for a freshly-stored Send: it is already in the durable log, so just
// service the parked waiters (deliver to the addressed recipient(s), and wake a supervisor for a dead
// one).
function deliverInstruction(msg: Message): void {
  serviceWaiters(msg.room);
}

// [v9.2] "Never stop listening": a lease's holder SESSION has a live parked long-poll waiter right
// now. Keyed on the holder session (the lease's deliveredBy), not the recipient — a live waiter is
// proof THAT session's process is alive and listening, so its lease must not be swept even after a
// long silence. Guards the null/anonymous holder (an anonymous lease carries no deliveredBy and is
// never spared here — it ages out on deliveredAt as before).
function sessionHasWaiter(sessionId: string | null | undefined): boolean {
  return !!sessionId && waiters.some((w) => w.sessionId === sessionId);
}

// [v6 §8] Lease/visibility-timeout sweep, per recipient. A delivered Send is a lease held by its
// consumer; if that consumer goes silent past STALL_MS the lease expires: reclaim it (drop from that
// recipient's inFlight), mark it stalled, and re-service (redeliver to a parked poller for that
// recipient, or — for a worker with no poller — surface it to the lead's supervisor as a revive).
function sweepStalledLeases(): void {
  const now = Date.now();
  let reclaimedAny = false;
  for (const [roomId, arr] of messagesByRoom) {
    let reclaimedInRoom = false;
    for (const msg of arr) {
      if (msg.author.kind !== 'human') continue;
      let changedMsg = false;
      for (const rid of targetIdsOf(msg)) {
        // [v9.3 §8.5 #55] The LEAD is NOT swept on a clock: its receipt is clockless and redelivery
        // is liveness-driven (see sweepDeadLead). Only genuine competing consumers (workers) keep the
        // STALL_MS visibility timeout. Lead and worker diverge on purpose.
        if (rid === 'lead') continue;
        if (!isLeased(rid, msg.id)) continue; // not leased by this recipient
        const slot = slotOf(msg, rid);
        if (!slot || slot.completedAt != null || slot.deliveredAt == null) continue;
        if (holderSeenWithin(slot.deliveredBy, slot.deliveredAt, STALL_MS, now)) continue; // lease still valid — the holder was seen recently
        // [v9.2] A deliberate pause (a clarifying question handed back, no bridge calls for >STALL_MS)
        // must not reclaim the lease: a parked waiter for the HOLDER session proves that session is
        // alive and still listening, so this is "idle lease", not "session ended". Sparing it here is
        // both the false "collaborator stepped away" fix and the reclaim→redeliver→re-exit busy-loop
        // fix. A crashed holder's waiter is already gone (req.on('close') → removeWaiter), and a NEW
        // lead after a crash carries a DIFFERENT sessionId, so neither spares a dead holder's lease —
        // that still reclaims and redelivers.
        if (sessionHasWaiter(slot.deliveredBy)) continue;
        dropLease(rid, msg.id); // expired → back to pending for this recipient (deliveredBy kept)
        changedMsg = true;
        reclaimedInRoom = true;
        console.log(`[bridge] lease expired for ${msg.id.slice(0, 8)} @${rid} (holder silent) — reclaimed`);
      }
      if (changedMsg) broadcastMessageState(msg); // now stalled (aggregate for a broadcast)
    }
    if (reclaimedInRoom) {
      serviceWaiters(roomId); // redeliver to any parked poller / surface a revive
      reclaimedAny = true;
    }
  }
  if (reclaimedAny) broadcastAgentStatusIfChanged();
}

// [v9.3 §9 #55] Lead liveness reclaim — the lead's counterpart to the worker sweep, but liveness-
// driven, not clock-driven. A held lead receipt is reclaimed ONLY when its holder is CONFIRMED dead:
// the holder session has no armed listener AND was not seen within LEAD_GRACE_MS. (An armed listener
// or a within-grace touch spares it, which is what keeps a live lead's Send 'working' through the
// wake→re-arm gap and across a normal draw turn.) On confirmed death, for each such receipt:
//   - drop the receipt (inFlight) and CLEAR the delivery marker, so the Send returns to 'queued' —
//     never 'stalled' (the lead has no stalled state);
//   - actively `presence.unregister(deadSid)` (a hard-crashed lead never unregisters itself, so
//     presence.has stays true) and forget its clientKey/transcript, so a reopen registers a
//     genuinely NEW sid rather than rebinding onto the dead one (which would re-block the re-queued
//     receipt — the register handler rebinds while presence.has(old) is true);
//   - re-service parked waiters so a fresh lead already parked drains it at once.
// A same-process re-arm that beats the grace keeps its session (sessionHasWaiter/touch spare it), so
// a live lead's in-flight handling is never dropped.
function sweepDeadLead(): void {
  const now = Date.now();
  let reclaimedAny = false;
  const deadSids = new Set<string>();
  for (const [roomId, arr] of messagesByRoom) {
    let reclaimedInRoom = false;
    for (const msg of arr) {
      if (msg.author.kind !== 'human') continue;
      if (!isAddressedTo(msg, 'lead')) continue;
      if (!holdsLeadReceipt(msg.id)) continue; // only a held lead receipt can be reclaimed
      if (msg.completedAt != null) continue;
      const holder = msg.deliveredBy;
      if (sessionHasWaiter(holder)) continue; // the holder itself re-armed → alive, spare it
      if (holderSeenWithin(holder, msg.deliveredAt, LEAD_GRACE_MS, now)) continue; // holder within grace → still alive
      // Confirmed dead: reclaim to 'queued' (drop the receipt AND clear the delivery marker so the
      // Send is byte-identical to a fresh queued one — no lingering deliveredAt to read as 'stalled').
      dropLease('lead', msg.id);
      delete msg.deliveredAt;
      delete msg.deliveredBy;
      delete msg.receivedAt; // [v9.7 #60] re-queued: no delivery, so no receipt to carry forward
      if (holder) deadSids.add(holder);
      reclaimedInRoom = true;
      reclaimedAny = true;
      console.log(`[bridge] lead receipt for ${msg.id.slice(0, 8)} reclaimed (holder confirmed dead past grace) — re-queued`);
      rewriteMessages(roomId);
      broadcastMessageState(msg); // now 'queued', never 'stalled'
    }
    if (reclaimedInRoom) serviceWaiters(roomId); // redeliver to any fresh lead already parked
  }
  // Unregister the confirmed-dead lead sid(s) AFTER reclaiming, so the next /whiteboard open gets a
  // fresh sid and its re-queued Send drains cleanly to the new lead.
  for (const sid of deadSids) {
    presence.unregister(sid);
    const key = sessionToClientKey.get(sid);
    if (key) {
      clientKeyToSession.delete(key);
      sessionToClientKey.delete(sid);
    }
    sessionToTranscriptPath.delete(sid);
    console.log(`[bridge] unregistered confirmed-dead lead sid ${sid.slice(0, 8)} (fresh sid on reopen)`);
  }
  if (reclaimedAny) broadcastAgentStatusIfChanged();
}

// [v9.7 §8.5 #60] Lost-delivery reclaim — the receipt-ack counterpart to sweepDeadLead. Where
// sweepDeadLead handles a lead that goes silent and dies WITHOUT re-arming (liveness by grace), this
// handles the opposite half-open failure: the lead's delivering socket died silently (a suspended
// laptop, no FIN), the write was lost, yet the SAME session is very much alive and has just re-armed a
// fresh listener. Called at the top of that session's /next-instruction arm, BEFORE the drain: a
// held-but-un-received receipt (deliveredAt, no receivedAt) whose holder is exactly this re-arming
// session is now PROVABLY lost — the poller re-arms only after its prior curl returned/closed, so that
// delivering socket is gone and never acked receipt. Reclaim it to 'queued' (byte-identical to a fresh
// queued Send, mirroring sweepDeadLead) so the drain immediately below re-serves it to THIS very poll.
// Scoped to the arming session's own held receipt: a re-arm only proves ITS prior socket is gone, so a
// different (crashed) predecessor's receipt still waits for sweepDeadLead's grace, unchanged. A receipt
// that WAS acked (normal turn) has receivedAt set and is never touched here — that is what stops the
// re-arm from re-serving a message the lead already consumed (the busy-loop this must not create).
function reclaimLostLeadDeliveries(roomId: string, sessionId: string | null): boolean {
  if (!sessionId) return false; // an anonymous poll cannot prove a prior holder's socket is its own
  let reclaimedAny = false;
  for (const msg of loadMessages(roomId)) {
    if (!isAddressedTo(msg, 'lead')) continue;
    if (msg.deliveredBy !== sessionId) continue; // only THIS session's own held receipt
    if (!holdsUnreceivedLeadReceipt(msg)) continue; // delivered, un-acked, uncompleted, still held
    dropLease('lead', msg.id);
    delete msg.deliveredAt;
    delete msg.deliveredBy;
    // receivedAt is already absent; nothing to clear.
    reclaimedAny = true;
    console.log(`[bridge] lead receipt for ${msg.id.slice(0, 8)} reclaimed (holder re-armed without confirming receipt — delivery lost) — re-queued`);
    rewriteMessages(roomId);
    broadcastMessageState(msg); // now 'queued', never 'stalled'
  }
  if (reclaimedAny) broadcastAgentStatusIfChanged();
  return reclaimedAny;
}

// ---- per-agent status (§7) ---------------------------------------------------------------------
// present(R): a live long-poll waiter exists for R, or a session registered as R was seen within
// STALL_MS. This is what separates 'queued'/'stalled' (present) from 'absent' (dead/never-spawned).
function present(recipientId: string, now: number): boolean {
  if (waitersFor(recipientId).length > 0) return true;
  const sid = clientKeyToSession.get(recipientId);
  if (!sid) return false;
  const seen = lastSeenBySession.get(sid);
  return seen != null && now - seen <= STALL_MS;
}

function lifecycleFor(roomId: string, recipientId: string, now: number): AgentStatus['lifecycle'] {
  const pend = pendingFor(roomId, recipientId);
  if (pend.some((m) => isLeased(recipientId, m.id))) return 'working'; // a held receipt / live lease
  // [v9.3 §9 #55] The LEAD has no 'stalled': alive (armed listener or receipt holder within grace) →
  // 'queued' if a Send waits, else 'idle'; confirmed dead → 'absent'. This tracks leadAlive so the
  // roster and the leadAlive signal agree, and no lead ever shows 'stalled'.
  if (recipientId === 'lead') {
    if (!leadAlive(now)) return 'absent';
    return pend.length > 0 ? 'queued' : 'idle';
  }
  const here = present(recipientId, now);
  if (pend.length > 0) {
    if (!here) return 'absent'; // pending but nobody home — what revival acts on
    // present with unleased pending: stalled if any was delivered-then-reclaimed, else queued
    return pend.some((m) => slotOf(m, recipientId)?.deliveredAt != null) ? 'stalled' : 'queued';
  }
  return here ? 'idle' : 'absent';
}

// Roster = the lead (always) ∪ every live registered worker session ∪ every worker recipient id on
// a pending Send with no registered session (an absent worker). Lead first, then workers by id.
function computeAgents(): AgentStatus[] {
  const roomId = activeRoomId;
  const now = Date.now();
  const ids = new Set<string>(['lead']);
  for (const [key, sid] of clientKeyToSession) {
    if (key === 'everyone') continue;
    if (presence.has(sid)) ids.add(key);
  }
  for (const rid of candidateWorkerIds(roomId)) ids.add(rid);
  const agents: AgentStatus[] = [...ids].map((rid) => ({
    id: rid,
    name: agentDisplayName(rid),
    color: agentColor(rid),
    role: rid === 'lead' ? 'lead' : 'worker',
    parked: waitersFor(rid).length > 0,
    lifecycle: lifecycleFor(roomId, rid, now),
  }));
  agents.sort((a, b) => (a.role === b.role ? a.id.localeCompare(b.id) : a.role === 'lead' ? -1 : 1));
  return agents;
}

// [v6 §4] Broadcast the per-agent status to humans, deduped by value (skip if byte-identical to the
// last one sent) so register/deliver/complete/sweep/waiter churn does not spam the panel.
let lastAgentStatusJson = '';
function broadcastAgentStatusIfChanged(): void {
  const agents = computeAgents();
  const json = JSON.stringify(agents);
  if (json !== lastAgentStatusJson) {
    lastAgentStatusJson = json;
    broadcastToHumans({ type: 'agent-status', agents });
  }
  // [v9.3 §9 #55] leadAlive rides the same transitions that refresh the roster (register/unregister/
  // deliver/complete/park/close and the grace-expiry sweep), pushed as its own frame, deduped by
  // value. Kept OUTSIDE the roster-json early-return so a leadAlive flip still emits even in the rare
  // case the roster json is byte-identical.
  broadcastLeadAliveIfChanged();
}

// [v9.3 §9 #55] One tick drives BOTH reclaim paths: the worker STALL_MS visibility timeout and the
// lead's liveness/grace death-declaration. They are separate functions (lead and worker diverge on
// purpose) but share the cadence.
const sweepTimer = setInterval(() => {
  sweepStalledLeases();
  sweepDeadLead();
}, SWEEP_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

// [v6 §3] Per-recipient long-poll. `?for=<recipientId>` (default 'lead', back-compat) picks the
// queue; `?supervise=1` (the lead only) merges revive directives into the wait. Serves the oldest
// pending Send for that recipient, else parks as a waiter for it. 204 on timeout is a re-arm.
app.get('/next-instruction', (req: Request, res: Response) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  const forId = typeof req.query.for === 'string' && req.query.for ? req.query.for : 'lead';
  const supervise = req.query.supervise === '1' || req.query.supervise === 'true';
  // [v7 #43] `for` is a consumer draining its own queue: it must be an AgentId ('lead' or a
  // registered worker). 'everyone' is a broadcast keyword, not an AgentId — nobody drains it — so
  // isAgentId rejects it here too.
  if (!isAgentId(forId)) {
    res.status(400).json({ error: `unknown recipient id: ${forId}` });
    return;
  }
  touch(sessionId);
  // [v7 #42] ENTANGLEMENT: a lifecycle-monitor sweep run opportunistically on a router call — a
  // poll is a chance to reclaim an expired lease before this recipient's queue is drained below.
  // [v9.3 §9 #55] Also run the lead reclaim, so a fresh lead polling after its predecessor crashed
  // reclaims the dead holder's receipt (and re-queues it) before draining its own queue below.
  sweepStalledLeases();
  sweepDeadLead();
  // [v9.7 §8.5 #60] Lost-delivery reclaim. This is the lead re-arming: if it holds a receipt that was
  // delivered to a now-gone socket but never receipt-acked, that delivery was lost — reclaim it so the
  // drain below re-serves it to this very poll (curing the strand). Scoped to the lead's own session;
  // a received-acked receipt is untouched, so a normal turn's re-arm never re-serves a consumed Send.
  if (forId === 'lead') reclaimLostLeadDeliveries(activeRoomId, sessionId);

  // 1) This recipient's own oldest pending Send (the lead's own work outranks a revive, §5).
  const msg = nextPendingFor(activeRoomId, forId);
  if (msg) {
    markDelivered(msg, forId, sessionId);
    console.log(`[bridge] /next-instruction served a pending Send for '${forId}' (drain)`);
    res.json(instructionPayload(msg, forId));
    broadcastAgentStatusIfChanged();
    return;
  }

  // 1b) [v9.1 §9 #53] Supervisor: the operator pressed the confirm-gated close affordance for this
  //     room → the teardown directive (the operator's only deliberate close signal). Outranks a
  //     revive; the lead performs the graceful /done. Cleared on consumption so a re-arm does not
  //     re-issue it.
  if (supervise && isTeardownRequested(activeRoomId)) {
    clearTeardownRequested(activeRoomId);
    console.log(`[bridge] /next-instruction?supervise served teardown directive for '${activeRoomId}'`);
    res.json(teardownDirectiveFor(activeRoomId));
    return;
  }

  // 2) Supervisor: a worker with a pending Send and no live poller → a revive directive.
  if (supervise) {
    const target = workerNeedingRevive(activeRoomId);
    if (target) {
      openReviveGrace(target.revive);
      console.log(`[bridge] /next-instruction?supervise served revive directive for ${target.revive}`);
      res.json(target);
      broadcastAgentStatusIfChanged();
      return;
    }
  }

  // 3) Park as a waiter for this recipient. Parking is proof this recipient is present, so clear any
  //    revive grace it was under (revival succeeded).
  clearReviveGrace(forId);
  const timer = setTimeout(() => {
    const i = waiters.findIndex((w) => w.res === res);
    if (i !== -1) {
      waiters.splice(i, 1);
      broadcastParkedIfChanged();
      broadcastAgentStatusIfChanged();
    }
    res.status(204).end();
  }, LONGPOLL_MS);
  const waiter: Waiter = { res, timer, sessionId, recipientId: forId, supervise };
  waiters.push(waiter);
  broadcastParkedIfChanged();
  broadcastAgentStatusIfChanged();
  req.on('close', () => {
    if (removeWaiter(waiter)) {
      clearTimeout(timer);
      broadcastParkedIfChanged();
      broadcastAgentStatusIfChanged();
    }
  });
});

// [v9.7 §8.5 #60] Receipt ack: the lead's consumer-side confirmation that it actually took a
// delivered Send off the socket. `{ id, for? }` (`for` defaults to 'lead'). poll.sh POSTs this on a
// 200, BEFORE it exits (the exit is the wake), so a delivery lost to a half-open socket — where this
// ack never arrives — is distinguishable from a consumed one (`reclaimLostLeadDeliveries`). This is
// NOT completion: it sits between deliveredAt and completedAt (receipt, not "handled"). Idempotent
// (a repeat is a no-op success), unknown id -> 404, un-delivered id -> ok:true no-op (nothing to
// confirm). Lead-only in effect: workers keep the STALL_MS lease clock and ignore this ack. It never
// changes SendState (a received lead Send still reads 'working'); it only records the confirmation
// and refreshes the holder's liveness (receiving is proof of life).
app.post('/instruction-received', (req: Request, res: Response) => {
  const { id, for: forRaw, deliveredAt: ackDeliveredAt } = (req.body ?? {}) as { id?: unknown; for?: unknown; deliveredAt?: unknown };
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'body.id (string) required' });
    return;
  }
  const forId = typeof forRaw === 'string' && forRaw ? forRaw : 'lead';
  if (!isAgentId(forId)) {
    res.status(400).json({ error: `unknown recipient id: ${forId}` });
    return;
  }
  const msg = loadMessages(activeRoomId).find((m) => m.id === id);
  if (!msg) {
    res.status(404).json({ error: 'unknown instruction id' });
    return;
  }
  const slot = writableSlotOf(msg, forId);
  touch(slot.deliveredBy); // receiving is proof this recipient is alive and listening
  if (slot.deliveredAt == null) {
    // Nothing was delivered to confirm — a no-op success (e.g. an ack racing a reclaim).
    res.json({ ok: true, id, noDelivery: true });
    return;
  }
  // [v9.7 §8.5 #60] Scope the ack to the delivery it names. If the ack carries a deliveredAt nonce
  // that does not match the slot's current delivery, it is a STALE ack for a superseded delivery (the
  // Send was reclaimed and re-served since) — a no-op, so it can never mark a later, still-in-flight
  // (possibly lost) delivery as received. An ack without the nonce (older poller) is accepted as-is.
  if (typeof ackDeliveredAt === 'number' && ackDeliveredAt !== slot.deliveredAt) {
    res.json({ ok: true, id, staleDelivery: true });
    return;
  }
  if (slot.receivedAt != null) {
    res.json({ ok: true, id, alreadyReceived: true });
    return;
  }
  slot.receivedAt = Date.now();
  rewriteMessages(activeRoomId);
  console.log(`[bridge] instruction ${id.slice(0, 8)} receipt-acked by '${forId}'`);
  res.json({ ok: true, id });
});

// [v6 §3/§6] Completion ack: the durable gate. `{ id, for? }` (`for` defaults to 'lead'). Non-
// broadcast: stamp top-level completedAt (v5 behavior), drop the lease. Broadcast: stamp
// delivery[for].completedAt, drop that recipient's lease, and set top-level completedAt only once
// EVERY broadcastTo entry has completed. Idempotent (repeat => alreadyComplete); unknown id -> 404.
app.post('/instruction-complete', (req: Request, res: Response) => {
  const { id, for: forRaw } = (req.body ?? {}) as { id?: unknown; for?: unknown };
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'body.id (string) required' });
    return;
  }
  const forId = typeof forRaw === 'string' && forRaw ? forRaw : 'lead';
  // [v7 #43] Validate the recipient AFTER the id-required 400 and BEFORE the message lookup, so an
  // unknown recipient is a 400 while an unknown message id stays a 404.
  if (!isAgentId(forId)) {
    res.status(400).json({ error: `unknown recipient id: ${forId}` });
    return;
  }
  const msg = loadMessages(activeRoomId).find((m) => m.id === id);
  if (!msg) {
    res.status(404).json({ error: 'unknown instruction id' });
    return;
  }

  if (msg.recipient?.kind === 'broadcast') {
    // A completion for a recipient outside this broadcast's snapshot is a no-op success.
    if (!(msg.broadcastTo ?? []).includes(forId)) {
      res.json({ ok: true, id });
      return;
    }
    const slot = writableSlotOf(msg, forId);
    touch(slot.deliveredBy); // completing is proof this recipient is alive
    dropLease(forId, id);
    if (slot.completedAt != null) {
      res.json({ ok: true, id, alreadyComplete: true });
      return;
    }
    slot.completedAt = Date.now();
    // Aggregate: top-level completedAt lands only when every recipient has completed its entry.
    if ((msg.broadcastTo ?? []).every((rid) => msg.delivery?.[rid]?.completedAt != null) && msg.completedAt == null) {
      msg.completedAt = Date.now();
    }
    rewriteMessages(activeRoomId);
    broadcastMessageState(msg);
    console.log(`[bridge] broadcast ${id.slice(0, 8)} completed for '${forId}'`);
    broadcastAgentStatusIfChanged();
    res.json({ ok: true, id });
    return;
  }

  // Non-broadcast: `for` is immaterial (one recipient); drop that recipient's lease.
  const rid = recipientIdOf(msg);
  touch(msg.deliveredBy); // [v5.1] completing is proof the deliverer is alive
  dropLease(rid, id);
  if (msg.completedAt != null) {
    res.json({ ok: true, id, alreadyComplete: true });
    return;
  }
  msg.completedAt = Date.now();
  rewriteMessages(activeRoomId);
  broadcastMessageState(msg);
  console.log(`[bridge] instruction ${id.slice(0, 8)} completed`);
  broadcastAgentStatusIfChanged();
  res.json({ ok: true, id });
});

// [v6 §3; v9.1 #43] Parse an optional recipient off a Send body. The result DISTINGUISHES absent
// from present-but-invalid (the v9.1 hardening of #43): a silently-dropped malformed recipient used
// to default to the lead with a 200, so a client bug (a bare string, a bad `kind`) misaddressed a
// Send to the lead instead of being told. Now:
//   - ABSENT (field omitted, or explicit null) => { ok:true } with no recipient: addressed to the
//     lead, the v5 default. Unchanged on the wire and in the JSONL.
//   - PRESENT but malformed (not an object, an array, a bad/missing `kind`, or kind:'worker' with a
//     missing/non-string id) => { ok:false, error } so /message answers 400, never a silent default.
//   - A 'lead' recipient with no id/name normalizes to no recipient (byte-identical to a plain v5
//     lead Send).
// A well-formed { kind:'worker', id } with an UNKNOWN id is structurally valid here (ok:true); the
// roster-bound 400 for an unknown id stays at the /message seam via isAgentId (#43), so "malformed
// shape" (this function) and "unknown agent" (isAgentId) remain distinct 400s.
type ParsedRecipient = { ok: true; recipient?: Recipient } | { ok: false; error: string };
function parseRecipient(raw: unknown): ParsedRecipient {
  if (raw === undefined || raw === null) return { ok: true };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `invalid recipient: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}` };
  }
  const r = raw as { kind?: unknown; id?: unknown; name?: unknown };
  if (r.kind !== 'lead' && r.kind !== 'worker' && r.kind !== 'broadcast') {
    return { ok: false, error: `invalid recipient: kind must be "lead"|"worker"|"broadcast", got ${JSON.stringify(r.kind)}` };
  }
  if (r.kind === 'worker' && !(typeof r.id === 'string' && r.id)) {
    return { ok: false, error: 'invalid recipient: kind "worker" requires a non-empty string id' };
  }
  const out: Recipient = { kind: r.kind };
  if (typeof r.id === 'string' && r.id) out.id = r.id;
  if (typeof r.name === 'string' && r.name) out.name = r.name;
  if (out.kind === 'lead' && !out.id && !out.name) return { ok: true };
  return { ok: true, recipient: out };
}

// [v6 §3] Snapshot the currently-registered WORKER recipient ids (a live session whose clientKey is
// a recipient id other than the reserved 'lead'/'everyone'). Frozen into a broadcast's broadcastTo
// at send time; empty (no workers) => the broadcast is vacuously done.
function currentWorkerRecipientIds(): string[] {
  const ids = new Set<string>();
  for (const [key, sid] of clientKeyToSession) {
    if (key === 'lead' || key === 'everyone') continue;
    if (presence.has(sid)) ids.add(key);
  }
  return [...ids];
}

// [v4 §8.2] Idempotency across Send / agent voice is now the stored message `id` itself
// (persistent, survives reloads), replacing the old short-window TTL dedupe.
app.post('/message', (req: Request, res: Response) => {
  const { text, selection, idempotencyKey, name, recipient } = (req.body ?? {}) as {
    text?: unknown;
    selection?: unknown;
    idempotencyKey?: unknown;
    name?: unknown;
    recipient?: unknown;
  };
  // id == idempotencyKey (§8.2). If the client sends none, mint a stable id so the message is
  // still captured; dedupe is only possible when the client supplies a key.
  const id = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : randomUUID();
  if (hasMessage(activeRoomId, id)) {
    res.json({ ok: true, deduped: true });
    return;
  }
  const cleanText = typeof text === 'string' ? text : '';
  const cleanSelection = Array.isArray(selection) ? selection.filter((s): s is string => typeof s === 'string') : [];
  const humanName = typeof name === 'string' && name.trim() ? name.trim() : 'You';
  const message: Message = {
    id,
    room: activeRoomId,
    ts: Date.now(),
    author: { kind: 'human', name: humanName },
    text: cleanText,
    selection: cleanSelection,
  };
  // [v6 §3; v9.1 #43] Route the Send. Parse the recipient first: a present-but-malformed recipient
  // (non-object, bad `kind`, worker with no id) is a 400 here (no longer silently defaulted to the
  // lead), while an absent recipient parses to no recipient (addressed to the lead). A broadcast
  // snapshots the current worker roster into broadcastTo and inits an empty per-recipient delivery
  // map; it then fans into each worker's pending projection.
  const parsed = parseRecipient(recipient);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const rcpt = parsed.recipient;
  // [v7 #43] A well-formed `worker` recipient MUST also carry a KNOWN AgentId — typing a new name
  // does not conjure a worker. parseRecipient guaranteed a non-empty id; isAgentId is the roster
  // bound (an unknown id is a distinct 400 from a malformed shape). `lead`/absent and `everyone`
  // (kind:'broadcast') carry no AgentId to check.
  if (rcpt?.kind === 'worker' && !isAgentId(rcpt.id as string)) {
    res.status(400).json({ error: `unknown recipient id: ${rcpt.id ?? '(none)'}` });
    return;
  }
  if (rcpt) {
    message.recipient = rcpt;
    if (rcpt.kind === 'broadcast') {
      message.broadcastTo = currentWorkerRecipientIds();
      message.delivery = {};
    }
  }
  appendMessage(message);
  // [v5 §8.5] The stored Message IS the durable pending item. deliverInstruction services parked
  // waiters (delivering to the addressed recipient(s), and waking a supervisor for a dead worker),
  // else does nothing extra (no in-memory queue). Also broadcast to human peers so a second browser
  // / reloaded panel sees the Send (mirrors /agent-message).
  broadcastToHumans({ type: 'message', message });
  deliverInstruction(message);
  broadcastAgentStatusIfChanged();
  res.json({ ok: true, id });
});

// [v4 §8.2] Panel read model: full history (or the tail after `since`) ascending by ts.
app.get('/messages', (req: Request, res: Response) => {
  const room = typeof req.query.room === 'string' && req.query.room ? req.query.room : activeRoomId;
  const sinceRaw = req.query.since;
  const since = typeof sinceRaw === 'string' && sinceRaw !== '' ? Number(sinceRaw) : null;
  const all = loadMessages(room);
  const filtered = since !== null && Number.isFinite(since) ? all.filter((m) => m.ts > since) : all;
  // [v5.1] Attach the authoritative lifecycle state so the panel seeds badges correctly on load.
  const messages = [...filtered].sort((a, b) => a.ts - b.ts).map((m) => ({ ...m, state: sendState(m) }));
  res.json({ messages });
});

// [v9.1 §8.2/§9 #53] Operator teardown-request intake. A CONTROL signal, not a chat Message: the
// drawer's confirm-gated close-session affordance POSTs here (never /message), so it never enters
// the attributed log or a recipient queue. Sets the per-room teardownRequested flag and wakes a
// parked supervisor (the lead) via serviceWaiters with the teardown directive; if none is parked
// yet, the next supervise poll surfaces it. Idempotent — setting it twice is a no-op 200. `room`
// optional: defaults to this process's single active board.
app.post('/request-teardown', (req: Request, res: Response) => {
  const { room } = (req.body ?? {}) as { room?: unknown };
  const roomId = typeof room === 'string' && room ? room : activeRoomId;
  setTeardownRequested(roomId);
  console.log(`[bridge] teardown requested for room '${roomId}'`);
  serviceWaiters(roomId);
  res.json({ ok: true });
});

// ===========================================================================
// SHAPES / EXEC / IMAGE relays to the render-canvas (SPEC §5/§6, FIX 4B)
// ===========================================================================
app.get('/shapes', async (req: Request, res: Response) => {
  touch(typeof req.query.sessionId === 'string' ? req.query.sessionId : null); // [v5.1] perceiving keeps the lease alive
  try {
    const result = await wsRequest<unknown>('get-shapes');
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

// Execs serialize on the one render-canvas Editor (SPEC §4).
let execChain: Promise<unknown> = Promise.resolve();
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = execChain.then(fn, fn) as Promise<T>;
  execChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type ExecResult = { ok: boolean; result?: unknown; error?: string; image: string | null };
type ExecRelayResult = { ok: boolean; result?: unknown; error?: string };

// Idempotency cache: key -> in-flight/completed exec promise (FIX 4B). A duplicate key
// returns the SAME result without re-running the blob; a transport failure is not
// cached, so a genuine retry re-runs.
const EXEC_IDEM_TTL_MS = 5 * 60_000;
const EXEC_IDEM_MAX = 500;
const execIdem = new Map<string, { at: number; promise: Promise<ExecResult> }>();

function pruneExecIdem(): void {
  const now = Date.now();
  for (const [k, v] of execIdem) {
    if (now - v.at > EXEC_IDEM_TTL_MS) execIdem.delete(k);
  }
  while (execIdem.size > EXEC_IDEM_MAX) {
    const first = execIdem.keys().next().value as string | undefined;
    if (first === undefined) break;
    execIdem.delete(first);
  }
}

// [v5 §8.6] Resolve the exec's author identity from the registered session (name/color),
// carried on the exec frame so the app stamps meta.createdBy/lastEditedBy. Unknown session ->
// { kind:'agent', sessionId, name:'Claude', color: undefined }. The server never stamps meta.
function resolveExecAuthor(sessionId: string | null): ExecAuthor {
  const info = sessionId ? presence.info(sessionId) : undefined;
  return { kind: 'agent', sessionId, name: info?.name ?? 'Agent', color: info?.color };
}

// [v9.5 §5] Honest /exec contract + per-exec sync-corruption detection.
//
// The bug (SPEC §5): a schema-invalid record makes tldraw flag the render-canvas store as
// possiblyCorrupted; while that sticky flag is set the sync client silently suppresses EVERY
// outbound push, so later well-formed execs return ok:true, render locally, and never reach the
// authoritative room. `ok:true` must therefore mean "confirmed present in the room", not merely
// "the blob ran". After the exec relay we wait a bounded window for the room to reflect the write
// (documentClock advance preferred, shape-count delta as fallback); only if it does NOT do we pay a
// sync-health round-trip. A corrupted or disconnected store means the write was severed: report
// ok:false and hand off to server-owned recovery (recoverCorruptedCanvas).
const SYNC_CONFIRM_TIMEOUT_MS = 1500; // bounded wait for the room to reflect a write; tune here
const SYNC_CONFIRM_POLL_MS = 50;
const SYNC_HEALTH_TIMEOUT_MS = 1200; // WS budget for one sync-health probe (only on a non-advancing exec)
// Escape hatch: disable the whole detect+recover path (reverts to the pre-v9.5 behavior). Exists so
// the regression test can prove the guard bites (run with it set → the poison silently freezes the
// board), and as an interim safety valve if the app half of the contract is not yet deployed.
const SYNC_GUARD_DISABLED = !!process.env.WHITEBOARD_NO_SYNC_GUARD;

type SyncHealth = { possiblyCorrupted: boolean; connectedToRoom: boolean; speculativeAdded: number; lastServerClock: number | null };

// The room's authoritative document version. Advances on any document-scope change a peer pushes,
// so a create-only exec bumps it; a read/camera-move exec does not. Preferred "reached room" signal.
function roomDocumentClock(roomId: string): number {
  const entry = rooms.get(roomId);
  if (!entry) return 0;
  try {
    return entry.room.getCurrentDocumentClock();
  } catch {
    return 0;
  }
}

// Poll until the room reflects the write (clock advanced, or shape count grew as a fallback for
// stores whose clock read is unavailable), or the bounded window elapses. Returns whether it landed.
async function waitForRoomAdvance(roomId: string, preClock: number, preShapes: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (roomDocumentClock(roomId) > preClock) return true;
    if (roomShapeCount(roomId) > preShapes) return true;
    if (Date.now() >= deadline) return false;
    await delay(SYNC_CONFIRM_POLL_MS);
  }
}

// Ask the render-canvas for its store's sync health. Returns null when the probe is unanswered
// (an app build without the sync-health handler, or a canvas that just dropped): the caller then
// falls back to the room-advance signal alone rather than treating silence as corruption.
async function probeSyncHealth(): Promise<SyncHealth | null> {
  try {
    return await wsRequest<SyncHealth>('sync-health', {}, SYNC_HEALTH_TIMEOUT_MS);
  } catch (e) {
    console.warn('[bridge] sync-health probe failed:', (e as Error).message);
    return null;
  }
}

function runExec(code: string, sessionId: string | null): Promise<ExecResult> {
  return runExclusive<ExecResult>(async () => {
    const known = sessionId && presence.has(sessionId) ? sessionId : null;
    if (known) presence.setState(known, 'drawing');
    try {
      const roomId = activeRoomId;
      const preClock = roomDocumentClock(roomId);
      const preShapes = roomShapeCount(roomId);
      const exec = await wsRequest<ExecRelayResult>('exec', { code, author: resolveExecAuthor(sessionId) });

      let ok = exec.ok;
      let error = exec.error;
      if (!SYNC_GUARD_DISABLED) {
        // The exec-result is not proof the write reached the room. Confirm it, and only pay a
        // health probe when the room did not move (keeps a healthy write's added latency to the
        // advance poll alone; a non-mutating exec pays the full window once).
        const advanced = await waitForRoomAdvance(roomId, preClock, preShapes, SYNC_CONFIRM_TIMEOUT_MS);
        if (!advanced) {
          const health = await probeSyncHealth();
          const corrupted = health?.possiblyCorrupted === true;
          const disconnected = health !== null && !health.connectedToRoom;
          if (corrupted || (exec.ok && disconnected)) {
            // The write did not reach the room: the store is corrupted (push suppressed) or the
            // canvas is not joined. Report it honestly, then repair so the next write lands.
            ok = false;
            if (!error) error = 'sync-severed';
            await recoverCorruptedCanvas(roomId, corrupted ? 'a corrupted canvas store' : 'a severed sync connection');
          }
          // else: healthy + connected (or no probe available) → a legitimately non-document-mutating
          // exec (a read, a selection, a camera move). Leave exec.ok untouched.
        }
      }

      let image: string | null = null;
      try {
        image = await requestImage();
      } catch (e) {
        console.warn('[bridge] post-exec image failed:', (e as Error).message);
      }
      return { ok, result: exec.result, error, image };
    } finally {
      if (known) presence.setState(known, 'idle');
    }
  });
}

app.post('/exec', async (req: Request, res: Response) => {
  const { code, sessionId, idempotencyKey } = (req.body ?? {}) as {
    code?: unknown;
    sessionId?: unknown;
    idempotencyKey?: unknown;
  };
  if (typeof code !== 'string') {
    res.status(400).json({ ok: false, error: 'body.code (string) required' });
    return;
  }
  const sid = typeof sessionId === 'string' ? sessionId : null;
  const key = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : null;
  touch(sid); // [v5.1] an exec is proof the lead is alive — keep its lease valid

  if (key) {
    const existing = execIdem.get(key);
    if (existing) {
      try {
        res.json(await existing.promise);
      } catch (e) {
        res.status(503).json({ ok: false, error: (e as Error).message });
      }
      return;
    }
  }

  const promise = runExec(code, sid);
  if (key) {
    execIdem.set(key, { at: Date.now(), promise });
    pruneExecIdem();
  }
  try {
    res.json(await promise);
  } catch (e) {
    if (key) execIdem.delete(key); // transport failure: allow a real retry to re-run
    res.status(503).json({ ok: false, error: (e as Error).message });
  }
});

// [render-cap] Parse an optional ?bounds=x,y,w,h (page coords) into an ExportRegion.
// Malformed or non-positive input ⇒ undefined (a whole-board bird's-eye), never a 400 —
// a bad region should degrade to the safe default, not fail perception.
// MIRROR of App.tsx's parseRegion — keep the two validators in sync (see the ExportRegion
// type comment above).
function parseBoundsParam(v: unknown): ExportRegion | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const parts = v.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = parts as [number, number, number, number];
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

app.get('/image', async (req: Request, res: Response) => {
  touch(typeof req.query.sessionId === 'string' ? req.query.sessionId : null); // [v5.1] perceiving keeps the lease alive
  // [render-cap] ?bounds=x,y,w,h zooms in on a region; absent ⇒ downscaled whole-board bird's-eye.
  const bounds = parseBoundsParam(req.query.bounds);
  try {
    const p = await requestImage(WS_REQUEST_TIMEOUT_MS, bounds);
    // Echo the region that was actually applied (null = whole-board bird's-eye). A caller that
    // asked for a crop but typo'd its ?bounds= gets the overview back; without this echo it had
    // no way to tell its region was silently dropped and could "read" the wrong frame — the
    // #61 silent-wrong-frame hazard, reappearing for regions. Additive, within the 200 contract.
    res.json({ path: p, bounds: bounds ?? null });
  } catch (e) {
    res.status(503).json({ error: (e as Error).message });
  }
});

app.post(
  '/image-upload',
  express.raw({ type: ['image/png', 'application/octet-stream'], limit: '32mb' }),
  async (req: Request, res: Response) => {
    const idParam = req.query.id;
    const id = typeof idParam === 'string' ? idParam : req.get('X-Request-Id') ?? null;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'expected raw PNG body' });
      return;
    }
    const outPath = imagePathFor(activeBoardPath);
    try {
      await fsp.writeFile(outPath, req.body);
      latestImagePath = outPath;
      // [#61 §6.1] A real (re)write just happened — record it as the export-health ground truth so
      // /canvas-status can attest freshness, and resolve the waiter with this path (never a stale one).
      lastExportOk = true;
      lastExportError = null;
      lastExportAt = Date.now();
      lastImageMtime = lastExportAt;
      lastImageBytes = req.body.length;
      resolveImage(id, outPath);
      console.log(`[bridge] image written: ${outPath} (${req.body.length}b)`);
      res.json({ ok: true, path: outPath });
    } catch (e) {
      // [#61 §6.1] The write itself failed (disk full, EACCES). The app's uploadImage does not check
      // response.ok, so it will still send an ok:true frame that no-ops here — without this the /image
      // waiter would hang to WS_REQUEST_TIMEOUT_MS (15s) and health would keep reading the last good
      // value. Reject the waiter promptly AND record the failure so the stall is both fast and visible.
      const err = (e as Error).message;
      lastExportOk = false;
      lastExportError = `image-upload write failed: ${err}`;
      lastExportAt = Date.now();
      rejectImage(id, `image-upload write failed: ${err}`);
      console.warn(`[bridge] image-upload write failed: ${err}`);
      res.status(500).json({ error: err });
    }
  },
);

app.post('/agent-message', (req: Request, res: Response) => {
  const { text, sessionId, idempotencyKey } = (req.body ?? {}) as {
    text?: unknown;
    sessionId?: unknown;
    idempotencyKey?: unknown;
  };
  if (typeof text !== 'string') {
    res.status(400).json({ error: 'body.text (string) required' });
    return;
  }
  const sid = typeof sessionId === 'string' ? sessionId : null;
  touch(sid); // [v5.1] an utterance is proof the lead is alive — keep its lease valid
  const id = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey : randomUUID();
  if (hasMessage(activeRoomId, id)) {
    res.json({ ok: true, deduped: true });
    return;
  }
  // [v4 §8.2] Store the agent utterance attributed to the registered session (name/color).
  const info = sid ? presence.info(sid) : undefined;
  const author: MessageAuthor = { kind: 'agent', name: info?.name ?? 'Agent' };
  if (sid) author.sessionId = sid;
  if (info?.color) author.color = info.color;
  const message: Message = { id, room: activeRoomId, ts: Date.now(), author, text };
  appendMessage(message);

  // [v4 §8.2] Carry id/ts/name on the frame so a reconnect GET ?since= dedups this
  // live line by id instead of re-appending it.
  const frame: FrameToApp = { type: 'agent-message', text, sessionId: sid, id: message.id, ts: message.ts, name: author.name };
  // Operators read the log in their own browser (role=human); the headless render-canvas
  // gets it too so its (invisible) log stays consistent.
  const humans = broadcastToHumans(frame);
  sendToRenderCanvas(frame);
  res.json({ ok: true, humans });
});

// ===========================================================================
// PERSISTENCE endpoints — legacy no-ops (SPEC §8: sync server owns persistence)
// ===========================================================================
app.post('/snapshot', (_req: Request, res: Response) => {
  res.json({ ok: true, noop: true });
});

app.get('/snapshot', async (req: Request, res: Response) => {
  const target = req.query.path ? path.resolve(String(req.query.path)) : activeBoardPath;
  try {
    const raw = await fsp.readFile(target, 'utf8');
    res.json({ document: JSON.parse(raw) });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') res.status(404).json({ error: 'board not found', path: target });
    else res.status(500).json({ error: err.message });
  }
});

// ===========================================================================
// BOARD open / new / discovery (SPEC §8)
// ===========================================================================
async function switchRoom(roomId: string, boardPath: string): Promise<void> {
  const prevRoom = activeRoomId;
  activeRoomId = roomId;
  activeBoardPath = boardPath;
  slugToPath.set(roomId, boardPath);
  latestImagePath = imagePathFor(boardPath);
  // Keep the lockfile pointing at the board this process actually hosts.
  if (prevRoom !== roomId) removeLock(prevRoom);
  writeLock();
  getOrCreateRoom(roomId);
  presence.switchRoom(roomId); // rebuild agent cursors against the new room
  await navigateRenderCanvas(roomId);
}

app.post('/board/open', async (req: Request, res: Response) => {
  const { path: p } = (req.body ?? {}) as { path?: unknown };
  if (typeof p !== 'string' || !p) {
    res.status(400).json({ error: 'body.path required' });
    return;
  }
  const boardPath = path.resolve(p);
  const roomId = boardName(boardPath);
  // [v8 §8.3] One server per board. If a live foreign process already hosts this board, DO NOT
  // switch in-process (that would steal its lock -> split-brain). Hand the client that process's
  // port so it attaches there instead. Unowned / stale-locked / our-own-board => switch in-process.
  const owner = await liveForeignOwner(roomId);
  if (owner) {
    console.log(`[bridge] board open -> '${roomId}' already live at port ${owner.port} (pid ${owner.pid}); attach, do not steal`);
    res.json({ ok: true, attach: true, port: owner.port, path: boardPath, room: roomId });
    return;
  }
  await switchRoom(roomId, boardPath);
  console.log(`[bridge] board open -> ${boardPath} (room '${roomId}')`);
  res.json({ ok: true, attach: false, path: boardPath, room: roomId });
});

app.post('/board/new', async (req: Request, res: Response) => {
  const { name } = (req.body ?? {}) as { name?: unknown };
  if (typeof name !== 'string' || !name) {
    res.status(400).json({ error: 'body.name required' });
    return;
  }
  const safe = name.replace(/[^\w.-]+/g, '-');
  const boardPath = path.join(HOME, `${safe}.tldr`);
  // [v8 §8.3] Same one-server guard as /board/open: a "new" board whose name collides with a
  // live board must attach to that owner, never steal its lock.
  const owner = await liveForeignOwner(safe);
  if (owner) {
    console.log(`[bridge] board new -> '${safe}' collides with a live board at port ${owner.port} (pid ${owner.pid}); attach, do not steal`);
    res.json({ ok: true, attach: true, port: owner.port, path: boardPath, room: safe });
    return;
  }
  await switchRoom(safe, boardPath);
  console.log(`[bridge] board new -> ${boardPath} (room '${safe}')`);
  res.json({ ok: true, attach: false, path: boardPath, room: safe });
});

type BoardListing = { name: string; path: string; source: 'home' | 'repo' };

async function listHomeBoards(): Promise<BoardListing[]> {
  const out: BoardListing[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(HOME);
  } catch {
    /* home may be empty */
  }
  for (const e of entries) {
    if (e.endsWith('.tldr')) out.push({ name: boardName(e), path: path.join(HOME, e), source: 'home' });
  }
  return out;
}

async function walkForTldr(dir: string, acc: string[], depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walkForTldr(full, acc, depth + 1);
    else if (ent.isFile() && ent.name.endsWith('.tldr')) acc.push(full);
  }
}

app.get('/boards', async (_req: Request, res: Response) => {
  const byPath = new Map<string, BoardListing>();
  for (const b of await listHomeBoards()) byPath.set(b.path, b);
  const repoHits: string[] = [];
  await walkForTldr(REPO_ROOT, repoHits);
  for (const full of repoHits) {
    if (!byPath.has(full)) byPath.set(full, { name: boardName(full), path: full, source: 'repo' });
  }
  res.json([...byPath.values()]);
});

// ===========================================================================
// PLAYWRIGHT render-canvas (SPEC §3, §11)
// ===========================================================================
let browser: Browser | null = null;
let canvasPage: Page | null = null;
let canvasRoom: string | null = null;
// [render-cap] Re-entry guard for the silent crash-relaunch below.
let renderCanvasRestarting = false;

const canvasUrl = (roomId: string): string => `http://${HOST}:${assignedPort}/?role=agent&room=${encodeURIComponent(roomId)}`;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// How many shape records the room's authoritative snapshot currently holds.
function roomShapeCount(roomId: string): number {
  const entry = rooms.get(roomId);
  if (!entry) return 0;
  try {
    return entry.room.getCurrentSnapshot().documents.filter((d) => d.state.typeName === 'shape').length;
  } catch {
    return 0;
  }
}

async function waitForCanvasSocket(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (renderCanvasSocket && renderCanvasSocket.readyState === WebSocket.OPEN) return;
    await delay(200);
  }
}

// Count rendered tldraw shape nodes in the canvas page. tldraw culls off-screen shapes,
// so this is a "> 0" liveness signal, not an exact count. Runs in the browser context.
async function countRenderedShapes(): Promise<number> {
  if (!canvasPage) return 0;
  try {
    return await canvasPage.evaluate((): number => {
      const doc = (globalThis as unknown as { document?: { querySelectorAll(sel: string): { length: number } } }).document;
      return doc ? doc.querySelectorAll('.tl-shape').length : 0;
    });
  } catch {
    return 0;
  }
}

// Boot-race guard (confirmed failure mode): the boot-launched render-canvas can connect
// to /sync BEFORE the room's initialSnapshot is applied and then sit permanently EMPTY,
// even though the room holds shapes. Late-joining pages are unaffected. So after loading
// the canvas, if the room has shapes, verify the canvas actually rendered some; if not,
// reload-and-retry (up to 3 attempts). An empty room legitimately renders 0.
async function verifyCanvasSynced(roomId: string, context: string): Promise<void> {
  if (!canvasPage) return;
  const expected = roomShapeCount(roomId);
  if (expected === 0) {
    console.log(`[canvas] ${context}: room '${roomId}' has no shapes; empty canvas is correct`);
    return;
  }
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForCanvasSocket(5_000);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const rendered = await countRenderedShapes();
      if (rendered > 0) {
        console.log(`[canvas] ${context}: synced — rendered ${rendered} shape node(s) (room has ${expected})`);
        return;
      }
      await delay(400);
    }
    if (attempt < MAX_ATTEMPTS) {
      console.log(`[canvas] sync incomplete, reloading (attempt ${attempt})`);
      try {
        await canvasPage.reload({ waitUntil: 'domcontentloaded' });
      } catch (e) {
        console.warn(`[canvas] reload failed: ${(e as Error).message}`);
      }
    }
  }
  console.warn(`[canvas] ${context}: sync still incomplete after ${MAX_ATTEMPTS} attempts; proceeding (room has ${expected} shapes)`);
}

// ===========================================================================
// SERVER-OWNED SYNC-CORRUPTION RECOVERY (SPEC §5 [v9.5])
// ===========================================================================
// store.isPossiblyCorrupted() is sticky with no public reset (@tldraw/store), so the only cure for
// a severed render-canvas is a fresh store: reload the canvas, let it re-hydrate from the room, then
// reapply the shapes we harvested first (the severed write lives only in the local store, never
// pushed) so they finally reach the room. Idempotent (create-or-update keyed by shape id), bounded
// (RECOVERY_MAX_ATTEMPTS per incident, then surface loudly instead of looping a reload), and
// serialized: callers already hold runExclusive, so this uses the low-level WS helpers directly and
// never re-enters the mutex.
const RECOVERY_MAX_ATTEMPTS = 2;
const RECOVERY_COOLDOWN_MS = 1000;
const RECOVERY_REHYDRATE_TIMEOUT_MS = 6000;
const recovering = new Map<string, boolean>();

// Post a system line into the operator's panel log and the render-canvas (same path as
// /agent-message), so a recovery or its failure is visible rather than silent.
function postSystemMessage(text: string): void {
  const id = randomUUID();
  const author: MessageAuthor = { kind: 'agent', name: 'Whiteboard' };
  const message: Message = { id, room: activeRoomId, ts: Date.now(), author, text };
  appendMessage(message);
  const frame: FrameToApp = { type: 'agent-message', text, sessionId: null, id, ts: message.ts, name: author.name };
  broadcastToHumans(frame);
  sendToRenderCanvas(frame);
}

// The blob recovery reapplies through the SAME exec relay a normal write uses. store.put replaces by
// id, so a shape that already re-hydrated from the room is a no-op and only the severed one lands;
// deterministic ids (SPEC §4) mean a re-run cannot duplicate.
function reapplyBlob(shapes: unknown[]): string {
  return `const __recs = ${JSON.stringify(shapes)};\nif (Array.isArray(__recs) && __recs.length) editor.store.put(__recs);`;
}

// Force a fresh render-canvas store. In production the canvas is a server-owned Playwright page, so a
// reload loads a clean store that re-hydrates from the room. With no page (the headless test harness,
// or an externally-driven canvas) the bridge's only lever is the socket: drop it so a fresh canvas
// reconnects, which mirrors the reload.
async function reloadRenderCanvasForRecovery(): Promise<void> {
  if (canvasPage) {
    await canvasPage.reload({ waitUntil: 'domcontentloaded' });
    return;
  }
  const sock = renderCanvasSocket;
  if (sock) {
    renderCanvasSocket = null;
    try {
      sock.close();
    } catch {
      /* already closing */
    }
  }
}

// After the reload, wait for the fresh canvas to reconnect and rejoin the room before reapplying.
// Uses sync-health (connectedToRoom) when available; when the probe is unanswered, a short grace.
async function waitForRoomRehydration(timeoutMs: number): Promise<void> {
  const first = await probeSyncHealth();
  if (!first) {
    await delay(500);
    return;
  }
  if (first.connectedToRoom) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeSyncHealth();
    if (health?.connectedToRoom) return;
    await delay(150);
  }
}

async function recoverCorruptedCanvas(roomId: string, reason: string): Promise<boolean> {
  if (recovering.get(roomId)) return false; // an incident for this room is already being handled
  recovering.set(roomId, true);
  try {
    for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS; attempt++) {
      // 1. Harvest the render-canvas's current shapes (a read is not suppressed by corruption).
      let harvested: unknown[] = [];
      try {
        const res = await wsRequest<{ shapes?: unknown }>('get-shapes');
        if (Array.isArray(res.shapes)) harvested = res.shapes as unknown[];
      } catch (e) {
        console.warn(`[recover] harvest failed: ${(e as Error).message}`);
      }
      const preClock = roomDocumentClock(roomId);

      // 2. Fresh store → reconnect → re-hydrate from the room.
      await reloadRenderCanvasForRecovery();
      await waitForCanvasSocket(10_000);
      await waitForRoomRehydration(RECOVERY_REHYDRATE_TIMEOUT_MS);

      // 3. Reapply harvested shapes so the severed write reaches the room.
      if (harvested.length > 0) {
        try {
          await wsRequest<ExecRelayResult>('exec', { code: reapplyBlob(harvested), author: resolveExecAuthor(null) });
        } catch (e) {
          console.warn(`[recover] reapply failed: ${(e as Error).message}`);
        }
      }

      // 4. Confirm the store is healthy and the room advanced past the reload (or there was
      //    nothing to reapply).
      const health = await probeSyncHealth();
      const healthy = !health || health.possiblyCorrupted === false;
      const advanced = harvested.length === 0 || roomDocumentClock(roomId) > preClock;
      if (healthy && advanced) {
        const n = harvested.length;
        postSystemMessage(`Recovered the board after ${reason}. Reloaded the canvas and reapplied ${n} shape${n === 1 ? '' : 's'} so the work reached the room.`);
        console.log(`[recover] room '${roomId}' recovered after ${reason} (${n} shape(s) reapplied)`);
        return true;
      }
      if (attempt < RECOVERY_MAX_ATTEMPTS) await delay(RECOVERY_COOLDOWN_MS);
    }
    postSystemMessage(`Manual recovery needed: the board could not be repaired after ${reason} (tried ${RECOVERY_MAX_ATTEMPTS} times). The canvas may be frozen. Reload it, or restart the whiteboard.`);
    console.warn(`[recover] room '${roomId}' NOT recovered after ${RECOVERY_MAX_ATTEMPTS} attempts (${reason})`);
    return false;
  } finally {
    recovering.set(roomId, false);
  }
}

// [render-cap] Bounded self-heal supervision (operator decision 2026-09-28, amends #62): try
// the relaunch a few times with backoff, stay silent on success, and on exhaustion STOP looping
// and surface the failure on /canvas-status — never a chat-panel line. This bounds both a
// terminal give-up (one flaky launch used to leave the canvas dead until a process restart) and
// a crash-at-launch loop (which would otherwise spawn Chromiums forever, silently).
const RENDER_RELAUNCH_MAX_ATTEMPTS = 3;

// [render-cap] Reject any parked /image waiters immediately when the render-canvas is provably
// gone. Without this a request in flight at crash time sits out the full WS_REQUEST_TIMEOUT_MS
// (the app-side 12s timeout can't help — the app IS the dead render-canvas), turning a known
// death into a 15s hang before the honest 503. Records health once (the crash IS a failed export).
function failPendingImageWaiters(reason: string): void {
  if (imageWaiters.length === 0) return;
  const orphaned = imageWaiters.splice(0, imageWaiters.length);
  for (const w of orphaned) {
    clearTimeout(w.timer);
    w.reject(new Error(reason));
  }
  lastExportOk = false;
  lastExportError = reason;
  lastExportAt = Date.now();
}

// [render-cap] Null the handles (so browserUp stops lying) and close the corpse. Called both to
// bury a dead browser and to clean up a PARTIAL launch — chromium.launch() can succeed while
// newPage/goto/verifyCanvasSynced then throws, leaving `browser` non-null with no working page;
// nulling here keeps browserUp honest on that failure path.
async function closeDeadBrowser(): Promise<void> {
  const dead = browser;
  browser = null;
  canvasPage = null;
  if (!dead) return;
  try {
    // Detach our death listeners before the intentional close so its own 'disconnected' can't
    // re-enter the handler. The identity guard in launchRenderCanvas already ignores a stale
    // browser's event; detaching is the belt to that suspenders.
    dead.removeAllListeners('disconnected');
  } catch {
    /* nothing to detach */
  }
  try {
    await dead.close();
  } catch {
    /* already gone */
  }
}

// [render-cap] Is the current render-canvas actually usable? Catches the case where the browser
// process died (isConnected false) OR the page renderer crashed (evaluate throws) during a
// relaunch's own verify window — where the re-entry guard would otherwise swallow the death and
// leave a dead-but-non-null handle reading healthy.
async function canvasPageAlive(): Promise<boolean> {
  if (!browser || !browser.isConnected() || !canvasPage) return false;
  try {
    await canvasPage.evaluate(() => true);
    return true;
  } catch {
    return false;
  }
}

// [render-cap] Detect a dead render-canvas and relaunch it. Chromium can crash or disconnect
// (renderer OOM, GPU-process loss after a laptop suspend) while the Playwright handle stays
// non-null — so `browserUp` (!!browser) keeps reporting true and `/image` hangs forever with no
// live page to answer. This is the #61-deferred "self-recovery after suspend". SILENT on recovery
// by operator decision (2026-09-28): server-log only, no panel message — a missed export beat is
// self-healing and not worth a chat line. A permanent failure IS surfaced (see below). Guarded
// against re-entry, and against the graceful teardown path (shutdown() sets shuttingDown before it
// closes the browser, so that close is not mistaken for a crash).
async function handleRenderCanvasDeath(cause: string): Promise<void> {
  if (shuttingDown) return; // graceful teardown closes the browser on purpose — not a crash
  if (renderCanvasRestarting) return; // an incident is already being handled
  renderCanvasRestarting = true;
  console.warn(`[canvas] render-canvas ${cause}; relaunching (silent)`);
  try {
    failPendingImageWaiters(`render-canvas ${cause}; restarting`);
    await closeDeadBrowser();
    const room = canvasRoom ?? activeRoomId;
    for (let attempt = 1; attempt <= RENDER_RELAUNCH_MAX_ATTEMPTS; attempt++) {
      try {
        await launchRenderCanvas(room);
        // A crash during the launch's own verify window is swallowed by the re-entry guard, so
        // confirm the fresh canvas is actually alive before declaring success.
        if (await canvasPageAlive()) {
          console.log(`[canvas] render-canvas relaunched after ${cause} (attempt ${attempt})`);
          return;
        }
        console.warn(`[canvas] relaunch attempt ${attempt}/${RENDER_RELAUNCH_MAX_ATTEMPTS} produced a dead canvas; retrying`);
      } catch (e) {
        console.error(`[canvas] relaunch after ${cause} failed (attempt ${attempt}/${RENDER_RELAUNCH_MAX_ATTEMPTS}): ${(e as Error).message}`);
      }
      await closeDeadBrowser(); // bury a partial/dead launch so browserUp stays honest
      if (attempt < RENDER_RELAUNCH_MAX_ATTEMPTS) await delay(1_000 * attempt); // 1s, 2s backoff
    }
    // Exhausted. Stop looping and surface it: silent covers a routine blip, not a permanent
    // death. browser/canvasPage are already null (closeDeadBrowser) so browserUp reads false;
    // stamping lastExport* makes the dead board attestable on /canvas-status.
    lastExportOk = false;
    lastExportError = `render-canvas self-heal failed after ${RENDER_RELAUNCH_MAX_ATTEMPTS} attempts (${cause}); manual restart needed`;
    lastExportAt = Date.now();
    console.error(`[canvas] render-canvas NOT recovered after ${RENDER_RELAUNCH_MAX_ATTEMPTS} attempts (${cause}); browserUp=false`);
  } finally {
    renderCanvasRestarting = false;
  }
}

async function launchRenderCanvas(roomId: string): Promise<void> {
  canvasRoom = roomId;
  const b = await chromium.launch({ headless: true });
  browser = b;
  // [render-cap] Watch for a dead renderer. 'disconnected' fires when the Browser process exits
  // (crash/OOM); 'crash' fires when the page's renderer process dies but the browser survives.
  // Either way the handle is stale and exports would hang — relaunch. The `b === browser` identity
  // guard ignores a STALE browser's late event (e.g. the intentional dead.close() firing after a
  // relaunch already swapped in a new browser), which would otherwise tear down the healthy new
  // canvas. void: fire-and-forget (handleRenderCanvasDeath never rejects).
  b.on('disconnected', () => { if (browser === b) void handleRenderCanvasDeath('browser disconnected'); });
  const page = await b.newPage({ viewport: { width: 1280, height: 800 } });
  canvasPage = page;
  page.on('console', (m) => console.log(`[canvas] ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => console.warn(`[canvas] pageerror: ${e.message}`));
  page.on('crash', () => { if (canvasPage === page) void handleRenderCanvasDeath('page crashed'); });
  const url = canvasUrl(roomId);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`[canvas] render-canvas launched at ${url}`);
  await verifyCanvasSynced(roomId, 'launch');
}

async function navigateRenderCanvas(roomId: string): Promise<void> {
  canvasRoom = roomId;
  if (!canvasPage) {
    await launchRenderCanvas(roomId);
    return;
  }
  const url = canvasUrl(roomId);
  await canvasPage.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`[canvas] render-canvas navigated to ${url}`);
  await verifyCanvasSynced(roomId, 'navigate');
}

async function teardownRenderCanvas(): Promise<void> {
  try {
    if (canvasPage) {
      await canvasPage.close();
      canvasPage = null;
    }
  } catch (e) {
    console.warn('[canvas] page close failed:', (e as Error).message);
  }
  try {
    if (browser) {
      await browser.close();
      browser = null;
    }
  } catch (e) {
    console.warn('[canvas] browser close failed:', (e as Error).message);
  }
}

app.get('/canvas-status', (_req: Request, res: Response) => {
  const connected = !!(renderCanvasSocket && renderCanvasSocket.readyState === WebSocket.OPEN);
  // [v5 §8.6/§11] agentParked = a lead is long-polling right now (a live waiter exists), so a
  // Send lands immediately. When false with pending Sends, nobody is listening — loud, not silent.
  res.json({
    connected,
    agentParked: agentParked(),
    // [v9.3 §9 #55] The honest lead-liveness signal (armed listener OR receipt holder within grace).
    // The panel keys the "no one on the board" banner and the lead avatar dim on this, NOT on the
    // transient agentParked, so a normal turn's wake→re-arm gap never reads as "session ended". Always
    // present, so a panel reconnect re-seeds it (a change missed while the socket was down is caught).
    leadAlive: leadAlive(Date.now()),
    room: canvasRoom,
    // [v8 §8.3] The board this process actually hosts (canvasRoom is null until the render-canvas
    // navigates, and stays null headless; activeRoom is always set). The runtime one-server guard
    // and its regression test read this to confirm a live owner is serving the board it claims.
    activeRoom: activeRoomId,
    // [v9.6] Identify the CC session that booted this board (mirrors the lock's owner fields) so a
    // guest/second /whiteboard session reads the owner here without re-parsing the lock, and knows it
    // must not tear down a board it did not boot. Null when the board was booted without owner env.
    ownerSession: OWNER_SESSION,
    ownerSessionId: OWNER_SESSION_ID,
    // [v9.1 §8.2 #53] The operator pressed the confirm-gated close affordance and the lead has not
    // yet consumed the teardown directive — the app reflects a "closing…" state from this.
    teardownRequested: isTeardownRequested(activeRoomId),
    browserUp: !!browser,
    humans: humanSockets.size,
    agents: computeAgents(), // [v6 §4/§7] per-agent roster + lifecycle for the panel status strip
    // [v9.5 §5] The authoritative room's shape count and document clock. Diagnostic (additive),
    // and the ground truth the sync-corruption regression test reads to confirm a write reached
    // the room rather than freezing at a corrupted render-canvas.
    roomShapes: roomShapeCount(activeRoomId),
    roomClock: roomDocumentClock(activeRoomId),
    // [#61 §6.1] Export health. The old status was structurally blind to it (connected=WS open,
    // browserUp=Playwright handle exists) so a live-but-degraded render-canvas returning ok:false read
    // as healthy. These make the render-stall observable directly: lastExportOk:false, or a lastImageMtime
    // that is not advancing across /image calls, is the stall. Null = no export attempted yet.
    lastExportOk,
    lastExportError,
    lastExportAt,
    lastImageMtime,
    lastImageBytes,
  });
});

// ===========================================================================
// Shutdown / done (SPEC §11: no orphan Chromium)
// ===========================================================================
let shuttingDown = false;
async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[bridge] shutting down…');
  // [v9.6 fix 4] Tell any connected operator browsers the room is closing so they can export
  // before the socket drops — the client keeps NO local persistence, so unsynced edits after
  // close are lost. Broadcast BEFORE the sockets are torn down, then let the frame flush.
  try { broadcastToHumans({ type: 'server-closing', room: activeRoomId }); } catch { /* best effort */ }
  await new Promise((r) => setTimeout(r, 150));
  clearInterval(sweepTimer);
  for (const [roomId, entry] of rooms) persistRoomSync(roomId, entry);
  removeLock();
  presence.closeAll();
  await teardownRenderCanvas();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

app.post('/done', (_req: Request, res: Response) => {
  // [v9.1 §9 #53] Defensive cleanup: clear the teardown flag on the graceful close. In the directive
  // path it is already cleared on consumption; this also covers the natural-language-Send fallback,
  // where the lead reaches /done without a directive ever being surfaced.
  clearTeardownRequested(activeRoomId);
  res.json({ ok: true });
  void shutdown(0);
});

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGHUP', () => void shutdown(0));
process.on('uncaughtException', (e) => {
  console.error('[bridge] uncaughtException:', e);
  void shutdown(1);
});

// ===========================================================================
// Static app + boot
// ===========================================================================
app.use('/', express.static(APP_DIST));

// [v4 §8.3] Bind 127.0.0.1:0 (OS-assigned) unless PORT overrides; read the real port back.
server.listen(PORT_OVERRIDE ?? 0, HOST, () => {
  const addr = server.address();
  assignedPort = addr && typeof addr === 'object' ? addr.port : PORT_OVERRIDE ?? 0;
  console.log(`[bridge] WHITEBOARD_PORT=${assignedPort}`);
  console.log(`[bridge] listening on http://${HOST}:${assignedPort} (${PORT_OVERRIDE ? 'PORT override' : 'ephemeral'})`);
  console.log(`[bridge] serving app from ${APP_DIST}`);
  console.log(`[bridge] bridge WS  ws://${HOST}:${assignedPort}/events`);
  console.log(`[sync]   sync   WS  ws://${HOST}:${assignedPort}/sync/:roomId`);
  writeLock();
  getOrCreateRoom(activeRoomId);
  // WHITEBOARD_NO_CANVAS skips the Playwright render-canvas — a headless-test affordance
  // for exercising the bridge (messages, discovery, isolation) without launching Chromium.
  // The skill never sets it, so normal boot always brings the render-canvas up.
  if (process.env.WHITEBOARD_NO_CANVAS) {
    console.log('[canvas] skipped (WHITEBOARD_NO_CANVAS set)');
  } else {
    void launchRenderCanvas(activeRoomId).catch((e) => console.error('[canvas] launch failed:', (e as Error).message));
  }
});

// Presence-state helper re-export used by nothing else; keep the type surface visible.
export type { PresenceState };

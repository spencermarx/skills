// Whiteboard v4 server (SPEC §3-§8). ONE Node process per board, 127.0.0.1 only. Its first boot
// takes an OS-assigned ephemeral port and records it in <name>.port, which every later boot of the
// board binds again (WHITEBOARD_PORT overrides both). Announces the live server in <name>.lock.
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
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { TLSocketRoom } from '@tldraw/sync-core';
import { createTLSchema } from '@tldraw/tlschema';
import { chromium, type Browser, type Page } from 'playwright';
import { PresenceManager, type PresenceState } from './presence.js';
import { postToInbox } from './inbox.js';
import { isCanvasDriverFault } from './canvas-fault.js';
import { canonicalBoardPath, isRoomId, placementRefusal, slugFor } from './boards.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOST = '127.0.0.1';
// [v4 §8.3] Each board's process gets its own port. The one it binds is chosen at boot (see
// BOOT_PORT, after the board is resolved), read off the listening socket after `listen`, and used
// everywhere via `assignedPort`. A non-zero WHITEBOARD_PORT is an explicit override. [#64] The
// generic PORT is never read: the boot shell is initialised from the operator's profile, so an
// exported PORT would silently move the board off its recorded port.
const PORT_ENV = Number(process.env.WHITEBOARD_PORT);
const PORT_OVERRIDE = Number.isInteger(PORT_ENV) && PORT_ENV > 0 ? PORT_ENV : null;
let assignedPort = 0;
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
// [v6 §5] Revive-storm guard. When GET /pending hands the lead a "revive worker-N" directive, that worker enters a grace window during which the bridge does NOT re-issue a revive
// for it — long enough for the lead to spawn/resume it and for the revived worker to re-poll.
// Cleared the moment a waiter parks for that recipient (revival succeeded). Env-overridable (tests
// set it small), same convention as STALL_MS/SWEEP_MS. [#64] 60s, not 15s: the 2026-10-19 live dry
// run measured a resumed subagent taking ~20s to re-register, so a 15s grace raised a second revive
// for a worker already being revived.
const REVIVE_GRACE_MS = Number(process.env.WHITEBOARD_REVIVE_GRACE_MS) || 60_000;
// [#64] A worker whose session called the bridge within this window is alive and busy (drawing,
// waiting on a critic), not dead, so no revive is raised for it even though no poller is parked.
// The live dry run saw a revive raised for a worker mid-draw. Env-overridable like the others.
const REVIVE_QUIET_MS = Number(process.env.WHITEBOARD_REVIVE_QUIET_MS) || 30_000;
// [v9.6] The CC session that booted this board, recorded in the lock so a SECOND
// /whiteboard session can tell it did not boot this board and must never tear it down.
// [#64] Resolved here from the environment this process inherits from its owning session, never
// by the boot command (a shell chain that can fail before it reaches `exec node`). The
// WHITEBOARD_OWNER_* variables are overrides. A background-job session also has a job directory
// whose state.json carries the session's name and id; an interactive one has none, and the
// resolution then rests on CLAUDE_CODE_SESSION_ID alone. Nothing here can fail the boot: an unread
// or unparsable state.json is simply absent, and an empty value is not recorded.
function readJobState(): { id?: unknown; sessionId?: unknown; name?: unknown } | null {
  const dir = process.env.CLAUDE_JOB_DIR;
  if (!dir) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as { id?: unknown; sessionId?: unknown; name?: unknown }) : null;
  } catch {
    return null;
  }
}
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const JOB_STATE = readJobState();
// The job state names the session `sessionId` in the 2.1.292 binary; `id` is read first, as the
// skill's boot command used to.
const OWNER_SESSION = nonEmpty(process.env.WHITEBOARD_OWNER_SESSION) ?? nonEmpty(JOB_STATE?.name); // human-readable CC session name
const OWNER_SESSION_ID =
  nonEmpty(process.env.WHITEBOARD_OWNER_SESSION_ID) ??
  nonEmpty(process.env.CLAUDE_CODE_SESSION_ID) ??
  nonEmpty(JOB_STATE?.id) ??
  nonEmpty(JOB_STATE?.sessionId); // stable CLAUDE_CODE_SESSION_ID
// [v9.11 §3 #64] The owning Claude Code process. The skill boots this server as the foreground of a
// `run_in_background` Bash job with `exec node --import tsx index.ts`, so the shell is replaced by
// node and the Claude process is this server's direct parent: every inbox ring is then verified as
// coming from the session's own child. Recorded at boot; the owner watch exits when it changes.
const OWNER_PID = process.ppid;
// [#64] Whether that parent is the Claude process itself: true when it is the CLAUDE_PID this
// process inherited, false when something sits between them (npm, a wrapper shell, a trailing `&`),
// and null when no CLAUDE_PID was inherited, which is unknown and never blocks. On false the inbox
// would not see the rings as this session's own child's, so POST /canary refuses with a 409.
const OWNER_IS_CLAUDE: boolean | null = process.env.CLAUDE_PID ? process.ppid === Number(process.env.CLAUDE_PID) : null;
// [v9.11 §8.5 #64] The owning session's inbox socket and token, read from this process's own
// environment and nowhere else (never over HTTP). The token lives in memory only: it is never
// logged and never written to disk. Both are then removed from process.env so no child this
// process spawns (the Playwright render-canvas) inherits them.
const INBOX_SOCKET = process.env.CLAUDE_CODE_MESSAGING_SOCKET || null;
const INBOX_TOKEN = process.env.CLAUDE_CODE_MESSAGING_TOKEN || null;
delete process.env.CLAUDE_CODE_MESSAGING_SOCKET;
delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
// A positive millisecond count from the environment, else the default.
function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
// [v9.11 #64] The doorbell's bounded re-ring schedule: re-ring an unfetched item at these offsets
// after its first ring, then declare it "not heard" NOT_HEARD_AFTER_MS after the last re-ring.
// Env-overridable (tests use ms), e.g. WHITEBOARD_RERING_MS="600,1200,1800".
const RERING_MS = (() => {
  const raw = process.env.WHITEBOARD_RERING_MS;
  if (!raw) return [30_000, 120_000, 600_000];
  const list = raw.split(',').map((s) => Number(s.trim()));
  return list.every((n) => Number.isFinite(n) && n > 0) ? list.sort((a, b) => a - b) : [30_000, 120_000, 600_000];
})();
const NOT_HEARD_AFTER_MS = envMs('WHITEBOARD_NOT_HEARD_AFTER_MS', 120_000);
// How often the doorbell re-evaluates due re-rings, and the minimum gap between two rings (items
// arriving inside the gap coalesce into the next ring, keeping far under the inbox's rate limit).
const DOORBELL_TICK_MS = envMs('WHITEBOARD_DOORBELL_TICK_MS', 1_000);
const RING_MIN_GAP_MS = envMs('WHITEBOARD_RING_MIN_GAP_MS', 1_000);
const APP_DIST = path.resolve(__dirname, '..', 'app', 'dist');
// [port] Detached mode (scripts/whiteboard.sh start --detach, for a harness that cannot keep the
// server as the foreground of a background job): no owner watch, so the server lives until /done.
// The lock still records a numeric parentPid (this process's own), so no boot reads it as a server
// from before #64.
const OWNER_WATCH_OFF = process.env.WHITEBOARD_OWNER_WATCH === 'off';
// [port] With no inbox, the lead listens by long-polling GET /pending?wait=<ms>. Its Sends read
// "not heard" only after it has neither waited nor pulled within this window.
const PULL_GRACE_MS = envMs('WHITEBOARD_PULL_GRACE_MS', 300_000);
// [port] A per-process secret the render-canvas's URL carries, so no other page can take its /events
// slot. WHITEBOARD_CANVAS_KEY sets it for the tests' stand-in canvases; the skill never sets it.
const CANVAS_KEY = process.env.WHITEBOARD_CANVAS_KEY || randomUUID();

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

// [port] The boards folder follows the repository being worked on, never the skill's install folder
// (a plugin cache, ~/.agents/skills). The repository is WHITEBOARD_REPO, else the git root of the
// working directory; the boards folder is WHITEBOARD_HOME, else <repository>/.scratchpad/whiteboard.
// scripts/whiteboard.sh start sets both.
const REPO_ROOT = canonicalBoardPath(process.env.WHITEBOARD_REPO ? path.resolve(process.env.WHITEBOARD_REPO) : findRepoRoot(process.cwd()));
const homeDir = process.env.WHITEBOARD_HOME ? path.resolve(process.env.WHITEBOARD_HOME) : path.join(REPO_ROOT, '.scratchpad', 'whiteboard');
fs.mkdirSync(homeDir, { recursive: true });
const HOME = canonicalBoardPath(homeDir);

const boardName = (p: string): string => path.basename(p, path.extname(p));
const imagePathFor = (p: string): string => path.join(HOME, `${boardName(p)}.png`);

// [#64] A set WHITEBOARD_BOARD must be the board's absolute `.tldr` path in a directory that exists.
// The boot line quotes it (the real path has a space), so a placeholder copied unfilled arrives
// verbatim, and an empty value is a shell variable that expanded to nothing. Resolving either
// against `server/` would boot a junk board there and hand the operator the wrong board without a
// word, so refuse to boot. Unset keeps the default board.
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
// [port] A board must also lie inside the repository or the boards folder (boards.mjs's placement
// rule), and every refusal exits 2, as scripts/whiteboard.sh's own does.
const BOARD_ENV = process.env.WHITEBOARD_BOARD;
if (BOARD_ENV !== undefined && !(path.isAbsolute(BOARD_ENV) && BOARD_ENV.endsWith('.tldr') && isDirectory(path.dirname(BOARD_ENV)))) {
  console.error(`[bridge] WHITEBOARD_BOARD must be the board's absolute .tldr path (got ${BOARD_ENV})`);
  process.exit(2);
}
let activeBoardPath = BOARD_ENV ? canonicalBoardPath(BOARD_ENV) : path.join(HOME, 'board.tldr');
const BOARD_REFUSAL = placementRefusal(activeBoardPath, REPO_ROOT, HOME);
if (BOARD_REFUSAL) {
  console.error(`[bridge] WHITEBOARD_BOARD refused: ${BOARD_REFUSAL}`);
  process.exit(2);
}
let activeRoomId = boardName(activeBoardPath);
let latestImagePath = imagePathFor(activeBoardPath);

// [#64] Whether this process hosts `room`: the active board, and no other. The one test used by the
// sync upgrade, POST /message and POST /request-teardown. A board this process still holds while an
// in-app switch releases it (`heldBoards`) is never hosted: from the switch's commit on, it is not
// served or written by a socket or a Send here, only flushed once by the release (see switchRoom).
function hosts(room: unknown): boolean {
  return room === activeRoomId;
}

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
console.log(`[bridge] boards folder: ${HOME}`);
console.log(`[bridge] active board: ${activeBoardPath} (room '${activeRoomId}')`);

// --- lockfile: discovery + one-server-per-board guard (SPEC §8.3) [v4] ------
// `<name>.lock` = { port, pid, board, startedAt, ownerSession?, ownerSessionId?, parentPid, ownerIsClaude }
// beside `<name>.tldr`. It means one thing: this process holds the board. It serves it, or it is
// releasing it after an in-app switch and its final snapshot is not yet on disk. The next
// `/whiteboard` for this board reads it to find the running port and attach; the server that wrote
// it removes it on every graceful exit. Liveness is pid + `/canvas-status`, not the file's presence.
const lockPathFor = (roomId: string): string => path.join(HOME, `${roomId}.lock`);

// [#64] Every board whose lock names this process, kept by writeLock and removeLock and reported as
// `held` on /canvas-status, so another process's probe asks what the lock means. It includes a board
// this process is releasing after a switch, which `activeRoom` no longer names.
const heldBoards = new Set<string>();

// Written only through claimLock / claimLockNow, which make the one-server check first.
function writeLock(roomId: string = activeRoomId): void {
  const lock = {
    port: assignedPort, pid: process.pid, board: roomId, startedAt: Date.now(),
    ...(OWNER_SESSION ? { ownerSession: OWNER_SESSION } : {}),
    ...(OWNER_SESSION_ID ? { ownerSessionId: OWNER_SESSION_ID } : {}),
    // [v9.11 §8.3 #64] The owning Claude Code process: this server's parent, which it exits with.
    // [port] Detached, it exits with nothing: parentPid is its own pid.
    parentPid: OWNER_WATCH_OFF ? process.pid : OWNER_PID,
    ownerIsClaude: OWNER_IS_CLAUDE,
    ...(OWNER_WATCH_OFF ? { detached: true } : {}),
  };
  try {
    fs.writeFileSync(lockPathFor(roomId), JSON.stringify(lock));
    heldBoards.add(roomId);
    console.log(`[bridge] wrote lock ${lockPathFor(roomId)} (port ${assignedPort}, pid ${process.pid})`);
  } catch (e) {
    console.warn(`[bridge] lock write failed: ${(e as Error).message}`);
  }
}

// Remove the lock only while it names this process. Once this process has left a board, another
// server may hold that board's lock; this server's exit must not then delete the live server's
// lock, which would make a third /whiteboard boot onto a board that is already served. Either way
// the board leaves `held` in the same synchronous step.
function removeLock(roomId: string = activeRoomId): void {
  heldBoards.delete(roomId);
  if (readLock(roomId)?.pid !== process.pid) return;
  try {
    fs.rmSync(lockPathFor(roomId), { force: true });
  } catch (e) {
    console.warn(`[bridge] lock remove failed: ${(e as Error).message}`);
  }
}

// [#64] `<name>.port` = { port, board, pid, at } beside the lock: the port this board is kept on.
// The two files have different lifetimes. The lock lasts as long as the process; the port lasts as
// long as the board, so every exit but the operator's /done leaves it (the owner watch, a signal,
// the shutdown deadline, a crash), and the next boot of the board binds the same port while it is
// free, which lets the operator's open tab reconnect to the same origin. The server rewrites it
// whenever it binds a port for a board (a boot, a fallback from a taken port, a board switch).
const portPathFor = (roomId: string): string => path.join(HOME, `${roomId}.port`);
type PortRecord = { port: number; board: string; pid: number; at: number };

function readPortRecord(roomId: string): PortRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(portPathFor(roomId), 'utf8')) as Partial<PortRecord>;
    if (Number.isInteger(parsed.port) && (parsed.port as number) > 0 && (parsed.port as number) < 65536) return parsed as PortRecord;
  } catch {
    /* no record, or unreadable: the board has no remembered port */
  }
  return null;
}

function writePortRecord(): void {
  const record: PortRecord = { port: assignedPort, board: activeRoomId, pid: process.pid, at: Date.now() };
  try {
    fs.writeFileSync(portPathFor(activeRoomId), JSON.stringify(record));
    console.log(`[bridge] recorded port ${assignedPort} in ${portPathFor(activeRoomId)}`);
  } catch (e) {
    console.warn(`[bridge] port record write failed: ${(e as Error).message}`);
  }
}

// Forget the board's port: the operator closed the board (/done). Like the lock, only while the
// record names this process, so a /done here never erases the port another live server holds.
function removePortRecord(roomId: string = activeRoomId): void {
  if (readPortRecord(roomId)?.pid !== process.pid) return;
  try {
    fs.rmSync(portPathFor(roomId), { force: true });
  } catch (e) {
    console.warn(`[bridge] port record remove failed: ${(e as Error).message}`);
  }
}

// The port this boot asks for: a non-zero WHITEBOARD_PORT, else the board's recorded port, else 0
// (ephemeral). A recorded port that is taken falls back to ephemeral at `listen` (see the boot).
const RECORDED_PORT = PORT_OVERRIDE ? null : readPortRecord(activeRoomId)?.port ?? null;
const BOOT_PORT = PORT_OVERRIDE ?? RECORDED_PORT ?? 0;

// [v8 §8.3] One-server guard. The skill's attach-vs-boot check (SPEC §9) decides before a boot;
// this guard holds at every lock write, a boot or an in-app switch (`/board/open`). Without it,
// a boot or a switch steals the board's lock with no owner check — a split-brain: two processes
// serve one board, and a parked waiter on one never meets a Send that lands on the other. [#64] The
// probe asks the lock's process what the lock means, whether it still holds the board, not only
// which board it hosts: a process mid-switch hosts the new board while it still holds the old one.
type LockInfo = { port: number; pid: number; board: string; startedAt: number; ownerSession?: string; ownerSessionId?: string; parentPid?: number; ownerIsClaude?: boolean | null; detached?: boolean };

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

// [#64] What the lock's process says about the board, read from its `/canvas-status` (`pid`,
// `activeRoom`, `held`) on the lock's port:
//   active     it answers with the lock's pid and hosts the board (or, from a server older than
//              `pid`, answers no `pid` and an `activeRoom` that is the board);
//   releasing  it answers with the lock's pid and holds the board, but hosts another: an in-app
//              switch is releasing it, and its final snapshot is not yet on disk;
//   stale      the pid is dead, the port refuses the connection, the answer is not a board server's,
//              it names another pid (as after pid reuse), or the board is not in `held`;
//   unknown    the pid is alive and the port did not answer within PROBE_TIMEOUT_MS, or the request
//              failed in any way other than a refused connection. Never stale: a live owner that is
//              slow or stopped still holds the board.
// Never throws.
type OwnerState = 'active' | 'releasing' | 'stale' | 'unknown';
const PROBE_TIMEOUT_MS = 1_000;

// One `/canvas-status` request to a port: the parsed answer, `refused` (nothing listens there),
// `silent` (no answer within PROBE_TIMEOUT_MS, or a request error other than a refused connection),
// or `invalid` (an answer that is not a status object). Never throws.
type StatusAnswer = { pid?: unknown; activeRoom?: unknown; held?: unknown };
function canvasStatus(port: number): Promise<StatusAnswer | 'refused' | 'silent' | 'invalid'> {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/canvas-status', timeout: PROBE_TIMEOUT_MS }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve('invalid'); return; }
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(raw);
          resolve(parsed && typeof parsed === 'object' ? (parsed as StatusAnswer) : 'invalid');
        } catch {
          resolve('invalid');
        }
      });
    });
    req.on('error', (e) => resolve((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'silent'));
    req.on('timeout', () => { req.destroy(); resolve('silent'); });
  });
}

async function probeOwner(lock: LockInfo, roomId: string): Promise<OwnerState> {
  if (!pidAlive(lock.pid)) return 'stale';
  const status = await canvasStatus(lock.port);
  // A refused connection is proof nothing listens there. Any other failure is a live pid that did
  // not answer: fail closed.
  if (status === 'silent') return 'unknown';
  if (status === 'refused' || status === 'invalid') return 'stale';
  // A server from before `pid` and `held` existed answers `activeRoom` alone: it is active when that
  // names the board, and stale otherwise, as the old check judged it.
  if (!('pid' in status)) return status.activeRoom === roomId ? 'active' : 'stale';
  if (status.pid !== lock.pid || !Array.isArray(status.held) || !status.held.includes(roomId)) return 'stale';
  return status.activeRoom === roomId ? 'active' : 'releasing';
}

// [#65] Every live board server from before #64 that this home's locks name, on any board. Such a
// server wrote a lock with no `parentPid`: it never exits with its session, it may ignore SIGTERM,
// and after an in-app switch it keeps the board it left in memory with no lock, still saving it,
// so the one-server check at a lock write cannot see it. A lock counts when its `pid` is alive and
// its port answers `/canvas-status` as a board server from before `pid` (`activeRoom`, no `pid`),
// or does not answer at all (a server in #63's EPIPE loop accepts and never answers). A refused
// port or another answer is a reused pid, not a server. The boot and an in-app switch both refuse
// while any is found, before they claim or release anything.
type OldServer = { pid: number; port: number; board: string };
async function findPre64Servers(): Promise<OldServer[]> {
  let files: string[];
  try {
    files = fs.readdirSync(HOME).filter((f) => f.endsWith('.lock'));
  } catch {
    return [];
  }
  const found = await Promise.all(files.map(async (f): Promise<OldServer | null> => {
    const board = f.slice(0, -'.lock'.length);
    const lock = readLock(board);
    if (!lock || typeof lock.parentPid === 'number' || lock.pid === process.pid || !pidAlive(lock.pid)) return null;
    const status = await canvasStatus(lock.port);
    const old = status === 'silent' || (typeof status === 'object' && !('pid' in status) && typeof status.activeRoom === 'string');
    return old ? { pid: lock.pid, port: lock.port, board } : null;
  }));
  return found.filter((s): s is OldServer => s !== null);
}

// The servers found, as the boot's exit line and the switch's refusal both name them.
function describeOldServers(servers: OldServer[]): string {
  return `an older whiteboard server (no parentPid) is running: ${servers.map((s) => `pid ${s.pid} on port ${s.port}, board '${s.board}'`).join('; ')}`;
}

// [#64] How long a claim waits on an owner that is `releasing` the board, or that is `unknown`, before
// it refuses. A release is one in-flight save and one flush (see switchRoom), so this covers it on any
// healthy disk. WHITEBOARD_RELEASE_WAIT_MS overrides it, for tests.
const RELEASE_WAIT_MS = envMs('WHITEBOARD_RELEASE_WAIT_MS', 10_000);
const RELEASE_POLL_MS = 100;

// The owner a claim refuses, and the state it last answered. `active` also covers a lock written by
// another process in the instant before ours (see claimLockNow): that process has just claimed it.
type LockOwner = { port: number; pid: number; state: Exclude<OwnerState, 'stale'> };
type BoardVerdict = { owner: LockOwner } | { owner: null; stalePid: number | undefined };

// [#64] The asynchronous half of a claim, which writes nothing. It probes the lock's process until the
// board is free (no lock, this process's own lock, or `stale`) or its owner is `active`. While the
// owner is `releasing` or `unknown` it re-probes every RELEASE_POLL_MS, for up to RELEASE_WAIT_MS
// from the first such answer (`onWait` runs then, once, with that answer), and then refuses with
// the last state.
// A free board answers the pid it found stale, the only live pid claimLockNow may then overwrite.
async function awaitBoardFree(roomId: string, onWait?: (lock: LockInfo, state: Exclude<OwnerState, 'stale' | 'active'>) => void): Promise<BoardVerdict> {
  let deadline: number | null = null;
  for (;;) {
    const lock = readLock(roomId);
    if (!lock || lock.pid === process.pid) return { owner: null, stalePid: undefined };
    const state = await probeOwner(lock, roomId);
    if (state === 'stale') return { owner: null, stalePid: lock.pid };
    const owner: LockOwner = { port: lock.port, pid: lock.pid, state };
    if (state === 'active') return { owner };
    if (deadline === null) {
      deadline = Date.now() + RELEASE_WAIT_MS;
      onWait?.(lock, state);
    }
    if (Date.now() >= deadline) return { owner };
    await new Promise((r) => setTimeout(r, RELEASE_POLL_MS));
  }
}

// [#64] The one-server check, made where the lock is written. Both writers of a lock go through
// here: the boot (awaitBoardFree before `listen`, then claimLockNow in the listening handler) and
// switchRoom (inside runExclusive, before activeRoomId changes). Answers the owner to refuse and
// writes nothing while another process holds the board; otherwise writes this process's lock and
// answers null. The probe awaits, and a second server can write the lock meanwhile, so the write is
// preceded by a synchronous re-check with no await between the two.
async function claimLock(roomId: string): Promise<LockOwner | null> {
  const verdict = await awaitBoardFree(roomId);
  if (verdict.owner) return verdict.owner;
  return claimLockNow(roomId, verdict.stalePid);
}

// The synchronous half: refuse a lock naming another live pid, unless it is the lock the probe found
// `stale` (`stalePid`). A pid the probe found releasing or unknown is never exempt.
function claimLockNow(roomId: string, stalePid: number | undefined): LockOwner | null {
  const lock = readLock(roomId);
  if (lock && lock.pid !== process.pid && lock.pid !== stalePid && pidAlive(lock.pid)) return { port: lock.port, pid: lock.pid, state: 'active' };
  writeLock(roomId);
  return null;
}

// ===========================================================================
// SYNC SERVER — one TLSocketRoom per board (SPEC §3, §8)
// ===========================================================================
// `saving` is the in-flight async save, so an eviction can wait for it before its final flush.
type RoomEntry = { room: TLSocketRoom; boardPath: string; dirty: boolean; saving: Promise<void> | null };
const rooms = new Map<string, RoomEntry>();

// The schema every room defaults to (tldraw's default shapes). Recovery validates the records it writes
// into a room against it, as the room validates a client's push.
const ROOM_SCHEMA = createTLSchema();

// [port] A board file the server cannot load is refused, never replaced: the room is not created, so
// it is never persisted over the file. Undefined when the file does not exist yet (a new board).
function readBoardSnapshot(boardPath: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(boardPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${boardPath}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${boardPath} is not valid JSON: ${(e as Error).message}`);
  }
  const snap = parsed as { documents?: unknown; store?: unknown; tldrawFileFormatVersion?: unknown } | null;
  const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(snap) || !(Array.isArray(snap?.documents) || isObject(snap?.store))) {
    const hint = isObject(snap) && snap?.tldrawFileFormatVersion !== undefined
      ? " (it is in tldraw.com's file format, which this server does not import)"
      : '';
    throw new Error(`${boardPath} is not a whiteboard room snapshot${hint}`);
  }
  return parsed;
}

// Throws when the board's file is not a room snapshot the room can load (switchRoom answers 422, the
// boot exits 1).
function getOrCreateRoom(roomId: string, boardPath: string = pathForRoom(roomId)): RoomEntry {
  const existing = rooms.get(roomId);
  if (existing) return existing;

  const initialSnapshot = readBoardSnapshot(boardPath);

  const entry: RoomEntry = { room: null as unknown as TLSocketRoom, boardPath, dirty: false, saving: null };
  try {
    entry.room = new TLSocketRoom({
      // schema omitted -> defaults to createTLSchema() (default tldraw shapes), as ROOM_SCHEMA is.
      ...(initialSnapshot ? { initialSnapshot: initialSnapshot as never } : {}),
      onDataChange: () => {
        entry.dirty = true;
      },
      onSessionRemoved: (_room: unknown, args: { numSessionsRemaining: number }) => {
        console.log(`[sync] room '${roomId}': session left, ${args.numSessionsRemaining} remaining`);
      },
    });
  } catch (e) {
    throw new Error(`${boardPath} cannot be loaded as a board: ${(e as Error).message}`);
  }
  entry.dirty = false; // [port] loading (and any migration it ran) is not an edit

  rooms.set(roomId, entry);
  console.log(`[sync] room '${roomId}' ready (loaded=${!!initialSnapshot}) -> ${boardPath}`);
  return entry;
}

function persistRoom(roomId: string, entry: RoomEntry): Promise<void> {
  if (entry.saving) return entry.saving;
  const save = writeRoomSnapshot(roomId, entry).finally(() => {
    entry.saving = null;
  });
  entry.saving = save;
  return save;
}

// [#64] Every snapshot is written to a temp file beside the board and renamed over the `.tldr`, so
// the board on disk is always one whole snapshot: an exit or a crash mid-write leaves the previous
// one, never a torn file that the next boot reads as an empty board. Each write has its own temp
// name, so the async save and the sync flush never write the same file.
let snapshotSeq = 0;
const snapshotTempPath = (boardPath: string): string => `${boardPath}.${process.pid}-${++snapshotSeq}.tmp`;
// A test-only hold between an async save's temp write and its rename (WHITEBOARD_SAVE_HOLD_MS), so a
// test can act while a save is in flight. Unset, as the skill always leaves it, there is no hold.
const SAVE_HOLD_MS = envMs('WHITEBOARD_SAVE_HOLD_MS', 0);
function dropTemp(tmp: string): void {
  try {
    fs.rmSync(tmp, { force: true });
  } catch {
    /* best effort: a stray temp file is never read as a board */
  }
}

// [#64] Every save that finishes renames or drops its temp file, so one left beside a board is from a
// process that died mid-save (a SIGKILL, a hard exit). The boot that has claimed the board removes
// those whose pid, taken from the name, is dead; a live pid's may still be renamed.
function sweepOrphanTemps(boardPath: string): void {
  const dir = path.dirname(boardPath);
  const prefix = `${path.basename(boardPath)}.`;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.startsWith(prefix) ? /^(\d+)-\d+\.tmp$/.exec(name.slice(prefix.length)) : null;
    if (!m || pidAlive(Number(m[1]))) continue;
    dropTemp(path.join(dir, name));
    console.log(`[sync] removed an orphaned snapshot temp file ${name}`);
  }
}

async function writeRoomSnapshot(roomId: string, entry: RoomEntry): Promise<void> {
  const tmp = snapshotTempPath(entry.boardPath);
  try {
    const snapshot = entry.room.getCurrentSnapshot();
    await fsp.writeFile(tmp, JSON.stringify(snapshot));
    if (SAVE_HOLD_MS) await new Promise((r) => setTimeout(r, SAVE_HOLD_MS));
    await fsp.rename(tmp, entry.boardPath);
    console.log(`[sync] persisted room '${roomId}' -> ${entry.boardPath}`);
    notePersistResult(roomId, entry, null);
  } catch (e) {
    dropTemp(tmp);
    entry.dirty = true; // [port] retried on the next tick
    notePersistResult(roomId, entry, e as Error);
  }
}

// True when the board's file now holds the room.
function persistRoomSync(roomId: string, entry: RoomEntry): boolean {
  const tmp = snapshotTempPath(entry.boardPath);
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry.room.getCurrentSnapshot()));
    fs.renameSync(tmp, entry.boardPath);
    console.log(`[sync] flushed room '${roomId}' -> ${entry.boardPath}`);
    notePersistResult(roomId, entry, null);
    return true;
  } catch (e) {
    dropTemp(tmp);
    notePersistResult(roomId, entry, e as Error);
    return false;
  }
}

// [port] Whether the room's snapshot can be written beside its board: written to a temp file and
// dropped, never renamed, so the board on disk is untouched. A failure is said in the panel.
function canSave(roomId: string, entry: RoomEntry): boolean {
  const tmp = snapshotTempPath(entry.boardPath);
  try {
    fs.writeFileSync(tmp, JSON.stringify(entry.room.getCurrentSnapshot()));
    return true;
  } catch (e) {
    notePersistResult(roomId, entry, e as Error);
    return false;
  } finally {
    dropTemp(tmp);
  }
}

// [port] A board that cannot be saved is said in the panel once per run of failures, not only in the
// log, so the operator can export it before the edits since the last save are lost.
const persistFailing = new Set<string>();
function notePersistResult(roomId: string, entry: RoomEntry, error: Error | null): void {
  if (!error) {
    if (persistFailing.delete(roomId)) postSystemMessage(`Saving the board works again: ${entry.boardPath}`);
    return;
  }
  console.warn(`[sync] persist failed for '${roomId}': ${error.message}`);
  if (persistFailing.has(roomId) || shuttingDown) return;
  persistFailing.add(roomId);
  postSystemMessage(`The board cannot be saved to ${entry.boardPath} (${error.message}). Export it from the menu until this is fixed; edits since the last save exist only in the open board.`);
}

// A room still saving keeps its dirty mark for the next tick, so a change made during a save is
// never dropped.
const persistTimer = setInterval(() => {
  for (const [roomId, entry] of rooms) {
    if (entry.dirty && !entry.saving) {
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
// [v9.11 §8.5 #64] receivedAt: the LEAD's receipt — stamped by the lead's own GET /pending, so
// "fetched" is proven by the consumer's call, never by a transport's write. Lead-only: workers keep
// the STALL_MS lease clock (§8.5).
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
  // [v9.11 §8.5 #64] The lead doorbell's per-Send record: rungAt is the last ring that reached the
  // inbox socket, ringCount how many rings named it; notHeardAt/notHeardReason mark a Send the
  // owning session has not fetched after the re-ring schedule ran out ('unanswered'), or that no
  // ring could reach ('inbox-unreachable', 'no-inbox').
  rungAt?: number;
  ringCount?: number;
  notHeardAt?: number;
  notHeardReason?: NotHeardReason;
  // [v9.11 §8.5 #64] A lead Send fetched before and never completed, found by drain on open. Its next
  // fetch carries `refetch: true`: the lead that fetched it may have drawn part of it.
  refetch?: true;
};

type NotHeardReason = 'not-listening' | 'inbox-unreachable' | 'unanswered';

// [v5.1 §8.2] A Send's lifecycle state, computed server-side (single source of truth) and
// pushed to the panel. queued: awaiting its recipient. working: held — a worker's live lease OR
// the lead's clockless receipt (§8.5 #55). stalled: WORKER-ONLY — a worker's delivered lease
// expired (holder went silent past STALL_MS), re-queued for redelivery; the LEAD never reaches
// 'stalled' (its redelivery is liveness-driven, not clock-driven — see #55). done: completed.
// [v9.11 §8.5 #64] The LEAD's states: rung (the doorbell reached the owning session's inbox), fetched
// (the lead pulled it through GET /pending, the pull being the receipt), not-heard (unfetched after
// the re-ring schedule, or no ring could reach the session).
type SendState = 'queued' | 'rung' | 'fetched' | 'not-heard' | 'working' | 'stalled' | 'done';

// [v6 §7] Per-agent status, one row per addressable recipient, rendered by the panel's status strip.
// `parked` = a live long-poll waiter exists for this worker right now (never true for the lead,
// which does not long-poll). `lifecycle` is the per-agent listening/working signal; the lead's is
// read off its items (§7, #64).
type AgentStatus = {
  id: string; // recipient id ('lead' or a worker clientKey)
  name: string;
  color: string; // identity hex ('#7C4DFF'): the live presence color, else a deterministic fallback
  role: 'lead' | 'worker';
  parked: boolean;
  lifecycle: 'idle' | 'queued' | 'working' | 'stalled' | 'not-heard' | 'absent';
  // [#64] A guest session (see isGuest): shown for its presence, never offered as a recipient.
  guest?: true;
};

// [v6 §5] A revive item on the lead's GET /pending: wake worker `revive` (by its recipient id). [v7 #45] Carries a fixed bootstrap `nudge` the lead relays VERBATIM to the revived worker;
// `nudge` is required (every revive directive carries it) and is keyed ONLY on the AgentId — no
// pending-instruction text can flow through it (see buildNudge).
type ReviveDirective = { revive: string; name?: string; nudge: string };

// [v9.1 §9 #53] A teardown item on the lead's GET /pending — the operator pressed the confirm-gated
// close-session affordance (surfaced from the per-room teardownRequested flag, §8.2). Each /pending
// item also carries a `kind` ('canary' | 'send' | 'teardown' | 'revive'). NOT a chat Message: it
// never enters the attributed log or a recipient queue.
type TeardownDirective = { teardown: true; room: string; at: number };

// [#64] Holds the hosted room's log only: an in-app switch drops the log of the board it leaves
// (evictRoom), and GET /messages reads any other room straight from disk (readMessageLog).
const messagesByRoom = new Map<string, Message[]>();
const messageIdsByRoom = new Map<string, Set<string>>();

const messagesPathFor = (roomId: string): string => path.join(HOME, `${roomId}.messages.jsonl`);

// Load a room's sidecar into memory once (subsequent calls return the live array).
function loadMessages(roomId: string): Message[] {
  const existing = messagesByRoom.get(roomId);
  if (existing) return existing;
  const { arr, ids } = readMessageLog(roomId);
  // [v9.11 §8.5 #64] Drain on open. The board is loaded here when this process starts (a new owner:
  // the board server lives and dies with one Claude process) or when it switches back to the board
  // (the switch away dropped its log), so a lead Send fetched before and never completed is unfetched
  // again: its receipt and doorbell record are cleared, and the lead is rung for it and fetches it
  // afresh (at-least-once). One that was fetched is marked `refetch`, because it may be partly drawn:
  // the lead reads the board and finishes it rather than drawing it again (references/interrupted-work.md). /exec
  // idempotency keys cannot do this: they live in memory for at least 5 minutes and do not survive a restart.
  for (const m of arr) {
    if (m.author.kind !== 'human' || m.completedAt != null || recipientIdOf(m) !== 'lead') continue;
    if (m.receivedAt != null) m.refetch = true;
    delete m.receivedAt;
    delete m.deliveredAt;
    delete m.deliveredBy;
    delete m.rungAt;
    delete m.ringCount;
    delete m.notHeardAt;
    delete m.notHeardReason;
  }
  messagesByRoom.set(roomId, arr);
  messageIdsByRoom.set(roomId, ids);
  return arr;
}

// A room's sidecar as it is on disk, ascending by ts, deduped by id. Never cached.
function readMessageLog(roomId: string): { arr: Message[]; ids: Set<string> } {
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
  return { arr, ids };
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
// registered session; sessionId may be null and name falls back to 'Agent' when unknown.
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
  // `records: true` (recovery's harvest) adds every document record, on every page, to the answer;
  // `digestAssets` sends each asset's inline data as its digest, and `ids` asks for only those records.
  | { type: 'get-shapes'; id: string; records?: boolean; digestAssets?: boolean; ids?: string[] }
  // [v9.5 §5] Read the render-canvas store's sync health so the server can tell a write that
  // reached the room from one silently suppressed by a corrupted store. Handler in App.tsx.
  | { type: 'sync-health'; id: string }
  | { type: 'agent-message'; text: string; sessionId: string | null; id: string; ts: number; name: string }
  | { type: 'message'; message: Message }
  // [v5 §8.2] A Send's lifecycle change, pushed to human peers. [v5.1] `state` is authoritative.
  // [v6 §4] `recipient` lets the panel key the badge to the right per-recipient state; for a
  // broadcast, `state` is the aggregate and `recipient` is `{kind:'broadcast'}`.
  | { type: 'message-state'; id: string; state: SendState; recipient?: Recipient; deliveredAt?: number; completedAt?: number }
  // [v6 §4/§7] The per-agent roster/status changed; pushed to human peers (deduped by value).
  | { type: 'agent-status'; agents: AgentStatus[] }
  // [v9.6 fix 4] The room is closing; connected operator browsers should export now — the socket is
  // about to drop and the client keeps no local persistence, so unsynced edits after close are lost.
  | { type: 'server-closing'; room: string };

// [port] No `message` frame: a Send enters only through POST /message, which the Origin/Host check guards.
type FrameFromApp =
  | { type: 'exec-result'; id: string; ok: boolean; result?: unknown; error?: string }
  | {
      type: 'shapes-result';
      id: string;
      ok?: boolean;
      shapes?: unknown;
      records?: unknown;
      digested?: unknown;
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

// [v9.11 §3 #64] Origin and Host check on every HTTP and WebSocket route. GET /pending stamps the
// lead's receipt and stops the re-rings, so a request a web page fires at 127.0.0.1:<port> from the
// operator's browser must not reach it: it would mark Sends fetched and strand them silently. Accept
// only a loopback Host on this board's port (which also defeats DNS rebinding), an Origin that is
// absent (curl, the bridge's own Node clients) or this board's own origin, and a Sec-Fetch-Site that
// is absent, same-origin or none, or same-site for a top-level navigation (the board switcher moves
// the tab between board ports). WHITEBOARD_ALLOW_ORIGIN admits one more origin (the Vite dev server).
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const EXTRA_ORIGIN = process.env.WHITEBOARD_ALLOW_ORIGIN || null;
function refusalFor(headers: http.IncomingHttpHeaders): string | null {
  const host = headers.host ?? '';
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m || !LOOPBACK_HOSTS.includes((m[1] ?? '').toLowerCase()) || (m[2] && Number(m[2]) !== assignedPort)) {
    return `host ${JSON.stringify(host)} is not this board`;
  }
  const origin = headers.origin;
  if (origin !== undefined && origin === EXTRA_ORIGIN) return null;
  if (origin !== undefined && !LOOPBACK_HOSTS.some((h) => origin === `http://${h}:${assignedPort}`)) {
    return `origin ${JSON.stringify(origin)} is not this board`;
  }
  const site = headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none' && !(site === 'same-site' && headers['sec-fetch-mode'] === 'navigate')) {
    return `a ${site} request`;
  }
  return null;
}
// [port] No response may be framed, so a foreign page cannot load the app in a hidden <iframe>, where
// its requests would be same-origin and its /events socket a phantom operator. Set first, so a 403
// carries it too; the 404 and error handlers at the end keep it (Express's own drop every header).
app.use((_req: Request, res: Response, next: () => void) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  next();
});
app.use((req: Request, res: Response, next: () => void) => {
  const refusal = refusalFor(req.headers);
  if (refusal) {
    console.warn(`[bridge] refused ${req.method} ${req.path}: ${refusal}`);
    res.status(403).json({ error: `forbidden: ${refusal}` });
    return;
  }
  next();
});
app.use(express.json({ limit: '32mb' }));
app.use((req: Request, _res: Response, next: () => void) => {
  console.log(`[bridge] ${req.method} ${req.url.replace(/canvasKey=[^&]*/, 'canvasKey=…')}`); // [port] the key is never logged
  next();
});

// [port] A control POST only the bridge's own clients make: a JSON content-type cannot be sent
// cross-site without a CORS preflight, which this server never answers.
function requireJson(req: Request, res: Response, next: () => void): void {
  if (!/^application\/json\s*(;|$)/i.test(req.get('content-type') ?? '')) {
    res.status(415).json({ error: 'content-type: application/json required' });
    return;
  }
  next();
}

const server = http.createServer(app);
const eventsWss = new WebSocketServer({ noServer: true });
const syncWss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const refusal = refusalFor(req.headers); // [v9.11 #64] same Origin/Host check as every HTTP route
  if (refusal) {
    console.warn(`[bridge] refused a WebSocket upgrade: ${refusal}`);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
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
    const room = url.searchParams.get('room') ?? '';
    // [port] The render-canvas slot drives every agent's exec, shapes and image, so it takes the key
    // only this server's own Playwright page is given (canvasUrl). A page any site navigates to
    // /?role=agent loads the app same-origin, but cannot know the key.
    if (role !== 'human' && url.searchParams.get('canvasKey') !== CANVAS_KEY) {
      console.warn("[bridge] refused an /events upgrade: the render-canvas socket needs this server's canvas key");
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // [#64] An operator tab is admitted only for the room this process hosts, as on /sync: a tab left
    // on another board would otherwise show this board's chat and roster, and count in `humans` on
    // /canvas-status as though it were on this board. The render canvas (role=agent) is unchanged.
    if (role === 'human' && !hosts(room)) {
      console.warn(`[bridge] refused an /events upgrade for room '${room}': this server hosts '${activeRoomId}'`);
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    eventsWss.handleUpgrade(req, socket, head, (ws) => onEventsConnection(ws, role, room));
  } else if (pathname.startsWith('/sync/')) {
    const roomId = decodeURIComponent(pathname.slice('/sync/'.length));
    if (!roomId) {
      socket.destroy();
      return;
    }
    // [#64] Serve only the room this process hosts. A board keeps its port across restarts, so an
    // old tab for board X can reconnect to a port that board Y's server now holds, and a tab left on
    // X after an in-app switch reconnects to this server; creating X's room here would put a second
    // live copy of X in memory, and two servers would then write X's `.tldr`. switchRoom sets
    // activeRoomId before it answers /board/open, so the switcher's tab, which reconnects after that
    // answer, is admitted.
    if (!hosts(roomId)) {
      console.warn(`[sync] refused a sync upgrade for room '${roomId}': this server hosts '${activeRoomId}'`);
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    syncWss.handleUpgrade(req, socket, head, (ws) => {
      // Defensive: with no `verifyClient`, ws calls this callback synchronously, so the board cannot
      // change between the check above and here today. It is checked again so that a future async
      // `verifyClient`, which would let a switch land in between, cannot re-create an evicted room.
      if (!hosts(roomId)) {
        ws.close();
        return;
      }
      const syncSessionId = randomUUID();
      try {
        const entry = getOrCreateRoom(roomId);
        entry.room.handleSocketConnect({ sessionId: syncSessionId, socket: ws });
        console.log(`[sync] peer joined room '${roomId}' (${syncSessionId.slice(0, 8)})`);
      } catch (e) {
        // A room that cannot load, or a connect that fails, closes this socket and never the process.
        console.warn(`[sync] a peer could not join room '${roomId}': ${(e as Error).message}`);
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
// [#64] Each operator socket and the room it was admitted for, so an eviction closes that board's.
const humanSockets = new Map<WebSocket, string>();

function sendToRenderCanvas(frame: FrameToApp): boolean {
  if (!renderCanvasSocket || renderCanvasSocket.readyState !== WebSocket.OPEN) return false;
  renderCanvasSocket.send(JSON.stringify(frame));
  return true;
}

function broadcastToHumans(frame: FrameToApp): number {
  let n = 0;
  for (const ws of humanSockets.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      n++;
    }
  }
  return n;
}

// Correlated request/response over the render-canvas WS (exec, get-shapes).
type WsRequestType = 'exec' | 'get-shapes' | 'sync-health';
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; type: WsRequestType; socket: WebSocket };
const pending = new Map<string, Pending>();
// A request the render-canvas was sent and did not answer in time. Unlike 'render-canvas not
// connected', the canvas may have acted on it: an exec's blob may have drawn (runExec).
class WsNoAnswer extends Error {}
// A read whose bridge socket closed before its answer came: no answer can arrive on a closed socket,
// so it fails at once rather than at its timeout. `tooLarge`: the socket closed because a message from
// the canvas was larger than the bridge accepts (100 MiB), as an answer carrying one big asset is.
class WsClosed extends Error {
  constructor(message: string, readonly tooLarge: boolean) {
    super(message);
  }
}

function wsRequest<T>(type: WsRequestType, extra: Record<string, unknown> = {}, timeoutMs = WS_REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = renderCanvasSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error('render-canvas not connected'));
      return;
    }
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new WsNoAnswer(`ws request '${type}' timed out`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, type, socket });
    sendToRenderCanvas({ type, id, ...extra } as FrameToApp);
  });
}

// Fail every read still waiting on a bridge socket that has closed. An exec keeps its timer: its blob
// may still be running on the page, and runExec's timeout path is what ends it.
function failReadsOn(socket: WebSocket, tooLarge: boolean, why: string): void {
  for (const [id, p] of pending) {
    if (p.socket !== socket || p.type === 'exec') continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new WsClosed(`ws request '${p.type}' lost its socket before an answer (${why})`, tooLarge));
  }
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

function onEventsConnection(ws: WebSocket, role: string, room: string): void {
  if (role === 'human') {
    humanSockets.set(ws, room);
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
      case 'exec-result':
        settlePending(msg.id, null, { ok: msg.ok, result: msg.result, error: msg.error });
        break;
      case 'shapes-result':
        settlePending(msg.id, null, {
          shapes: msg.shapes,
          records: msg.records,
          digested: msg.digested,
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

  // A message from the canvas over `ws`'s 100 MiB limit is reported as an error whose code is
  // WS_ERR_UNSUPPORTED_MESSAGE_LENGTH. `ws` then sends the canvas a 1009 close and stops reading, so the
  // close event that follows carries 1006, as for any socket that ends without a close frame. The error,
  // not the close code, is what marks a socket closed on an oversized message.
  let tooLarge = false;
  ws.on('close', (code: number) => {
    if (renderCanvasSocket === ws) renderCanvasSocket = null;
    console.log('[bridge] render-canvas disconnected');
    failReadsOn(ws, tooLarge, `closed ${code}`);
  });
  ws.on('error', (e: Error & { code?: string }) => {
    if (e.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') tooLarge = true;
    console.warn('[bridge] /events(agent) ws error:', e.message);
  });
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
// [#64] clientKey -> the cursor color first assigned to it; never removed, like a board's known recipients.
const clientKeyColor = new Map<string, string>();
// [v4 §4] The caller's Claude Code transcript path, recorded for attribution and the
// on-demand reconciler (§8.2). Optional; never blocks registration; not built against yet.
const sessionToTranscriptPath = new Map<string, string>();

// [v7 #43] The AgentId registry: every recipient id ever registered, seeded with the reserved
// lead id. Added-to on every /session/register (below), and NEVER removed — not on unregister,
// not on death. That is exactly what keeps a dead worker addressable so a Send can wait for it
// (a registered-then-dead worker stays a valid recipient). 'everyone' is a broadcast keyword and
// is never added here.
// [#66] Kept per board and durable: `<name>.recipients.json` beside the board holds every worker key
// ever registered on it, written when a key first registers, so a restart forgets no recipient and a
// Send to a worker that has not re-registered yet is accepted and waits in its queue. Loaded with the
// board, unioned with the worker recipients on its Send log (each was a known recipient when it was
// stored, and a log written before this file existed names them), and dropped with the board's other
// state when a switch releases it (evictRoom).
const knownRecipientsByRoom = new Map<string, Set<string>>();
const RESERVED_EVERYONE = 'everyone';
const recipientsPathFor = (roomId: string): string => path.join(HOME, `${roomId}.recipients.json`);
function knownRecipientsFor(roomId: string): Set<string> {
  const cached = knownRecipientsByRoom.get(roomId);
  if (cached) return cached;
  const ids = new Set<string>(['lead']);
  const recorded: string[] = [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(recipientsPathFor(roomId), 'utf8'));
    if (Array.isArray(parsed)) for (const id of parsed) if (typeof id === 'string') recorded.push(id);
  } catch {
    /* no key registered on this board yet, or an unreadable file: the Send log below still seeds it */
  }
  const fromLog = loadMessages(roomId).filter((m) => m.author.kind === 'human').flatMap(targetIdsOf);
  for (const id of [...recorded, ...fromLog]) {
    if (id && id !== RESERVED_EVERYONE && !isGuest(id)) ids.add(id);
  }
  knownRecipientsByRoom.set(roomId, ids);
  return ids;
}
// Add a worker key to a board's registry, writing the file only when the key is new to the board.
function recordRecipient(roomId: string, id: string): void {
  const ids = knownRecipientsFor(roomId);
  if (ids.has(id)) return;
  ids.add(id);
  const p = recipientsPathFor(roomId);
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify([...ids].filter((k) => k !== 'lead'))}\n`);
    fs.renameSync(tmp, p);
  } catch (e) {
    console.warn(`[bridge] could not record recipient '${id}' for '${roomId}': ${(e as Error).message}`);
  }
}
// A valid AgentId = 'lead' or a worker clientKey ever registered on the hosted board, or a worker
// session live on this process now (one registered before a switch to this board). Not 'everyone'.
// The type predicate is where the runtime seam check narrows an untrusted string to a typed AgentId.
function isAgentId(id: string): id is AgentId {
  if (id === RESERVED_EVERYONE) return false;
  if (knownRecipientsFor(activeRoomId).has(id)) return true;
  const sid = clientKeyToSession.get(id);
  return !!sid && presence.has(sid) && !isGuest(id);
}

// [#64 SPEC #33] Guests: sessions that registered with `guest: true`, a second /whiteboard session
// on a board another session owns. A guest shows its cursor and draws, but it is never addressable:
// it is not a recipient (a Send to it is a 400), it is never revived, and a broadcast never waits on
// it. A guest is told from a worker by its key alone: a guest's clientKey starts with `guest-` and a
// worker's never does (see /session/register). The rule keeps no state, so it holds across a restart,
// and a guest key never enters a board's known recipients.
const GUEST_KEY_PREFIX = 'guest-';
const isGuest = (recipientId: string): boolean => recipientId.startsWith(GUEST_KEY_PREFIX);

// [#66] The clientKey a live session registered under, or null for a session this process does not
// hold: never registered, unregistered, registered with no key, or issued before a restart. Taking a
// Send (GET /next-instruction) and completing one (POST /instruction-complete) both change a
// recipient's delivery state, so each requires the caller's sessionId and serves only the session
// registered as that recipient. A refused session re-registers on its clientKey (idempotent) and
// retries with the sessionId that returns.
function registeredKeyOf(sessionId: string): string | null {
  const key = sessionToClientKey.get(sessionId);
  return key !== undefined && presence.has(sessionId) ? key : null;
}
const NOT_REGISTERED =
  'sessionId is not registered on this board (the bridge may have restarted): re-register with POST /session/register on your clientKey, then retry with the sessionId it returns';

type RegisterBody = { name?: unknown; color?: unknown; clientKey?: unknown; transcriptPath?: unknown; guest?: unknown };

app.post('/session/register', (req: Request, res: Response) => {
  const { name, color, clientKey, transcriptPath, guest } = (req.body ?? {}) as RegisterBody;
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'body.name (string) required' });
    return;
  }
  const cleanName = name.trim();
  const key = typeof clientKey === 'string' && clientKey ? clientKey : null;
  // [#64] A key holding `$`, `{` or `}` is a shell expansion that never ran, such as a guest key
  // copied inside single quotes: refuse it, so two sessions never share one literal key.
  if (key && /[${}]/.test(key)) {
    res.status(400).json({ error: 'clientKey must not contain $, { or }' });
    return;
  }
  const asGuest = guest === true;
  if (asGuest && (!key || key === 'lead' || key === RESERVED_EVERYONE)) {
    res.status(400).json({ error: 'a guest registers with its own clientKey, never "lead" or "everyone"' });
    return;
  }
  // [#64] A guest and a worker never share a key, by its prefix. A guest on a worker's key would take
  // that worker's session if it is live, and strand its queued Sends if it is not (a guest is never
  // revived); a worker on a guest's key would take the guest's session.
  if (key && asGuest && !isGuest(key)) {
    res.status(400).json({ error: `a guest's clientKey must start with "${GUEST_KEY_PREFIX}"` });
    return;
  }
  if (key && !asGuest && isGuest(key)) {
    res.status(400).json({ error: `only a guest's clientKey may start with "${GUEST_KEY_PREFIX}"` });
    return;
  }
  // [#64] A keyed agent keeps the color it was first given, so a revived worker comes back in the
  // same cursor color (the live dry run saw a revival switch it).
  const cleanColor =
    typeof color === 'string' && color
      ? color
      : (key ? clientKeyColor.get(key) : undefined) ?? CURSOR_COLORS[sessionCount % CURSOR_COLORS.length] ?? '#7C4DFF';
  if (key && !clientKeyColor.has(key)) clientKeyColor.set(key, cleanColor);
  const transcript = typeof transcriptPath === 'string' && transcriptPath ? transcriptPath : null;

  // [v7 #43] Record this agent id as ever-registered (both the rebind and new-session paths flow
  // through here). Never removed later, so the id stays a valid recipient across death/revival.
  // [#64] A guest is never a recipient, so its key is not recorded here.
  if (key && !asGuest) recordRecipient(activeRoomId, key);

  if (key) {
    const existing = clientKeyToSession.get(key);
    if (existing && presence.has(existing)) {
      presence.update(existing, { name: cleanName, color: cleanColor });
      if (transcript) sessionToTranscriptPath.set(existing, transcript);
      touch(existing);
      console.log(`[bridge] session rebind on clientKey: '${cleanName}' -> ${existing.slice(0, 8)}`);
      // [v6] A rebind can re-mark an absent worker present + rename it — refresh the strip.
      broadcastAgentStatusIfChanged();
      if (key === 'lead') { leadListenedAt = Date.now(); ringSoon(); } // [#64] a (re)registered lead is rung for any backlog
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
  if (key === 'lead') { leadListenedAt = Date.now(); ringSoon(); } // [#64] drain-on-open: the backlog rings the new lead
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
  res.json(withPending(sessionId, { ok: true, sessionId, state }));
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
//   LIFECYCLE MONITOR (health): signals, never acts. candidateWorkerIds, agentDisplayName, workersNeedingRevive (+ buildNudge/bridgeBaseUrl),
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
// `refetch` is set when this recipient was served the Send before and never completed it (§8.5).
type Instruction = { instruction: string; selection: string[]; id: string | null; at: number; for: string; broadcast?: boolean; refetch?: true };
// [v6] A waiter is bound to the worker recipient id it parked for. [v9.11 #64] Only workers park:
// the lead pulls through GET /pending.
type Waiter = { res: Response; timer: NodeJS.Timeout; sessionId: string | null; recipientId: string };
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
// "Was this delivery's holder seen within a window?" — the liveness probe of the worker lease sweep
// (window = STALL_MS). `deliveredBy` is the holder session (null on an undelivered slot); fall back to
// `deliveredAt` when there is no holder session to look up.
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
// the lead's doorbell rings for it and GET /pending hands it over as a teardown item, on which the
// lead performs the graceful /done (§8.3). In-memory only — a teardown is a live-session action, with
// nothing to persist. The flag is cleared the moment the item is fetched (consumption), so it is
// never issued twice, and again on /done as defensive cleanup for the natural-language-Send fallback path (which reaches
// /done without ever consuming a directive). A dropped directive response loses the signal; the
// operator simply presses close again — acceptable for the POC, and it can never loop.
// The value is when close was first pressed: the item carries it as `at`, so the lead can tell a Send
// typed after it ("wait, don't close") from one typed before.
const teardownRequestedRooms = new Map<string, number>();
function isTeardownRequested(roomId: string): boolean {
  return teardownRequestedRooms.has(roomId);
}
function setTeardownRequested(roomId: string): void {
  if (!teardownRequestedRooms.has(roomId)) teardownRequestedRooms.set(roomId, Date.now());
}
function clearTeardownRequested(roomId: string): void {
  teardownRequestedRooms.delete(roomId);
}
function teardownDirectiveFor(roomId: string): TeardownDirective {
  return { teardown: true, room: roomId, at: teardownRequestedRooms.get(roomId) ?? Date.now() };
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
// Take (and remove) the first waiter parked for a recipient.
function takeWaiterFor(recipientId: string): Waiter | null {
  const i = waiters.findIndex((w) => w.recipientId === recipientId);
  return i === -1 ? null : waiters.splice(i, 1)[0] ?? null;
}
function recipientIdsWithWaiters(): string[] {
  return [...new Set(waiters.map((w) => w.recipientId))];
}

// ---- lifecycle state (§6) ----------------------------------------------------------------------
// A single recipient's sub-state on a Send: identical rules to v5.1, keyed per recipient.
function subStateFor(msg: Message, recipientId: string): SendState {
  const slot = slotOf(msg, recipientId);
  if (slot?.completedAt != null) return 'done';
  // [v9.11 §8.5 #64] The LEAD has no lease and no 'stalled' state; its states are per item. Its own
  // pull (GET /pending) stamped receivedAt: fetched. Before that, the doorbell's record decides: not
  // heard, rung, or still queued (no ring yet).
  if (recipientId === 'lead') {
    if (msg.receivedAt != null) return 'fetched';
    if (msg.notHeardReason) return 'not-heard';
    return msg.rungAt != null ? 'rung' : 'queued';
  }
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

function instructionPayload(msg: Message, recipientId: string): Instruction {
  const payload: Instruction = {
    instruction: msg.text,
    selection: msg.selection ?? [],
    id: msg.id,
    at: msg.ts,
    for: recipientId,
  };
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
  if (sessionId) slot.deliveredBy = sessionId;
  else delete slot.deliveredBy; // an anonymous poll holds a lease that expires from deliveredAt
  touch(sessionId);
  clearReviveGrace(recipientId);
  rewriteMessages(msg.room);
  broadcastMessageState(msg);
  if (sessionId && presence.has(sessionId)) presence.setState(sessionId, 'thinking');
}

// [v9.11 §8.5] Serve a worker's Send. One this recipient was served before and never completed (its
// lease was reclaimed, or the server restarted: a worker's slot keeps deliveredAt on disk) carries
// `refetch: true`, because the earlier holder may have drawn part of it.
function serveInstruction(msg: Message, recipientId: string, sessionId: string | null): Instruction {
  const served = slotOf(msg, recipientId)?.deliveredAt != null;
  markDelivered(msg, recipientId, sessionId);
  const payload = instructionPayload(msg, recipientId);
  if (served) payload.refetch = true;
  return payload;
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
// reserved lead/everyone and minus guests [#64], so no guest is ever revived or listed as absent.
function candidateWorkerIds(roomId: string): Set<string> {
  const ids = new Set<string>();
  for (const m of loadMessages(roomId)) {
    if (m.author.kind !== 'human') continue;
    for (const rid of targetIdsOf(m)) {
      if (rid === 'lead' || rid === 'everyone' || isGuest(rid)) continue;
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
  const assigned = clientKeyColor.get(recipientId);
  if (assigned) return assigned;
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
    `  3. run the read-act turn on each returned Send, POST /instruction-complete {id,for:"${agentId}",sessionId:"<sessionId>"}, re-arm.`,
    `A 204 is a re-arm, not an exit. A 403 that says your sessionId is not registered means the bridge restarted: repeat step 1, then carry on with the new sessionId. A 403 naming another key means that Send or that for is not yours.`,
    `Do not stop looping while alive and cheap.`,
  ].join('\n');
}

// Every worker that needs a revive directive right now, oldest-waiting first. Read-only: the caller
// that hands a directive out opens its revive grace.
function workersNeedingRevive(roomId: string): ReviveDirective[] {
  const found: { id: string; ts: number }[] = [];
  const now = Date.now();
  for (const rid of candidateWorkerIds(roomId)) {
    if (isGuest(rid)) continue; // [#64] a guest is never revived
    if (waitersFor(rid).length > 0) continue; // a live poller for it → no revive
    if (inReviveGrace(rid)) continue; // already being revived
    // [#64] A worker holding a live lease is mid-Send, however quiet (a critic subagent can run for
    // minutes without a bridge call). Reviving it would put a second worker on one recipient. The
    // lease sweep is what decides a holder is dead: it drops the lease after STALL_MS of silence,
    // and only then does the worker become a revive candidate here.
    if (pendingFor(roomId, rid).some((m) => isLeased(rid, m.id))) continue;
    if (seenWithin(rid, REVIVE_QUIET_MS, now)) continue; // alive and busy, not dead
    const msg = nextPendingFor(roomId, rid); // an unleased pending Send exists (after the sweep)
    if (!msg) continue;
    found.push({ id: rid, ts: msg.ts });
  }
  found.sort((a, b) => a.ts - b.ts);
  // [v7 #45] Populate `nudge` here so every raise-site carries the same fixed text.
  return found.map(({ id }) => {
    const directive: ReviveDirective = { revive: id, nudge: buildNudge(id) };
    const name = agentDisplayName(id);
    if (name && name !== id) directive.name = name;
    return directive;
  });
}

// [v6] Service every parked worker waiter against the current log: hand each its own oldest pending
// Send. [v9.11 #64] The lead's Sends, the teardown directive and revive directives are not handed to
// a waiter: the doorbell rings the lead and it pulls them through GET /pending.
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
      waiter.res.json(serveInstruction(msg, rid, waiter.sessionId));
      progress = true;
      changed = true;
    }
    if (!progress) break;
  }
  if (changed) broadcastAgentStatusIfChanged();
}

// [ROUTER] [v5 §8.5] Notify path for a freshly-stored Send: it is already in the durable log, so just
// service the parked worker waiters and ring the lead's doorbell.
function deliverInstruction(msg: Message): void {
  serviceWaiters(msg.room);
  ringSoon(); // [#64] a lead Send (or a worker now needing revive) rings the lead's doorbell
}

// [v9.2] A worker lease's holder SESSION has a live parked long-poll waiter right now. Keyed on the
// holder session (the lease's deliveredBy), not the recipient — a live waiter is proof THAT session's
// process is alive and listening, so its lease must not be swept even after a long silence. Guards the null/anonymous holder (an anonymous lease carries no deliveredBy and is
// never spared here — it ages out on deliveredAt as before).
function sessionHasWaiter(sessionId: string | null | undefined): boolean {
  return !!sessionId && waiters.some((w) => w.sessionId === sessionId);
}

// [v6 §8] Lease/visibility-timeout sweep, per recipient. A delivered Send is a lease held by its
// consumer; if that consumer goes silent past STALL_MS the lease expires: reclaim it (drop from that
// recipient's inFlight), mark it stalled, and re-service (redeliver to a parked poller for that
// worker, or — with no poller — surface it to the lead as a revive item on its doorbell).
function sweepStalledLeases(): void {
  const now = Date.now();
  let reclaimedAny = false;
  for (const [roomId, arr] of messagesByRoom) {
    let reclaimedInRoom = false;
    for (const msg of arr) {
      if (msg.author.kind !== 'human') continue;
      let changedMsg = false;
      for (const rid of targetIdsOf(msg)) {
        if (!isLeased(rid, msg.id)) continue; // not leased by this recipient
        const slot = slotOf(msg, rid);
        if (!slot || slot.completedAt != null || slot.deliveredAt == null) continue;
        if (holderSeenWithin(slot.deliveredBy, slot.deliveredAt, STALL_MS, now)) continue; // lease still valid — the holder was seen recently
        // [v9.2] A deliberate pause (no bridge calls for >STALL_MS) must not reclaim the lease: a
        // parked waiter for the HOLDER session proves that session is alive and still listening. A
        // crashed holder's waiter is already gone (req.on('close') → removeWaiter), so a dead holder's
        // lease still reclaims and redelivers.
        if (sessionHasWaiter(slot.deliveredBy)) continue;
        dropLease(rid, msg.id); // expired → back to pending for this recipient (deliveredBy kept)
        changedMsg = true;
        reclaimedInRoom = true;
        console.log(`[bridge] lease expired for ${msg.id.slice(0, 8)} @${rid} (holder silent) — reclaimed`);
      }
      if (changedMsg) broadcastMessageState(msg); // now stalled (aggregate for a broadcast)
    }
    if (reclaimedInRoom) {
      serviceWaiters(roomId); // redeliver to any parked poller
      ringSoon(); // a worker with no poller now needs a revive: ring the lead
      reclaimedAny = true;
    }
  }
  if (reclaimedAny) broadcastAgentStatusIfChanged();
}

// ---- per-agent status (§7) ---------------------------------------------------------------------
// present(R): a live long-poll waiter exists for R, or a session registered as R was seen within
// STALL_MS. This is what separates 'queued'/'stalled' (present) from 'absent' (dead/never-spawned).
function present(recipientId: string, now: number): boolean {
  if (waitersFor(recipientId).length > 0) return true;
  return seenWithin(recipientId, STALL_MS, now);
}
// Whether a session registered as `recipientId` called the bridge within `windowMs`.
function seenWithin(recipientId: string, windowMs: number, now: number): boolean {
  const sid = clientKeyToSession.get(recipientId);
  if (!sid) return false;
  const seen = lastSeenBySession.get(sid);
  return seen != null && now - seen <= windowMs;
}

function lifecycleFor(roomId: string, recipientId: string, now: number): AgentStatus['lifecycle'] {
  const pend = pendingFor(roomId, recipientId);
  // [v9.11 §7 #64] The lead's status is read off its items, never off a listener: working while a
  // fetched Send is uncompleted; not-heard while any unfetched item is not heard; queued while one is
  // rung or waiting; idle when a lead session is registered with nothing pending; absent when none is.
  if (recipientId === 'lead') {
    if (pend.some((m) => m.receivedAt != null)) return 'working';
    if (pend.some((m) => m.notHeardReason) || [...bell.values()].some((e) => e.notHeard)) return 'not-heard';
    if (pend.length > 0) return 'queued';
    return leadSessionId() ? 'idle' : 'absent';
  }
  if (pend.some((m) => isLeased(recipientId, m.id))) return 'working'; // a live worker lease
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
    ...(isGuest(rid) ? { guest: true as const } : {}),
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
}

// The worker STALL_MS visibility-timeout sweep. [v9.11 #64] The lead has no lease to sweep: its
// Sends are rung until fetched.
const sweepTimer = setInterval(sweepStalledLeases, SWEEP_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

// [v6 §3] The worker self-park: a per-recipient long-poll. `?for=<worker recipient id>` picks the
// worker's own queue. Serves the oldest pending Send for that worker, else parks as a waiter for it;
// 204 on timeout is a re-arm. [v9.11 #64] Workers only: the lead does not long-poll, it pulls through
// GET /pending when its doorbell rings, so `for=lead` (or no `for`) is a 400 that says so.
// [#66] The worker's own registered sessionId is required: missing is a 400, and a session that is
// not registered, or is registered as another recipient, is a 403. A refused fetch serves, parks and
// stamps nothing. The unregistered 403 comes before the unknown-recipient 400, so a worker whose
// registration is gone (a restart forgets every session) is always told to re-register.
app.get('/next-instruction', (req: Request, res: Response) => {
  const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : '';
  const forId = typeof req.query.for === 'string' && req.query.for ? req.query.for : '';
  if (!forId || forId === 'lead') {
    res.status(400).json({ error: 'the lead does not long-poll: it fetches GET /pending?sessionId=<sid> when its doorbell rings; a worker passes for=<its recipient id>' });
    return;
  }
  if (!sessionId) {
    res.status(400).json({ error: 'query sessionId (your registered session id) required' });
    return;
  }
  const key = registeredKeyOf(sessionId);
  if (key === null) {
    res.status(403).json({ error: NOT_REGISTERED });
    return;
  }
  // [v7 #43] `for` is a consumer draining its own queue: it must be a registered worker AgentId.
  // 'everyone' is a broadcast keyword, not an AgentId — nobody drains it — so isAgentId rejects it.
  if (!isAgentId(forId)) {
    res.status(400).json({ error: `unknown recipient id: ${forId}` });
    return;
  }
  if (key !== forId) {
    res.status(403).json({ error: `sessionId is registered as '${key}', not '${forId}': a worker takes only its own queue` });
    return;
  }
  touch(sessionId);
  // [v7 #42] ENTANGLEMENT: a lifecycle-monitor sweep run opportunistically on a router call — a
  // poll is a chance to reclaim an expired lease before this recipient's queue is drained below.
  sweepStalledLeases();

  // 1) This worker's own oldest pending Send.
  const msg = nextPendingFor(activeRoomId, forId);
  if (msg) {
    const payload = serveInstruction(msg, forId, sessionId);
    console.log(`[bridge] /next-instruction served a pending Send for '${forId}' (drain)`);
    res.json(payload);
    broadcastAgentStatusIfChanged();
    return;
  }

  // 3) Park as a waiter for this recipient. Parking is proof this recipient is present, so clear any
  //    revive grace it was under (revival succeeded).
  clearReviveGrace(forId);
  const timer = setTimeout(() => {
    const i = waiters.findIndex((w) => w.res === res);
    if (i !== -1) {
      waiters.splice(i, 1);
      broadcastAgentStatusIfChanged();
    }
    res.status(204).end();
  }, LONGPOLL_MS);
  const waiter: Waiter = { res, timer, sessionId, recipientId: forId };
  waiters.push(waiter);
  broadcastAgentStatusIfChanged();
  req.on('close', () => {
    if (removeWaiter(waiter)) {
      clearTimeout(timer);
      broadcastAgentStatusIfChanged();
      ringSoon(); // a worker that stops waiting with work pending may now need a revive
    }
  });
});

// ===========================================================================
// LEAD PULL — GET /pending (SPEC §8.5, decision #64)
// ===========================================================================
// The lead's whole inbound queue in one immediate read. It never parks: it answers at once with
// every item the lead has not yet fetched, oldest first: the open-time canary, the lead's own
// Sends, then the operator's teardown directive, then worker revive directives. Fetching IS the
// receipt: each Send returned is stamped receivedAt (and deliveredAt/deliveredBy) by this call, so a
// Send reads `fetched` only because the lead's own call took it. The sessionId must be the session
// registered as the board's lead (clientKey 'lead'); no other caller can drain or stamp the lead's
// queue.
type SendItem = { kind: 'send'; id: string; instruction: string; selection: string[]; at: number; for: 'lead'; refetch?: true };
type TeardownItem = { kind: 'teardown' } & TeardownDirective;
type ReviveItem = { kind: 'revive' } & ReviveDirective;
type CanaryItem = { kind: 'canary'; id: string };
type LeadItem = CanaryItem | SendItem | TeardownItem | ReviveItem;

// The session registered as this board's lead (clientKey 'lead'), while its presence is live.
function leadSessionId(): string | null {
  const sid = clientKeyToSession.get('lead');
  return sid && presence.has(sid) ? sid : null;
}

// The lead's Sends it has not fetched yet, oldest first.
function unfetchedLeadSends(roomId: string): Message[] {
  return pendingFor(roomId, 'lead').filter((m) => m.receivedAt == null);
}

// The lead's whole inbound queue, taken: every item the lead has not fetched, oldest first, each Send
// stamped fetched. `all` adds the Sends it fetched and has not completed. Shared by GET /pending's
// immediate answer and by a parked lead waiter's (see leadWaiters).
function takeLeadItems(sessionId: string, all: boolean): LeadItem[] {
  sweepStalledLeases(); // a reclaimed worker lease surfaces as a revive directive below
  const roomId = activeRoomId;
  const now = Date.now();
  const items: LeadItem[] = [];
  const fetched: Message[] = [];
  if (canary && !canary.fetched) {
    canary.fetched = true;
    items.push({ kind: 'canary', id: canary.id });
  }
  for (const msg of unfetchedLeadSends(roomId)) {
    msg.receivedAt = now;
    msg.deliveredAt = now;
    msg.deliveredBy = sessionId;
    fetched.push(msg);
    items.push({ kind: 'send', id: msg.id, instruction: msg.text, selection: msg.selection ?? [], at: msg.ts, for: 'lead', ...(msg.refetch ? { refetch: true as const } : {}) });
  }
  if (fetched.length) {
    rewriteMessages(roomId);
    for (const msg of fetched) broadcastMessageState(msg);
    if (presence.has(sessionId)) presence.setState(sessionId, 'thinking');
  }
  // `?all=1` also returns the Sends this lead already fetched and has not completed (marked
  // `refetch: true`, receipt unchanged): the recovery read after a fetch whose response never
  // arrived, or after an autocompaction dropped a fetched Send from the lead's context.
  if (all) {
    for (const msg of pendingFor(roomId, 'lead')) {
      if (msg.receivedAt == null || fetched.includes(msg)) continue;
      items.push({ kind: 'send', id: msg.id, instruction: msg.text, selection: msg.selection ?? [], at: msg.ts, for: 'lead', refetch: true });
    }
  }
  if (isTeardownRequested(roomId)) {
    items.push({ kind: 'teardown', ...teardownDirectiveFor(roomId) });
    clearTeardownRequested(roomId);
  }
  for (const directive of workersNeedingRevive(roomId)) {
    openReviveGrace(directive.revive);
    items.push({ kind: 'revive', ...directive });
  }
  if (items.length) {
    console.log(`[bridge] /pending served ${items.length} item(s) to the lead`);
    syncBell(Date.now()); // fetched items leave the doorbell: no further rings for them
    broadcastAgentStatusIfChanged();
  }
  return items;
}

// [port] The lead's long-poll, for a harness with no inbox to ring (doorbell.mode "pull"):
// GET /pending?wait=<ms> parks when nothing is pending and answers as soon as an item arrives, from
// doorbellTick, which every item source reaches through ringSoon(). Its timeout answers
// `{"items":[]}`. A Send it hands over is fetched when the response is written; a lead whose response
// was lost reads it back with ?all=1, as after any lost fetch.
type LeadWaiter = { res: Response; sessionId: string; all: boolean; timer: NodeJS.Timeout };
const leadWaiters: LeadWaiter[] = [];
// When the lead last pulled, waited or registered: what keeps its Sends from reading "not heard"
// in pull mode (PULL_GRACE_MS).
let leadListenedAt: number | null = null;

function dropLeadWaiter(w: LeadWaiter): boolean {
  const i = leadWaiters.indexOf(w);
  if (i === -1) return false;
  leadWaiters.splice(i, 1);
  clearTimeout(w.timer);
  leadListenedAt = Date.now();
  return true;
}

// Answer the lead's parked waiter, if it has one and anything is pending. True when it answered.
function serveLeadWaiter(leadSid: string): boolean {
  const w = leadWaiters.find((x) => x.sessionId === leadSid);
  if (!w) return false;
  const items = takeLeadItems(w.sessionId, w.all);
  if (!items.length) return false;
  dropLeadWaiter(w);
  w.res.json({ items });
  return true;
}

app.get('/pending', (req: Request, res: Response) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  if (!sessionId) {
    res.status(400).json({ error: 'query sessionId (the lead session id) required' });
    return;
  }
  if (sessionId !== leadSessionId()) {
    res.status(403).json({ error: 'sessionId is not the lead session registered on this board' });
    return;
  }
  touch(sessionId);
  leadListenedAt = Date.now();
  const all = req.query.all === '1';
  const items = takeLeadItems(sessionId, all);
  const waitRaw = Number(req.query.wait);
  const wait = Number.isFinite(waitRaw) ? Math.min(Math.max(waitRaw, 0), LONGPOLL_MS) : 0;
  if (items.length || wait === 0) {
    res.json({ items });
    return;
  }
  const w: LeadWaiter = { res, sessionId, all, timer: setTimeout(() => {
    if (dropLeadWaiter(w)) res.json({ items: [] });
  }, wait) };
  leadWaiters.push(w);
  res.on('close', () => { dropLeadWaiter(w); }); // a lead that hung up is no longer waiting
});

// ===========================================================================
// LEAD DOORBELL — ring the owning session's inbox (SPEC §8.5, decision #64)
// ===========================================================================
// The inbox carries a doorbell, never a Send's content: a fixed ring the server authors from
// validated fields only (board slug, count pending, ring counter, newest item ref, the exact fetch
// command), so no operator or HTTP-supplied text ever reaches the session's inbox. The lead answers
// a ring by fetching GET /pending, and that fetch is the receipt. The inbox gives no receipt of its
// own (it drops silently on its rate limit, identical bodies within a short window, a full queue,
// or an expired hold), so every unfetched item is RE-RUNG on a bounded schedule (RERING_MS), each
// ring with a new counter so the inbox's duplicate filter never drops it, and once the schedule
// runs out the item is marked NOT HEARD so the operator's panel shows the absence. Pending items
// coalesce into one ring. A post that fails (ENOENT: the session exited; ECONNREFUSED: it was
// killed) marks the items it named not heard at once. Rings go to the owner's inbox only (the
// socket in this process's environment), and only once a lead session is registered, because the
// ring's fetch command names that session.
type LeadItemRef = { key: string; publicId: string; ref: string; since: number | null };
type BellEntry = { key: string; publicId: string; ref: string; since: number; firstRungAt: number | null; reRings: number; notHeard: NotHeardReason | null };
const bell = new Map<string, BellEntry>();
let ringCounter = 0;
let lastRingAt: number | null = null;
let lastRingOk: boolean | null = null;
let lastRingError: string | null = null;
let ringInFlight = false;

// A ring-safe reference to an item id: the id's letters, digits and dashes, at most 12 of them. A
// message id is client-chosen (it is the Send's idempotencyKey), so it is filtered before it can
// reach the inbox.
function safeRef(raw: string): string {
  return raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12) || 'item';
}

// [v9.11 §9 #64] The open-time canary: the first ring of a board's life. The open procedure asks
// for it (POST /canary), must see the ring arrive in its own session, and fetches the canary back
// through GET /pending, proving server, inbox, model and fetch together before it reports the board
// ready. Its id is a server nonce that only the ring carries: it is never logged, never put on a
// bridge response's `pending` field, and never listed on /canvas-status.
let canary: { id: string; fetched: boolean } | null = null;

// Every lead item not yet fetched, in /pending precedence (the canary first). Read-only.
function currentLeadItemRefs(roomId: string): LeadItemRef[] {
  const refs: LeadItemRef[] = [];
  if (canary && !canary.fetched) refs.push({ key: `canary:${canary.id}`, publicId: canary.id, ref: canary.id, since: null });
  for (const m of unfetchedLeadSends(roomId)) refs.push({ key: `send:${m.id}`, publicId: m.id, ref: safeRef(m.id), since: m.ts });
  if (isTeardownRequested(roomId)) refs.push({ key: 'teardown', publicId: 'teardown', ref: 'teardown', since: null });
  for (const d of workersNeedingRevive(roomId)) {
    refs.push({ key: `revive:${d.revive}`, publicId: `revive:${d.revive}`, ref: `revive-${safeRef(d.revive)}`, since: null });
  }
  return refs;
}

// The ids a bridge response carries in `pending` for this caller: the lead's unfetched items when
// the caller is the lead session, else none.
function pendingIdsFor(sessionId: string | null): string[] {
  if (!sessionId || sessionId !== leadSessionId()) return [];
  return currentLeadItemRefs(activeRoomId).filter((r) => !r.key.startsWith('canary:')).map((r) => r.publicId);
}
// Attach `pending: [ids]` to a bridge response body while the lead has unfetched items, so a lead
// mid-draw picks up a Send (or a stop) before its next draw call even if a ring is deferred.
function withPending<T extends object>(sessionId: string | null, body: T): T & { pending?: string[] } {
  const ids = pendingIdsFor(sessionId);
  return ids.length ? { ...body, pending: ids } : body;
}

function messageForKey(key: string): Message | undefined {
  if (!key.startsWith('send:')) return undefined;
  const id = key.slice('send:'.length);
  return loadMessages(activeRoomId).find((m) => m.id === id);
}

// Reconcile the doorbell with the current unfetched items: add new ones, drop fetched/cleared ones.
function syncBell(now: number): void {
  const refs = currentLeadItemRefs(activeRoomId);
  const live = new Set(refs.map((r) => r.key));
  for (const key of [...bell.keys()]) if (!live.has(key)) bell.delete(key);
  for (const r of refs) {
    if (bell.has(r.key)) continue;
    bell.set(r.key, { key: r.key, publicId: r.publicId, ref: r.ref, since: r.since ?? now, firstRungAt: null, reRings: 0, notHeard: null });
  }
}

function isDue(e: BellEntry, now: number): boolean {
  if (e.firstRungAt == null) return true;
  const offset = RERING_MS[e.reRings];
  return offset != null && now >= e.firstRungAt + offset;
}
function isExhausted(e: BellEntry, now: number): boolean {
  if (e.firstRungAt == null || e.reRings < RERING_MS.length) return false;
  return now >= e.firstRungAt + (RERING_MS[RERING_MS.length - 1] ?? 0) + NOT_HEARD_AFTER_MS;
}

// Mark entries not heard (persisting it on a Send). 'unanswered' is sticky until the item is
// fetched; the other two reasons clear when a later ring reaches the inbox.
function markNotHeard(entries: BellEntry[], reason: NotHeardReason, now: number): void {
  const changed: Message[] = [];
  for (const e of entries) {
    if (e.notHeard === reason || e.notHeard === 'unanswered') continue;
    e.notHeard = reason;
    // The canary's id is its nonce, and the lead reads this log, so the canary is logged by its kind.
    console.warn(`[doorbell] ${e.key.startsWith('canary:') ? 'the canary' : e.publicId} not heard (${reason})`);
    const msg = messageForKey(e.key);
    if (msg) {
      msg.notHeardReason = reason;
      msg.notHeardAt = now;
      changed.push(msg);
    }
  }
  if (changed.length) {
    rewriteMessages(activeRoomId);
    for (const msg of changed) broadcastMessageState(msg);
    broadcastAgentStatusIfChanged();
  }
}

// The ring: fixed text built only from validated fields. Never any Send text.
function ringText(count: number, counter: number, newestRef: string, leadSid: string): string {
  const board = activeRoomId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'board';
  const sid = leadSid.replace(/[^A-Za-z0-9-]/g, '');
  return `whiteboard ${board}: ${count} pending (ring ${counter}, newest ${newestRef}) for the /whiteboard skill. Fetch: curl -s 'http://${HOST}:${assignedPort}/pending?sessionId=${sid}'`;
}

async function ring(now: number, leadSid: string, socketPath: string): Promise<void> {
  const entries = [...bell.values()];
  const newest = entries.reduce((a, b) => (b.since >= a.since ? b : a));
  for (const e of entries) {
    if (!isDue(e, now)) continue;
    if (e.firstRungAt == null) e.firstRungAt = now;
    else e.reRings += 1;
  }
  ringCounter += 1;
  const counter = ringCounter;
  lastRingAt = now;
  ringInFlight = true;
  const outcome = await postToInbox(socketPath, INBOX_TOKEN, ringText(entries.length, counter, newest.ref, leadSid));
  ringInFlight = false;
  lastRingOk = outcome.ok;
  if (!outcome.ok) {
    lastRingError = `${outcome.code}: ${outcome.message}`;
    console.warn(`[doorbell] ring ${counter} failed (${outcome.code}); ${entries.length} item(s) not heard`);
    markNotHeard(entries, 'inbox-unreachable', Date.now());
    return;
  }
  lastRingError = null;
  console.log(`[doorbell] ring ${counter}: ${entries.length} pending`);
  const changed: Message[] = [];
  for (const e of entries) {
    if (e.notHeard && e.notHeard !== 'unanswered') e.notHeard = null;
    const msg = messageForKey(e.key);
    if (!msg || msg.receivedAt != null) continue;
    msg.rungAt = now;
    msg.ringCount = (msg.ringCount ?? 0) + 1;
    if (msg.notHeardReason && msg.notHeardReason !== 'unanswered') {
      delete msg.notHeardReason;
      delete msg.notHeardAt;
    }
    changed.push(msg);
  }
  if (changed.length) {
    rewriteMessages(activeRoomId);
    for (const msg of changed) broadcastMessageState(msg);
  }
  broadcastAgentStatusIfChanged();
}

// One doorbell evaluation: sync the items, mark the unreachable and the unanswered, and ring when
// any item is due (respecting the minimum gap, which coalesces bursts into one ring).
function doorbellTick(): void {
  if (shuttingDown) return;
  const now = Date.now();
  syncBell(now);
  if (bell.size === 0) return;
  const leadSid = leadSessionId();
  if (!leadSid) return; // nothing can name a fetch yet: items stay queued until the lead registers
  if (serveLeadWaiter(leadSid)) return; // [port] a parked lead takes them now: nothing left to ring
  const entries = [...bell.values()];
  if (!INBOX_SOCKET) {
    // [port] Pull mode: an item is heard by the lead's next pull, unless the lead has stopped pulling.
    const listening = leadWaiters.length > 0 || (leadListenedAt != null && now - leadListenedAt <= PULL_GRACE_MS);
    if (!listening) markNotHeard(entries, 'not-listening', now);
    return;
  }
  markNotHeard(entries.filter((e) => isExhausted(e, now)), 'unanswered', now);
  if (ringInFlight || !entries.some((e) => isDue(e, now))) return;
  if (lastRingAt != null && now - lastRingAt < RING_MIN_GAP_MS) {
    ringSoon(RING_MIN_GAP_MS - (now - lastRingAt));
    return;
  }
  void ring(now, leadSid, INBOX_SOCKET);
}

// Evaluate the doorbell shortly (debounced), after an event that may add an item.
let ringSoonTimer: NodeJS.Timeout | null = null;
function ringSoon(delayMs = 50): void {
  if (ringSoonTimer) return;
  ringSoonTimer = setTimeout(() => {
    ringSoonTimer = null;
    doorbellTick();
  }, delayMs);
}
const doorbellTimer = setInterval(doorbellTick, DOORBELL_TICK_MS);
if (typeof doorbellTimer.unref === 'function') doorbellTimer.unref();

function canaryBellState(): string {
  const e = canary ? bell.get(`canary:${canary.id}`) : undefined;
  if (!e) return 'queued';
  return e.notHeard ? 'not-heard' : e.firstRungAt != null ? 'rung' : 'queued';
}

// [v9.11 §9 #64] Ring the open-time canary. Lead-only. Answers once the canary's first ring has been
// attempted: 200 when the post reached the inbox socket, 502 with the error when it failed. Two 409s,
// told apart by their error strings, refuse it before any ring: the server's parent is not the
// session's Claude process (ownerIsClaude false: something such as npm sits between them), or this
// server has no inbox in its environment (it was not booted as a child of a Claude session).
// The answer never carries the canary id: only the ring does, so the open procedure must see the
// ring arrive and fetch the id back through GET /pending.
app.post('/canary', async (req: Request, res: Response) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: unknown };
  if (typeof sessionId !== 'string' || sessionId !== leadSessionId()) {
    res.status(403).json({ ok: false, error: 'sessionId is not the lead session registered on this board' });
    return;
  }
  if (OWNER_IS_CLAUDE === false) {
    res.status(409).json({ ok: false, error: "not booted as this session's child" });
    return;
  }
  if (!INBOX_SOCKET) {
    res.status(409).json({ ok: false, error: "no inbox socket in the server's environment" });
    return;
  }
  canary = { id: `canary-${randomUUID().replace(/-/g, '').slice(0, 8)}`, fetched: false };
  const key = `canary:${canary.id}`;
  doorbellTick();
  const deadline = Date.now() + 5_000;
  for (;;) {
    const e = bell.get(key);
    if (canary.fetched || (e && e.firstRungAt != null && !ringInFlight)) break;
    if (Date.now() >= deadline) break;
    await delay(50);
  }
  const e = bell.get(key);
  if (canary.fetched) {
    res.json({ ok: true, rung: true });
  } else if (!e || e.firstRungAt == null) {
    res.status(504).json({ ok: false, error: 'the canary ring was not attempted within 5s' });
  } else if (e.notHeard) {
    res.status(502).json({ ok: false, error: `the canary ring failed: ${lastRingError ?? e.notHeard}` });
  } else {
    res.json({ ok: true, rung: true });
  }
});

// The doorbell's state for /canvas-status: whether an inbox is configured, the ring counter and
// last outcome, and each unfetched item's state (queued, rung or not-heard).
function doorbellStatus(): Record<string, unknown> {
  return {
    inbox: !!INBOX_SOCKET,
    // [port] How the lead hears its items: rung on its inbox, or pulled by its long-poll.
    mode: INBOX_SOCKET ? 'inbox' : 'pull',
    leadWaiting: leadWaiters.length > 0,
    lead: !!leadSessionId(),
    rings: ringCounter,
    lastRingAt,
    lastRingOk,
    lastRingError,
    canary: canary ? (canary.fetched ? 'fetched' : canaryBellState()) : null,
    items: [...bell.values()].filter((e) => !e.key.startsWith('canary:')).map((e) => ({
      id: e.publicId,
      state: e.notHeard ? 'not-heard' : e.firstRungAt != null ? 'rung' : 'queued',
      ...(e.notHeard ? { reason: e.notHeard } : {}),
    })),
  };
}

// [v6 §3/§6] Completion ack: the durable gate. `{ id, for? }` (`for` defaults to the key the session
// registered on, #66). Non-
// broadcast: stamp top-level completedAt (v5 behavior), drop the lease. Broadcast: stamp
// delivery[for].completedAt, drop that recipient's lease, and set top-level completedAt only once
// EVERY broadcastTo entry has completed. Idempotent (repeat => alreadyComplete); unknown id -> 404.
// [#66] Completion is permanent (a completed Send is never served or rung again), so it carries the
// completing session's `sessionId` with the same check as GET /next-instruction: missing is a 400,
// unregistered a 403, and a session registered as anyone but the recipient whose copy this completes
// (the Send's recipient; on a broadcast, `for`) a 403. The lead passes its own sessionId too.
app.post('/instruction-complete', (req: Request, res: Response) => {
  const { id, for: forRaw, sessionId: sessionRaw } = (req.body ?? {}) as { id?: unknown; for?: unknown; sessionId?: unknown };
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'body.id (string) required' });
    return;
  }
  if (typeof sessionRaw !== 'string' || !sessionRaw) {
    res.status(400).json({ error: 'body.sessionId (your registered session id) required' });
    return;
  }
  const key = registeredKeyOf(sessionRaw);
  if (key === null) {
    res.status(403).json({ error: NOT_REGISTERED });
    return;
  }
  // `for` names whose copy of a broadcast this completes. Left out, it is the key the session
  // registered on, the only one the check below accepts on a broadcast, so a worker need not pass it.
  const forGiven = typeof forRaw === 'string' && forRaw ? forRaw : null;
  // [v7 #43] Validate a given recipient AFTER the id-required 400 and BEFORE the message lookup, so an
  // unknown recipient is a 400 while an unknown message id stays a 404.
  if (forGiven !== null && !isAgentId(forGiven)) {
    res.status(400).json({ error: `unknown recipient id: ${forGiven}` });
    return;
  }
  const forId = forGiven ?? key;
  const msg = loadMessages(activeRoomId).find((m) => m.id === id);
  if (!msg) {
    res.status(404).json({ error: 'unknown instruction id' });
    return;
  }
  const completesFor = msg.recipient?.kind === 'broadcast' ? forId : recipientIdOf(msg);
  if (key !== completesFor) {
    res.status(403).json({ error: `sessionId is registered as '${key}', not '${completesFor}': complete only your own Sends` });
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
// a recipient id other than the reserved 'lead'/'everyone', and not a guest [#64]). Frozen into a
// broadcast's broadcastTo at send time; empty (no workers) => the broadcast is vacuously done.
function currentWorkerRecipientIds(): string[] {
  const ids = new Set<string>();
  for (const [key, sid] of clientKeyToSession) {
    if (key === 'lead' || key === 'everyone' || isGuest(key)) continue;
    if (presence.has(sid)) ids.add(key);
  }
  return [...ids];
}

// [v4 §8.2] Idempotency across Send / agent voice is now the stored message `id` itself
// (persistent, survives reloads), replacing the old short-window TTL dedupe.
app.post('/message', (req: Request, res: Response) => {
  const { text, selection, idempotencyKey, name, recipient, room } = (req.body ?? {}) as {
    text?: unknown;
    selection?: unknown;
    idempotencyKey?: unknown;
    name?: unknown;
    recipient?: unknown;
    room?: unknown;
  };
  // [#64] The panel names the board it typed the Send on. A board keeps its port across restarts,
  // so a stale tab's retry can reach a port another board's server now holds; storing it here would
  // put the Send on the wrong board. Refuse it before the dedupe, so a matching id on this board can
  // never answer it 200. A body with no room (curl, the agent) keeps addressing the active board.
  if (room !== undefined && !hosts(room)) {
    res.status(409).json({ error: 'this server is hosting a different board' });
    return;
  }
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
  // [#64] A guest session is not addressable: it never long-polls a queue, so a Send to it would be
  // accepted and never delivered. Checked before the roster bound so the error says why.
  if (rcpt?.kind === 'worker' && isGuest(rcpt.id as string)) {
    res.status(400).json({ error: 'recipient is a guest session' });
    return;
  }
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
  if (!isRoomId(room)) {
    res.status(400).json({ error: `invalid room id '${room}'` }); // [port] never a path into another folder
    return;
  }
  const sinceRaw = req.query.since;
  const since = typeof sinceRaw === 'string' && sinceRaw !== '' ? Number(sinceRaw) : null;
  // [#64] Another room's log is read from disk and never cached: this process does not own it, and
  // a cached copy would be swept and rewritten here after another server took the board.
  const all = hosts(room) ? loadMessages(room) : readMessageLog(room).arr;
  const filtered = since !== null && Number.isFinite(since) ? all.filter((m) => m.ts > since) : all;
  // [v5.1] Attach the authoritative lifecycle state so the panel seeds badges correctly on load.
  const messages = [...filtered].sort((a, b) => a.ts - b.ts).map((m) => ({ ...m, state: sendState(m) }));
  res.json({ messages });
});

// [v9.1 §8.2/§9 #53] Operator teardown-request intake. A CONTROL signal, not a chat Message: the
// drawer's confirm-gated close-session affordance POSTs here (never /message), so it never enters
// the attributed log or a recipient queue. Sets the per-room teardownRequested flag and rings the
// lead's doorbell; the lead fetches it as a teardown item through GET /pending. Idempotent — setting it twice is a no-op 200. `room`
// optional: defaults to this process's single active board. [#64] A `room` this process does not host
// is a 409, as on /message: a stale tab's close would otherwise flag a board this server is not on.
app.post('/request-teardown', requireJson, (req: Request, res: Response) => {
  const { room } = (req.body ?? {}) as { room?: unknown };
  const roomId = typeof room === 'string' && room ? room : activeRoomId;
  if (!hosts(roomId)) {
    res.status(409).json({ error: 'this server is hosting a different board' });
    return;
  }
  setTeardownRequested(roomId);
  console.log(`[bridge] teardown requested for room '${roomId}'`);
  ringSoon(); // [#64] the teardown directive rings the lead's doorbell
  res.json({ ok: true });
});

// ===========================================================================
// SHAPES / EXEC / IMAGE relays to the render-canvas (SPEC §5/§6, FIX 4B)
// ===========================================================================
app.get('/shapes', async (req: Request, res: Response) => {
  const sid = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  touch(sid); // [v5.1] perceiving keeps the lease alive
  try {
    await afterSwitch();
    perceptionUnavailable();
    const result = await wsRequest<Record<string, unknown>>('get-shapes');
    res.json(withPending(sid, result));
  } catch (e) {
    res.status(503).json(withPending(sid, { error: (e as Error).message }));
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

// `sentAt` is when the bridge sent the blob. The server-owned render-canvas stamps `at` on the same
// machine's clock, so a stamp no earlier than it is this exec's or later. `recovery` is present when this exec's write was
// cut off and a recovery ran for it: its outcome.
type ExecResult = { ok: boolean; result?: unknown; error?: string; image: string | null; sentAt: number; recovery?: RecoveryOutcome };
type ExecRelayResult = { ok: boolean; result?: unknown; error?: string };

// Every 200 ok:false runExec answers ends with this (SPEC §5). A blob that throws keeps what it
// wrote before the throw (tldraw may roll back an editor.run the throw escapes), a severed write
// may be put back by recovery, and a blob the canvas did not answer drew until the reload that
// ended it, so the caller reads the board first. The stamps tell an update that landed from one
// that did not, until someone else edits that shape, and then the caller leaves it. The key keeps
// this answer, so the corrected write goes under a new one. A 503 is the only failure that never drew.
const MAY_HAVE_DRAWN =
  "this blob may have drawn: read /shapes (what it wrote carries your name and an at no earlier than this answer's sentAt, in meta.createdBy or meta.lastEditedBy), then redo only what did not land and no one else has edited since, under a new idempotencyKey";

// Idempotency cache: key -> in-flight/completed exec promise (FIX 4B). A duplicate key
// returns the SAME result without re-running the blob, whatever code it carries. A blob that
// never reached a canvas is not cached, so a genuine retry re-runs; every answer from a blob
// that was sent is, ok:false included, so a corrected blob needs a new key (MAY_HAVE_DRAWN).
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
// { kind:'agent', sessionId, name:'Agent', color: undefined }. The server never stamps meta.
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
// (documentClock advance preferred, shape-count delta as fallback), then pay one sync-health
// round-trip. A corrupted store, or a disconnected one when the room did not move, means the write
// was severed: report ok:false and hand off to server-owned recovery (recoverCorruptedCanvas).
const SYNC_CONFIRM_TIMEOUT_MS = 1500; // bounded wait for the room to reflect a write; tune here
const SYNC_CONFIRM_POLL_MS = 50;
const SYNC_HEALTH_TIMEOUT_MS = 1200; // WS budget for one sync-health probe (one per exec)
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
async function probeSyncHealth(timeoutMs = SYNC_HEALTH_TIMEOUT_MS): Promise<SyncHealth | null> {
  try {
    return await wsRequest<SyncHealth>('sync-health', {}, timeoutMs);
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
      // While the launcher runs a canvas it launched for a board a switch has since left, that page
      // is no canvas for this board: answer 503 before the blob reaches it, as perception does.
      if (renderCanvasRestarting && canvasRoom !== activeRoomId) throw new Error('render-canvas relaunching');
      const roomId = activeRoomId;
      const preClock = roomDocumentClock(roomId);
      const preShapes = roomShapeCount(roomId);
      let exec: ExecRelayResult;
      const sentAt = Date.now();
      try {
        exec = await wsRequest<ExecRelayResult>('exec', { code, author: resolveExecAuthor(sessionId) });
      } catch (e) {
        if (!(e instanceof WsNoAnswer)) throw e; // never sent: a 503, and a retry runs the blob
        // Sent and not answered: the blob may have drawn, in part or whole, and may still be running. It
        // is ended before the answer, so the caller's read is final. This is the exec's answer, not a
        // 503, and the idempotency key keeps it, so a retry never runs the blob a second time.
        const error = `the render-canvas did not answer within ${WS_REQUEST_TIMEOUT_MS / 1000} s, so ${MAY_HAVE_DRAWN}`;
        // Whatever ends the blob gets the time a plain reload alone had here (RECOVERY_DEADLINE_MS, the
        // reload's own bound), counted from now, so a page that stops answering costs no more than that.
        const deadline = Date.now() + RECOVERY_DEADLINE_MS;
        // A blob that corrupted the store before it stalled holds writes the room never got, and a plain
        // reload would discard them. So when the canvas still answers a sync-health probe and reads
        // corrupted, recovery runs instead: its reload or relaunch ends the blob too, and its harvest keeps
        // what the store held back. A recovery that ended neither way (it threw before reloading, for
        // one) is followed by the plain reload. A canvas that does not answer the probe (its page
        // blocked) gets the plain reload alone.
        const health = SYNC_GUARD_DISABLED || renderCanvasRestarting ? null : await probeSyncHealth();
        if (health?.possiblyCorrupted !== true) {
          await endUnansweredBlob(deadline - Date.now());
          return { ok: false, error, image: null, sentAt };
        }
        const reason = 'a corrupted canvas store';
        const ended = { blob: false };
        const recovery = await recoverCorruptedCanvas(roomId, reason, deadline, ended).catch((err) => recoveryFailed(reason, err as Error));
        if (!ended.blob) await endUnansweredBlob(deadline - Date.now());
        return { ok: false, error, image: null, sentAt, ...(recovery ? { recovery } : {}) };
      }

      let ok = exec.ok;
      let error = exec.error;
      let recovery: RecoveryOutcome | null = null;
      if (!SYNC_GUARD_DISABLED) {
        // The exec-result is not proof the write reached the room. Confirm it: wait for the room to
        // move, then probe the store's health whether it moved or not, because a peer's change moves
        // the room too and would hide a write the corrupted store cut off. A disconnect counts only
        // when the room did not move: a client that reconnects pushes what it holds.
        const advanced = await waitForRoomAdvance(roomId, preClock, preShapes, SYNC_CONFIRM_TIMEOUT_MS);
        const health = await probeSyncHealth();
        const corrupted = health?.possiblyCorrupted === true;
        const disconnected = !advanced && health !== null && !health.connectedToRoom;
        if (corrupted || (exec.ok && disconnected)) {
          // The write did not reach the room: the store is corrupted (push suppressed) or the
          // canvas is not joined. Report it honestly, then repair so the next write lands.
          ok = false;
          if (!error) error = 'sync-severed';
          // The answer carries the recovery's outcome, the line the panel shows, so the caller reads it
          // here rather than from the chat. A recovery that throws is answered as needing a manual repair.
          const reason = corrupted ? 'a corrupted canvas store' : 'a severed sync connection';
          recovery = await recoverCorruptedCanvas(roomId, reason, Date.now() + RECOVERY_DEADLINE_MS).catch((e) => recoveryFailed(reason, e as Error));
        }
        // else: healthy, and moved or connected (or no probe available): a landed write, or a
        // legitimately non-document-mutating exec (a read, a selection, a camera move). Leave exec.ok.
      }
      if (!ok) error = `${error ?? 'the blob failed'}; ${MAY_HAVE_DRAWN}`;

      // No image is asked of a canvas the launcher is replacing (a recovery handed it over): it would only
      // wait out its bound.
      let image: string | null = null;
      try {
        if (!renderCanvasRestarting) image = await requestImage();
      } catch (e) {
        console.warn('[bridge] post-exec image failed:', (e as Error).message);
      }
      return { ok, result: exec.result, error, image, sentAt, ...(recovery ? { recovery } : {}) };
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
        res.json(withPending(sid, await existing.promise));
      } catch (e) {
        res.status(503).json(withPending(sid, { ok: false, error: (e as Error).message }));
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
    res.json(withPending(sid, await promise));
  } catch (e) {
    // The blob never reached a canvas (none connected, or the launcher is running): a retry runs it.
    if (key) execIdem.delete(key);
    res.status(503).json(withPending(sid, { ok: false, error: (e as Error).message }));
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
  const sid = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
  touch(sid); // [v5.1] perceiving keeps the lease alive
  // [render-cap] ?bounds=x,y,w,h zooms in on a region; absent ⇒ downscaled whole-board bird's-eye.
  const bounds = parseBoundsParam(req.query.bounds);
  try {
    await afterSwitch();
    perceptionUnavailable();
    const p = await requestImage(WS_REQUEST_TIMEOUT_MS, bounds);
    // Echo the region that was actually applied (null = whole-board bird's-eye). A caller that
    // asked for a crop but typo'd its ?bounds= gets the overview back; without this echo it had
    // no way to tell its region was silently dropped and could "read" the wrong frame — the
    // #61 silent-wrong-frame hazard, reappearing for regions. Additive, within the 200 contract.
    res.json(withPending(sid, { path: p, bounds: bounds ?? null }));
  } catch (e) {
    res.status(503).json(withPending(sid, { error: (e as Error).message }));
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
    res.json(withPending(sid, { ok: true, deduped: true }));
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
  res.json(withPending(sid, { ok: true, humans }));
});

// ===========================================================================
// PERSISTENCE endpoints — legacy no-ops (SPEC §8: sync server owns persistence)
// ===========================================================================
app.post('/snapshot', (_req: Request, res: Response) => {
  res.json({ ok: true, noop: true });
});

app.get('/snapshot', async (req: Request, res: Response) => {
  let target = activeBoardPath;
  if (req.query.path) {
    const placed = boardFromRequest(req.query.path);
    if (!placed.ok) {
      res.status(placed.status).json({ error: placed.error });
      return;
    }
    target = placed.path;
  }
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
// [port] A board path a request names: a relative path resolves against the repository, and the file
// must be a .tldr inside the repository or the boards folder, in a folder that already exists
// (boards.mjs's placement rule), so no request reads or writes a file anywhere else.
type PlacedBoard = { ok: true; path: string } | { ok: false; status: number; error: string };
function boardFromRequest(raw: unknown): PlacedBoard {
  if (typeof raw !== 'string' || !raw) return { ok: false, status: 400, error: 'a board path is required' };
  const boardPath = canonicalBoardPath(path.resolve(REPO_ROOT, raw));
  const refusal = placementRefusal(boardPath, REPO_ROOT, HOME);
  if (refusal) return { ok: false, status: refusal.startsWith('outside') ? 403 : 400, error: refusal };
  return { ok: true, path: boardPath };
}

// [#64] An in-app switch is one transaction, serialized with execs (runExclusive): an exec captures
// activeRoomId and then awaits, so a switch landing mid-exec would confirm its write against the
// released room and could start a recovery against the wrong one. The one-server check runs in here
// too, where the lock is written: made before the queue, it went stale while an exec ran, and a server
// booted on the target board meanwhile lost its lock to this one.
//   1. Prepare: [#65] refuse while a server from before #64 runs on any board (findPre64Servers, the
//      boot's check), then claim the target's lock (claimLock, with its wait), then load the target's
//      room. A refusal or a board that cannot load changes nothing here, and a load failure releases
//      the lock just written.
//   2. Commit: the target becomes the active board.
//   3. Release the board left at once (evictRoom), so this process holds it for one save and one
//      flush, never through the navigation, and another server's claim waits milliseconds at most.
//   4. Answer: the switch has happened, and the answer says so before anything can fail.
//   5. Navigate the render canvas. A failure is recorded on /canvas-status (`lastNavError`) and
//      handed to the relaunch, which closes the old browser, dead or alive, and ends on the board
//      this process hosts, never the old one, clearing `lastNavError` when it succeeds. While a
//      relaunch runs the switch does not navigate: the relaunch is the only launcher, and it follows
//      the board to the new room. The navigation ends only on a canvas that answers and is connected,
//      an empty board included. From the commit until it ends, /image and /shapes wait for it, so
//      they answer for the new board, or 503 while the launcher runs (perceptionUnavailable).
type SwitchOutcome =
  | { kind: 'attach'; owner: LockOwner } // the target's owner serves it: the client attaches there
  | { kind: 'busy'; owner: LockOwner } // the owner is releasing it, or does not answer, past the wait
  | { kind: 'old'; servers: OldServer[] } // a server from before #64 runs: nothing claimed or released
  | { kind: 'unloadable'; error: string } // the target's file is not a room snapshot
  | { kind: 'unsaved'; error: string } // [port] the board left cannot be saved: nothing switched
  | { kind: 'failed'; error: string } // anything else that threw before the commit's answer
  | { kind: 'switched' };

// The last render-canvas navigation's failure, or null once a navigation or a relaunch succeeds.
let lastNavError: string | null = null;

function switchRoom(roomId: string, boardPath: string): Promise<SwitchOutcome> {
  return new Promise<SwitchOutcome>((answer) => {
    runExclusive(async () => {
      // 1. Prepare. [#65] A server from before #64 may hold the board it left in memory with no lock,
      // where claimLock cannot see it, so the switch is refused while one runs, on any board.
      const oldServers = await findPre64Servers();
      if (oldServers.length) {
        answer({ kind: 'old', servers: oldServers });
        return;
      }
      // [v8 §8.3] One server per board: a board another live process holds is attached to or
      // refused, never taken.
      const owner = await claimLock(roomId);
      if (owner) {
        answer(owner.state === 'active' ? { kind: 'attach', owner } : { kind: 'busy', owner });
        return;
      }
      const prevRoom = activeRoomId;
      if (roomId !== prevRoom) {
        try {
          getOrCreateRoom(roomId, boardPath);
        } catch (e) {
          removeLock(roomId);
          answer({ kind: 'unloadable', error: `board cannot be loaded: ${(e as Error).message}` });
          return;
        }
      }
      // [port] A board left that cannot be saved stays served and locked with nothing switched, rather
      // than released with its edits since the last save lost. Checked before the commit by writing its
      // snapshot beside it and dropping that copy (canSave), so the release keeps its one final flush.
      const prev = roomId !== prevRoom ? rooms.get(prevRoom) : undefined;
      if (prev && !canSave(prevRoom, prev)) {
        rooms.get(roomId)?.room.close();
        rooms.delete(roomId);
        removeLock(roomId);
        answer({ kind: 'unsaved', error: `the board '${prevRoom}' cannot be saved, so it stays open here; export it, then try again` });
        return;
      }
      // 2. Commit.
      beginSwitch();
      activeRoomId = roomId;
      activeBoardPath = boardPath;
      slugToPath.set(roomId, boardPath);
      latestImagePath = imagePathFor(boardPath);
      // Nothing after the commit may throw, or the board left would stay held: writePortRecord catches
      // its own write, and the cursor rebuild is caught here; each is logged on failure and the switch
      // goes on. Keep the new board on this port. The previous board's port record stays: it is that
      // board's port until its /done.
      writePortRecord();
      try {
        presence.switchRoom(roomId); // rebuild agent cursors against the new room
      } catch (e) {
        console.error(`[bridge] could not rebuild agent cursors for '${roomId}': ${(e as Error).message}`);
      }
      // 3. Release the board left.
      if (prevRoom !== roomId) await evictRoom(prevRoom);
      // 4. Answer.
      answer({ kind: 'switched' });
      // 5. Navigate. Still inside the queue, so an exec queued behind the switch runs on the new board,
      // unless the launcher is running: then the switch stands aside, and that exec answers 503.
      try {
        if (await navigateRenderCanvas(roomId)) lastNavError = null;
      } catch (e) {
        lastNavError = (e as Error).message;
        console.error(`[canvas] render-canvas navigation to '${roomId}' failed: ${lastNavError}`);
        void handleRenderCanvasDeath('navigation failed');
      }
    }).catch((e) => answer({ kind: 'failed', error: (e as Error).message })) // a no-op once answered
      .finally(endSwitch);
  });
}

// [render-cap] From a switch's commit until its navigation ends. /image and /shapes wait for it, so a
// request made after the commit is answered by the canvas on the new board, never by the page the
// navigation replaces (which would answer for the old board, or never). The wait has no bound of its
// own, as an /exec queued behind the switch has none: every step of the navigation is bounded, and a
// navigation that fails has set renderCanvasRestarting before the switch ends, so the request then
// answers 503 with `relaunching: true` (perceptionUnavailable).
let switchSettled: Promise<void> | null = null;
let settleSwitch: () => void = () => undefined;
function beginSwitch(): void {
  switchSettled = new Promise<void>((resolve) => { settleSwitch = resolve; });
}
function endSwitch(): void {
  switchSettled = null;
  settleSwitch();
}
async function afterSwitch(): Promise<void> {
  if (switchSettled) await switchSettled;
}

// [render-cap] While the launcher runs, no canvas is known to be on the hosted board: a page it launched
// for a board a switch has since left can still be connected. So /image and /shapes answer 503 at once,
// and /canvas-status reads `relaunching: true`, which SKILL's 503 rule waits out.
function perceptionUnavailable(): void {
  if (renderCanvasRestarting) throw new Error('render-canvas relaunching');
}

// [#64] Release a board this process stops hosting, so it is never served or written here again and
// a switch back reads it fresh from disk: another server may own and edit it once its lock is gone.
// It runs right after the switch's commit, so the board is held only for this: its sockets close
// first, so no edit arrives after the final snapshot; the save in flight lands; the final snapshot is
// flushed; the lock goes last. Until then the board stays in `held`, and another process's claim
// waits for it (awaitBoardFree) rather than loading a file this flush has not yet written.
async function evictRoom(roomId: string): Promise<void> {
  const entry = rooms.get(roomId);
  entry?.room.close();
  // Its operator tabs go too: reconnecting, they are refused (see the /events upgrade).
  for (const [ws, room] of humanSockets) {
    if (room !== roomId) continue;
    humanSockets.delete(ws);
    ws.close();
  }
  if (entry) {
    if (entry.saving) await entry.saving; // an older snapshot must not land after the final one
    persistRoomSync(roomId, entry);
    rooms.delete(roomId);
  }
  // The board's Send log goes with it, with this process's leases on its Sends and its teardown
  // flag: a switch back reloads the log from disk as a new owner would.
  for (const m of messagesByRoom.get(roomId) ?? []) for (const set of inFlightByRecipient.values()) set.delete(m.id);
  messagesByRoom.delete(roomId);
  messageIdsByRoom.delete(roomId);
  knownRecipientsByRoom.delete(roomId); // [#66] a switch back reloads it from `<name>.recipients.json`
  clearTeardownRequested(roomId);
  removeLock(roomId);
  console.log(`[sync] released room '${roomId}'`);
}

// The switch's outcome as the panel acts on it. 200 means the server is on the board the answer
// names (`attach: false`), or names another server's port to attach to (`attach: true`); a 409 or
// 422 means nothing changed and the panel stays on its board.
function answerSwitch(res: Response, verb: 'open' | 'new', roomId: string, boardPath: string, outcome: SwitchOutcome): void {
  switch (outcome.kind) {
    case 'attach':
      console.log(`[bridge] board ${verb} -> '${roomId}' already live at port ${outcome.owner.port} (pid ${outcome.owner.pid}); attach, do not steal`);
      res.json({ ok: true, attach: true, port: outcome.owner.port, path: boardPath, room: roomId });
      return;
    case 'busy': {
      const error = outcome.owner.state === 'releasing'
        ? 'board is being released by another server; try again'
        : 'board is held by another server that does not answer; try again';
      console.warn(`[bridge] board ${verb} -> '${roomId}' refused: pid ${outcome.owner.pid} on port ${outcome.owner.port} ${outcome.owner.state === 'releasing' ? 'is still releasing it' : 'does not answer'}`);
      res.status(409).json({ error });
      return;
    }
    case 'old': {
      // [#65] The panel shows `error` in the switcher; `oldServers` names each one for a caller.
      const error = `${describeOldServers(outcome.servers)}; stop it before switching boards`;
      console.warn(`[bridge] board ${verb} -> '${roomId}' refused: ${error}`);
      res.status(409).json({ error, oldServers: outcome.servers });
      return;
    }
    case 'unloadable':
      console.error(`[bridge] board ${verb} -> '${roomId}' refused: ${outcome.error}`);
      res.status(422).json({ error: outcome.error });
      return;
    case 'unsaved':
      console.error(`[bridge] board ${verb} -> '${roomId}' refused: ${outcome.error}`);
      res.status(503).json({ error: outcome.error });
      return;
    case 'failed':
      console.error(`[bridge] board ${verb} -> '${roomId}' failed: ${outcome.error}`);
      res.status(500).json({ error: outcome.error });
      return;
    case 'switched':
      console.log(`[bridge] board ${verb} -> ${boardPath} (room '${roomId}')`);
      res.json({ ok: true, attach: false, path: boardPath, room: roomId });
  }
}

app.post('/board/open', async (req: Request, res: Response) => {
  const { path: p } = (req.body ?? {}) as { path?: unknown };
  if (typeof p !== 'string' || !p) {
    res.status(400).json({ error: 'body.path required' });
    return;
  }
  const placed = boardFromRequest(p);
  if (!placed.ok) {
    res.status(placed.status).json({ error: placed.error });
    return;
  }
  const boardPath = placed.path;
  const roomId = boardName(boardPath);
  // [v8 §8.3] One server per board. If a live foreign process already hosts this board, DO NOT
  // switch in-process (that would steal its lock -> split-brain). Hand the client that process's
  // port so it attaches there instead. [#64] A process still releasing it, or not answering, after
  // the wait is a 409 with nothing switched: its port no longer serves the board, or may not answer.
  // [#65] So is a server from before #64 running on any board.
  // Unowned / stale-locked / our-own-board => switch in-process. switchRoom makes that check, where
  // it writes the lock.
  answerSwitch(res, 'open', roomId, boardPath, await switchRoom(roomId, boardPath));
});

app.post('/board/new', async (req: Request, res: Response) => {
  const { name } = (req.body ?? {}) as { name?: unknown };
  if (typeof name !== 'string' || !name) {
    res.status(400).json({ error: 'body.name required' });
    return;
  }
  const safe = slugFor(name); // [port] the one name rule, shared with scripts/whiteboard.sh --name
  const boardPath = path.join(HOME, `${safe}.tldr`);
  // [v8 §8.3] Same one-server guard as /board/open: a "new" board whose name collides with a
  // live board must attach to that owner, never steal its lock.
  answerSwitch(res, 'new', safe, boardPath, await switchRoom(safe, boardPath));
});

// `room` is the board's sync room id as this server names it (boardName), so the switcher joins the
// room switchRoom makes active rather than deriving a slug of its own, which the sync guard refuses.
type BoardListing = { name: string; path: string; source: 'home' | 'repo'; room: string };

async function listHomeBoards(): Promise<BoardListing[]> {
  const out: BoardListing[] = [];
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(HOME);
  } catch {
    /* home may be empty */
  }
  for (const e of entries) {
    if (e.endsWith('.tldr')) out.push({ name: boardName(e), path: path.join(HOME, e), source: 'home', room: boardName(e) });
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
    if (!byPath.has(full)) byPath.set(full, { name: boardName(full), path: full, source: 'repo', room: boardName(full) });
  }
  res.json([...byPath.values()]);
});

// ===========================================================================
// PLAYWRIGHT render-canvas (SPEC §3, §11)
// ===========================================================================
let browser: Browser | null = null;
let canvasPage: Page | null = null;
let canvasRoom: string | null = null;
// [render-cap] True while the one launcher runs (the boot launch, or a relaunch): its re-entry guard,
// what a switch's navigation stands aside for, and `relaunching` on /canvas-status.
let renderCanvasRestarting = false;
// Why the launcher last started: the cause handleRenderCanvasDeath was given, as 'page crashed'; which
// run of the launcher that is, counted from 1; and whether that run is the boot launch.
let relaunchCause = '';
let launcherRun = 0;
let launcherBoot = false;
// [render-cap] The canvas generation. Bumped by every launch attempt and every close, so a launch or a
// verify that resumes after its attempt was given up on finds a newer canvas and acts on nothing.
let canvasGen = 0;

// [port] The URL carries the canvas key; logs name canvasLogUrl, which does not.
const canvasLogUrl = (roomId: string): string => `http://${HOST}:${assignedPort}/?role=agent&room=${encodeURIComponent(roomId)}`;
const canvasUrl = (roomId: string): string => `${canvasLogUrl(roomId)}&canvasKey=${encodeURIComponent(CANVAS_KEY)}`;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// [render-cap] Every wait on a Chromium is bounded: Playwright gives evaluate and newPage no timeout,
// and a renderer that stops answering would hold its caller for good. A call that runs out rejects
// with CanvasTimeout; the work itself is not cancelled, which canvasGen makes harmless.
const CANVAS_CALL_TIMEOUT_MS = 15_000; // newPage, one evaluate: a page whose main thread is blocked longer than this, by an export or anything else, is taken for dead
const CANVAS_NAV_TIMEOUT_MS = 30_000; // launch, goto, reload, and a loaded page's bridge socket connecting
// A backstop over a whole launch attempt, above the sum of its bounded steps' normal worst case.
const CANVAS_ATTEMPT_TIMEOUT_MS = envMs('WHITEBOARD_CANVAS_ATTEMPT_MS', 120_000);
class CanvasTimeout extends Error {}
class CanvasSuperseded extends Error {}
function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CanvasTimeout(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

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
// A page that does not answer within CANVAS_CALL_TIMEOUT_MS throws CanvasTimeout: it is not rendering.
async function countRenderedShapes(page: Page): Promise<number> {
  try {
    return await withTimeout(page.evaluate((): number => {
      const doc = (globalThis as unknown as { document?: { querySelectorAll(sel: string): { length: number } } }).document;
      return doc ? doc.querySelectorAll('.tl-shape').length : 0;
    }), CANVAS_CALL_TIMEOUT_MS, 'the render-canvas');
  } catch (e) {
    if (e instanceof CanvasTimeout) throw e;
    return 0;
  }
}

// Boot-race guard (confirmed failure mode): the boot-launched render-canvas can connect
// to /sync BEFORE the room's initialSnapshot is applied and then sit permanently EMPTY,
// even though the room holds shapes. Late-joining pages are unaffected. So after loading
// the canvas, if the room has shapes, verify the canvas actually rendered some; if not,
// reload-and-retry (up to 3 attempts). An empty room legitimately renders 0.
// It verifies `page`, never whatever canvasPage holds by then, and stops once `current()` is false: a
// newer canvas has replaced the one it was called for. Then, on every path, the empty room included,
// the canvas must be ready (awaitCanvasReady): a launch or a navigation ends only on a canvas that
// answers and is connected. `since` is the bridge socket before the page's load began.
async function verifyCanvasSynced(roomId: string, context: string, page: Page, current: () => boolean, since: WebSocket | null): Promise<void> {
  await verifyCanvasRendered(roomId, context, page, current);
  await awaitCanvasReady(roomId, context, page, current, since);
}

// A bridge socket the canvas opened since `since` is up. The socket from before the load does not
// count: it belongs to the page this load replaces.
const newCanvasSocketUp = (since: WebSocket | null): boolean =>
  !!renderCanvasSocket && renderCanvasSocket !== since && renderCanvasSocket.readyState === WebSocket.OPEN;

// [render-cap] Ready means the page answers and its bridge socket is up, so an /exec queued behind the
// launch or navigation reaches it. Both waits are bounded: a page that does not answer within
// CANVAS_CALL_TIMEOUT_MS, or answers but has not connected within CANVAS_NAV_TIMEOUT_MS more, throws
// CanvasTimeout, which fails the attempt or the navigation and hands the canvas to the launcher. A
// launch whose board a switch has since left stops waiting: that room's sync is refused once it is not
// hosted, so its page never connects, and the launcher relaunches into the hosted board at no cost.
async function awaitCanvasReady(roomId: string, context: string, page: Page, current: () => boolean, since: WebSocket | null): Promise<void> {
  const superseded = (): CanvasSuperseded => new CanvasSuperseded(`${context}: superseded by a newer render-canvas`);
  if (!current()) throw superseded();
  await withTimeout(page.evaluate(() => true), CANVAS_CALL_TIMEOUT_MS, 'the render-canvas');
  const deadline = Date.now() + CANVAS_NAV_TIMEOUT_MS;
  while (!newCanvasSocketUp(since)) {
    if (!current()) throw superseded();
    if (roomId !== activeRoomId) return; // the board moved on; the launcher will not use this canvas
    if (Date.now() >= deadline) throw new CanvasTimeout(`${context}: the render-canvas did not connect its bridge socket within ${CANVAS_NAV_TIMEOUT_MS} ms`);
    await delay(100);
  }
}

async function verifyCanvasRendered(roomId: string, context: string, page: Page, current: () => boolean): Promise<void> {
  const expected = roomShapeCount(roomId);
  if (expected === 0) {
    console.log(`[canvas] ${context}: room '${roomId}' has no shapes; empty canvas is correct`);
    return;
  }
  const superseded = (): CanvasSuperseded => new CanvasSuperseded(`${context}: superseded by a newer render-canvas`);
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await waitForCanvasSocket(5_000);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (!current()) throw superseded();
      const rendered = await countRenderedShapes(page);
      if (rendered > 0) {
        console.log(`[canvas] ${context}: synced — rendered ${rendered} shape node(s) (room has ${expected})`);
        return;
      }
      await delay(400);
    }
    if (attempt < MAX_ATTEMPTS) {
      if (!current()) throw superseded();
      console.log(`[canvas] sync incomplete, reloading (attempt ${attempt})`);
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: CANVAS_NAV_TIMEOUT_MS });
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
// a severed render-canvas is a fresh store: reload the canvas and let it re-hydrate from the room. The
// severed write lives only in the corrupted store, so recovery harvests that store's document records
// first and, after the reload, writes into the room itself what the canvas changed there and never sent. Bounded (RECOVERY_MAX_ATTEMPTS reloads per incident, all within RECOVERY_DEADLINE_MS, then surface loudly instead of looping a
// reload) and serialized: callers already hold runExclusive, so this uses the low-level WS helpers
// directly and never re-enters the mutex.
const RECOVERY_MAX_ATTEMPTS = 2;
const RECOVERY_COOLDOWN_MS = 1000;
const RECOVERY_REHYDRATE_TIMEOUT_MS = 6000;
// Every request and wait of one recovery, harvest to answer, is bounded by what is left of this, however
// many assets it reads: the time a plain reload of the canvas may take, so on the timeout path recovery
// costs the answer no more than the plain reload it replaces. A wait it cuts short is a request left
// unanswered.
const RECOVERY_DEADLINE_MS = CANVAS_NAV_TIMEOUT_MS;
const remainingMs = (deadline: number): number => deadline - Date.now();
// A request's bound inside a recovery: its usual bound, or what is left of the recovery's time.
const boundedMs = (deadline: number, usual: number): number => Math.max(1, Math.min(usual, remainingMs(deadline)));
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

// The document records recovery puts back and removes: everything a blob can write, on every page.
// Puts go in this order, so a page or an asset is in the room before a shape on it or using it, and a
// shape before a binding to it; removals go in the reverse.
const RECOVERED_TYPES = ['page', 'asset', 'shape', 'binding'] as const;
const recoveredRank = (typeName: string): number => (RECOVERED_TYPES as readonly string[]).indexOf(typeName);
type DocRecord = { id: string; typeName: string; parentId?: string; fromId?: string; toId?: string; props?: Record<string, unknown> };
const isDocRecord = (r: unknown): r is DocRecord =>
  !!r && typeof r === 'object' && typeof (r as DocRecord).id === 'string' && recoveredRank((r as DocRecord).typeName) >= 0;

// What the corrupted canvas held: every page, asset, shape and binding in its document, and the room
// clock its store had caught up to. The clock is read before the records, so every room change the
// records may lack is later than it. `unread` lists the assets the canvas held that the harvest could
// not take, each with why:
// - 'too large': its answer was more than one websocket message to the bridge may carry (100 MiB), so
//   the same asset fails the same way again;
// - 'no answer': the canvas did not answer within the request's bound or the recovery's time, or had
//   stopped answering or gone down, so it was not asked;
// - 'unreadable': the canvas answered without records;
// - 'gone': the canvas no longer held it when asked, and the room did not hold it either.
type UnreadCause = 'too large' | 'no answer' | 'unreadable' | 'gone';
type Harvest = { records: DocRecord[]; seenClock: number; unread: Map<string, UnreadCause> };

// An asset's inline data (`props.src`, the image itself under the app's inline asset store) as the
// harvest compares it: the SHA-256 digest of its UTF-8 bytes, which the app computes the same way.
const assetDigest = (src: string): string => `sha256:${createHash('sha256').update(src, 'utf8').digest('hex')}`;

async function harvestCanvas(roomId: string, deadline: number): Promise<Harvest | null> {
  // The harvest reads the canvas it began on. A canvas that goes down is closed with its generation
  // (closeDeadBrowser), and one launched since from the room cannot say what the one that went down
  // held, so nothing asked or answered after the generation changed is taken from it.
  const gen = canvasGen;
  const wentDown = (): boolean => canvasGen !== gen;
  const health = await probeSyncHealth(boundedMs(deadline, SYNC_HEALTH_TIMEOUT_MS));
  // A canvas that cannot say what it has seen is taken to have seen the room as it stands now.
  const seenClock = typeof health?.lastServerClock === 'number' && health.lastServerClock >= 0 ? health.lastServerClock : roomDocumentClock(roomId);
  try {
    // The app sends each asset with its inline data replaced by its digest, and lists those assets in
    // `digested`, so the answer stays small however many images the board holds. An asset the room
    // holds the same, data and all, is taken from the room; any other is asked for whole, one at a
    // time, so no answer carries more than one asset's data.
    if (wentDown()) throw new Error('the canvas went down before it was read');
    const res = await wsRequest<{ records?: unknown; digested?: unknown }>('get-shapes', { records: true, digestAssets: true }, boundedMs(deadline, WS_REQUEST_TIMEOUT_MS));
    if (wentDown()) throw new Error('the canvas went down before it answered');
    if (!Array.isArray(res.records)) throw new Error('the canvas answered without its document records');
    const digested = new Set(Array.isArray(res.digested) ? res.digested.filter((id): id is string => typeof id === 'string') : []);
    const records: DocRecord[] = [];
    const unread = new Map<string, UnreadCause>();
    // Once the canvas leaves one request unanswered, or goes down, it is not asked again: each further
    // request would only wait out its own bound, or reach a canvas that never held the asset.
    let silent = false;
    for (const record of (res.records as unknown[]).filter(isDocRecord)) {
      if (!digested.has(record.id)) {
        records.push(record);
        continue;
      }
      const inRoom = rooms.get(roomId)?.room.getRecord(record.id) as DocRecord | undefined;
      const roomSrc = inRoom?.props?.src;
      if (inRoom && typeof roomSrc === 'string' && isDeepStrictEqual({ ...inRoom, props: { ...inRoom.props, src: assetDigest(roomSrc) } }, record)) {
        records.push(inRoom);
        continue;
      }
      // An asset the canvas cannot send whole is left unread, and the rest of the harvest is still
      // delivered. A socket closed by an earlier, oversized answer is back within about a second.
      if (!silent && !wentDown()) await waitForCanvasSocket(Math.max(0, Math.min(5_000, remainingMs(deadline))));
      if (wentDown()) silent = true;
      if (silent || remainingMs(deadline) <= 0) {
        unread.set(record.id, 'no answer');
        continue;
      }
      try {
        const whole = await wsRequest<{ records?: unknown }>('get-shapes', { records: true, ids: [record.id] }, boundedMs(deadline, WS_REQUEST_TIMEOUT_MS));
        if (wentDown()) {
          console.warn(`[recover] could not read ${record.id} whole: the canvas went down before it answered`);
          silent = true;
          unread.set(record.id, 'no answer');
          continue;
        }
        if (!Array.isArray(whole.records)) {
          console.warn(`[recover] could not read ${record.id} whole: the canvas answered without the asset it was asked for`);
          unread.set(record.id, 'unreadable');
          continue;
        }
        const held = (whole.records as unknown[]).filter(isDocRecord).find((r) => r.id === record.id);
        if (held) {
          records.push(held);
          continue;
        }
        // Absent from a well-formed answer of the canvas that listed it: that canvas removed it since.
        // The room's copy, if it holds one, stays as the room holds it. If not, the asset is held back
        // with what needs it, since putting those back would leave them pointing at nothing.
        const nowInRoom = rooms.get(roomId)?.room.getRecord(record.id) as DocRecord | undefined;
        if (nowInRoom) records.push(nowInRoom);
        else unread.set(record.id, 'gone');
      } catch (e) {
        console.warn(`[recover] could not read ${record.id} whole: ${(e as Error).message}`);
        if (e instanceof WsNoAnswer) silent = true;
        unread.set(record.id, e instanceof WsClosed && e.tooLarge ? 'too large' : 'no answer');
      }
    }
    return { records, seenClock, unread };
  } catch (e) {
    console.warn(`[recover] harvest failed: ${(e as Error).message}`);
    return null;
  }
}

// The records another record needs in the room: a shape's page or parent shape and the asset it
// shows, and a binding's two shapes.
const referencesOf = (record: DocRecord): string[] =>
  [
    record.typeName === 'shape' ? record.parentId : undefined,
    record.typeName === 'shape' ? record.props?.assetId : undefined,
    record.typeName === 'binding' ? record.fromId : undefined,
    record.typeName === 'binding' ? record.toId : undefined,
  ].filter((id): id is string => typeof id === 'string');

// Write back, in one room transaction, what the corrupted canvas changed and never sent, on every
// page: each harvested record the room lacks or holds a different copy of, and the removal of each
// page, asset, shape or binding the room holds that the canvas no longer had.
// - A record the room changed after the canvas last heard from it is left as the room holds it: a
//   peer (the operator, another tab) moved past the harvest. So is a harvested record that needs one
//   the canvas held and the room no longer does: a peer removed it, and putting the record back would
//   leave it pointing at nothing.
// - A record the canvas removed stays while a record staying in the room needs it (its page or parent
//   shape, a shape a binding binds, an asset a shape shows), so a peer's change that needs it keeps it.
// - A record that needs one the room lacks because it did not go in (an asset the harvest could not
//   read, a record the room's schema refused, or one held back for either) is held back too.
// A record goes in whole, as the canvas held it, author stamps included; every client receives the
// transaction as a remote change, so no app stamps it and it is on no canvas's undo stack. Returns the
// records it meant to put, the ids it meant to remove, the ids it left to a peer's change (`kept`),
// the ids the canvas removed that stay because a record in the room needs them (`retained`), the ids
// the room's schema refused, the ids it held back (`withheld`), and the assets it could not read.
type Delivery = { intended: DocRecord[]; removed: string[]; kept: string[]; retained: string[]; refused: string[]; withheld: string[]; unread: string[] };
function deliverHarvest(roomId: string, harvest: Harvest): Delivery {
  const entry = rooms.get(roomId);
  if (!entry) throw new Error(`room '${roomId}' is not open`);
  const delivery: Delivery = { intended: [], removed: [], kept: [], retained: [], refused: [], withheld: [], unread: [...harvest.unread.keys()] };
  const kept = new Set<string>();
  const harvested = new Map(harvest.records.map((record) => [record.id, record]));
  // What the canvas held that does not go in as it held it: the assets the harvest could not read, and
  // the records the schema refuses or the put-back holds back, added as the puts run.
  const blocked = new Set<string>(harvest.unread.keys());
  // A shape inside a harvested group or frame goes in after its parent.
  const depth = (record: DocRecord): number => {
    let n = 0;
    for (let p = harvested.get(record.parentId ?? ''); p && p.typeName === 'shape' && n < 100; p = harvested.get(p.parentId ?? '')) n++;
    return n;
  };
  const order = [...harvest.records].sort((a, b) => recoveredRank(a.typeName) - recoveredRank(b.typeName) || depth(a) - depth(b));
  entry.room.storage.transaction((txn) => {
    const since = txn.getChangesSince(harvest.seenClock);
    const moved = new Set<string>(since ? [...Object.keys(since.diff.puts), ...since.diff.deletes] : []);
    for (const record of order) {
      const inRoom = txn.get(record.id);
      if (inRoom && isDeepStrictEqual(inRoom, record)) continue; // the room has it already
      const lacking = referencesOf(record).filter((id) => !txn.get(id));
      if (moved.has(record.id) || lacking.some((id) => harvested.has(id) && !blocked.has(id))) {
        kept.add(record.id);
        continue;
      }
      if (lacking.some((id) => blocked.has(id))) {
        delivery.withheld.push(record.id);
        blocked.add(record.id);
        continue;
      }
      delivery.intended.push(record);
      try {
        (ROOM_SCHEMA.types as Record<string, { validate: (r: unknown, prev?: unknown) => unknown }>)[record.typeName]!.validate(record, inRoom ?? undefined);
      } catch (e) {
        console.warn(`[recover] the room refused ${record.id}: ${(e as Error).message}`);
        delivery.refused.push(record.id);
        blocked.add(record.id);
        continue;
      }
      txn.set(record.id, record as never);
    }
    // A record the canvas had seen (the room has not changed it since) and no longer held is one the
    // canvas deleted. An asset it held and could not send is not.
    const gone = new Set<string>();
    for (const [id, record] of txn.entries()) {
      if (recoveredRank((record as DocRecord).typeName) < 0 || harvested.has(id) || blocked.has(id)) continue;
      if (moved.has(id)) {
        kept.add(id);
        continue;
      }
      gone.add(id);
    }
    // What a record staying in the room needs stays with it, and so does what that needs in turn.
    for (let changed = true; changed; ) {
      changed = false;
      for (const [id, record] of txn.entries()) {
        if (gone.has(id)) continue;
        for (const ref of referencesOf(record as DocRecord)) {
          if (!gone.has(ref)) continue;
          gone.delete(ref);
          delivery.retained.push(ref);
          changed = true;
        }
      }
    }
    const removals = [...gone].sort((a, b) => recoveredRank((txn.get(b) as DocRecord).typeName) - recoveredRank((txn.get(a) as DocRecord).typeName));
    for (const id of removals) txn.delete(id);
    delivery.removed.push(...removals);
  });
  delivery.kept = [...kept];
  return delivery;
}

// Recovery's success test: the room holds every record recovery meant to put, as it meant to put it,
// and none it meant to remove. A cut-off create, update or delete of any page, asset, shape or binding
// that is not in the room fails it, unless the put-back left it to a peer's change (`kept`) or kept a
// removed record that a record in the room needs (`retained`). A peer's change does not pass it,
// because it compares records, not the room's clock. An asset the harvest could not read and a record
// the put-back held back fail it too, and are named with the rest.
function undelivered(roomId: string, delivery: Delivery): string[] {
  const entry = rooms.get(roomId);
  const notPut = [...delivery.withheld, ...delivery.unread];
  if (!entry) return [...delivery.intended.map((record) => record.id), ...notPut, ...delivery.removed];
  return [
    ...delivery.intended.filter((record) => !isDeepStrictEqual(entry.room.getRecord(record.id), record)).map((record) => record.id),
    ...notPut,
    ...delivery.removed.filter((id) => entry.room.getRecord(id) !== undefined),
  ];
}

// ["3 shapes", "2 bindings"]: records counted by kind, read from their ids (`shape:…`).
function countByKind(ids: string[]): string[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const kind = id.slice(0, id.indexOf(':'));
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return ['shape', 'binding', 'page', 'asset'].filter((kind) => counts.has(kind)).map((kind) => `${counts.get(kind)} ${kind}${counts.get(kind) === 1 ? '' : 's'}`);
}
const listOf = (parts: string[]): string => (parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

// Force a fresh render-canvas store. In production the canvas is a server-owned Playwright page, so a
// reload loads a clean store that re-hydrates from the room. With no page (the headless test harness,
// or an externally-driven canvas) the bridge's only lever is the socket: drop it so a fresh canvas
// reconnects, which mirrors the reload. A page that has not reloaded within `timeoutMs` throws.
async function reloadRenderCanvasForRecovery(timeoutMs: number): Promise<void> {
  if (canvasPage) {
    await withTimeout(canvasPage.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs }), timeoutMs, 'the render-canvas reload');
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
  const deadline = Date.now() + timeoutMs;
  const first = await probeSyncHealth(boundedMs(deadline, SYNC_HEALTH_TIMEOUT_MS));
  if (!first) {
    await delay(Math.max(0, Math.min(500, remainingMs(deadline))));
    return;
  }
  if (first.connectedToRoom) return;
  while (Date.now() < deadline) {
    const health = await probeSyncHealth(boundedMs(deadline, SYNC_HEALTH_TIMEOUT_MS));
    if (health?.connectedToRoom) return;
    await delay(150);
  }
}

// Whether a read of /shapes now reaches a canvas that has received the room as it stands at `clock`: no
// launcher is running, since perception answers 503 while one does, and the canvas's sync client, which
// applies what the room sends before it advances lastServerClock, has reached that clock. A canvas that
// cannot say (no sync client exposed) is taken to have it, as the harvest takes its clock to be the
// room's. Polled until `deadline`.
async function canvasHasCaughtUp(clock: number, deadline: number): Promise<boolean> {
  for (;;) {
    if (!renderCanvasRestarting) {
      const health = await probeSyncHealth(boundedMs(deadline, SYNC_HEALTH_TIMEOUT_MS));
      if (!renderCanvasRestarting && health && (health.lastServerClock === null || health.lastServerClock >= clock)) return true;
    }
    if (remainingMs(deadline) <= 0) return false;
    await delay(50);
  }
}

// A blob the canvas did not answer may still be running. Left alone it would draw after the caller has
// read the board and written what was missing, and under the author of whichever exec runs next. A
// reload ends every script on the page, so the server-owned canvas is reloaded before the answer, and
// the answer waits until the fresh canvas is back in the room. A canvas that does not come back is
// handed to the launcher, which closes it, and perception answers 503 until it is up. Without a
// server-owned page (a test's fake canvas) the bridge cannot end the blob. The reload gets `reloadMs`
// (CANVAS_NAV_TIMEOUT_MS, less what the timeout path has already spent of it).
async function endUnansweredBlob(reloadMs = CANVAS_NAV_TIMEOUT_MS): Promise<void> {
  const page = canvasPage;
  // Skipped while the launcher runs: it closes the page a blob ran on, or, for one sent to its own new
  // page, reloads it or finishes (about 120 ms after it connects) well inside WS_REQUEST_TIMEOUT_MS.
  if (!page || renderCanvasRestarting) return;
  const since = renderCanvasSocket;
  const ms = Math.max(1, Math.min(reloadMs, CANVAS_NAV_TIMEOUT_MS));
  try {
    await withTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: ms }), ms, 'the render-canvas reload');
    await awaitCanvasReady(activeRoomId, 'the reload that ends an unanswered blob', page, () => canvasPage === page, since);
    await waitForRoomRehydration(RECOVERY_REHYDRATE_TIMEOUT_MS);
  } catch (e) {
    console.warn(`[canvas] the reload that ends an unanswered blob failed: ${(e as Error).message}; relaunching`);
    void handleRenderCanvasDeath('did not come back from the reload that ends an unanswered blob');
  }
}

// A recovery's outcome, which the /exec answer it ran for carries as `recovery`: the line it posted to
// the panel, whether that line says the board recovered, and, once the put-back ran: when it did not
// recover, the ids of the records the room does not hold as the canvas did (`missing`), with why for
// each asset in it the harvest could not take (`why`); and the ids it left as the room holds them
// (`kept`), those left to a peer's change and the removed ones a record in the room needs.
type RecoveryOutcome = { recovered: boolean; text: string; missing?: string[]; why?: Record<string, UnreadCause>; kept?: string[] };

// A test-only fault (WHITEBOARD_TEST_RECOVERY_THROW=1): recovery throws once its reload is done, so a
// test can pin the answer to a recovery that stops on an error. Only the value 1 arms it; the skill
// never sets it, and the server warns at boot when it is armed (armedTestHooks).
const RECOVERY_THROW_FOR_TEST = process.env.WHITEBOARD_TEST_RECOVERY_THROW === '1';

// A recovery that threw before it posted its outcome: posted and answered as one needing a manual repair.
function recoveryFailed(reason: string, e: Error): RecoveryOutcome {
  console.warn(`[recover] recovery failed: ${e.message}`);
  const text = `Manual recovery needed: the recovery after ${reason} stopped on an error (${e.message}), so the last write may be missing from the board. Read the board and redraw what is missing.`;
  try {
    postSystemMessage(text);
  } catch {
    /* the answer still carries the line */
  }
  return { recovered: false, text };
}

// Recovery runs inside `deadline` (RECOVERY_DEADLINE_MS after it began, or after an unanswered exec
// timed out): every request and wait in it is bounded by what is left. `ended.blob` is set once a reload
// has completed or a canvas still corrupted is in the launcher's hands, either of which ends a blob still
// running.
async function recoverCorruptedCanvas(roomId: string, reason: string, deadline: number, ended: { blob: boolean } = { blob: false }): Promise<RecoveryOutcome | null> {
  if (recovering.get(roomId)) return null; // an incident for this room is already being handled
  recovering.set(roomId, true);
  const launcherAtStart = renderCanvasRestarting;
  const runAtStart = launcherRun;
  try {
    // 1. Harvest the corrupted canvas (a read is not suppressed by corruption).
    const harvest = await harvestCanvas(roomId, deadline);

    // 2. Fresh store → reconnect → re-hydrate from the room, until the store is clean.
    let healthy = false;
    let attempts = 0;
    let reloadMs = 0;
    let reloadError: Error | null = null;
    try {
      for (let attempt = 1; attempt <= RECOVERY_MAX_ATTEMPTS && !healthy; attempt++) {
        if (attempt > 1) await delay(Math.max(0, Math.min(RECOVERY_COOLDOWN_MS, remainingMs(deadline))));
        if (remainingMs(deadline) <= 0) break;
        attempts++;
        reloadMs = boundedMs(deadline, CANVAS_NAV_TIMEOUT_MS);
        await reloadRenderCanvasForRecovery(reloadMs);
        ended.blob = true;
        await waitForCanvasSocket(Math.max(0, Math.min(10_000, remainingMs(deadline))));
        await waitForRoomRehydration(Math.max(0, Math.min(RECOVERY_REHYDRATE_TIMEOUT_MS, remainingMs(deadline))));
        const health = await probeSyncHealth(boundedMs(deadline, SYNC_HEALTH_TIMEOUT_MS));
        healthy = !health || health.possiblyCorrupted === false;
      }
    } catch (e) {
      reloadError = e as Error;
      console.warn(`[recover] reload failed: ${reloadError.message}`);
    }
    // Who replaces a canvas still corrupted, and why, which the line names. The launcher closes the page,
    // which ends whatever ran on it, and launches a fresh canvas from the room, which the put-back below
    // reaches like any other change.
    // - The launcher is already running: the canvas went down during the recovery (a crash, its browser
    //   closing, or a fault in its driver), or a launch was already under way when it began. A reload in
    //   progress then fails.
    // - A server-owned page whose reload failed or did not finish in the time it was given, or that the
    //   recovery had no time left to reload, is handed to the launcher here.
    // Without a server-owned page (a test's fake canvas, or one driven from outside) the server cannot
    // replace it, and the line asks for a reload or a restart.
    // A launcher run that began during the recovery means the canvas went down during it; the run under
    // way when the recovery began, if it is still the one running, is named as that run.
    const launcherWhy = (): string =>
      launcherAtStart && launcherRun === runAtStart
        ? launcherBoot
          ? 'it was still being launched at boot when the recovery began'
          : `it was already being relaunched (${relaunchCause}) when the recovery began`
        : `it went down during the recovery (${relaunchCause})`;
    let relaunchWhy: string | null = null;
    if (!healthy && renderCanvasRestarting) {
      relaunchWhy = launcherWhy();
    } else if (!healthy && canvasPage && (reloadError || attempts === 0)) {
      const timedOut = reloadError instanceof CanvasTimeout || reloadError?.name === 'TimeoutError';
      relaunchWhy = !reloadError
        ? "the recovery's time ran out before a reload could begin"
        : timedOut
          ? `it did not reload within the ${reloadMs < 1000 ? `${reloadMs} ms` : `${(reloadMs / 1000).toFixed(1)} s`} the recovery had left`
          : `its reload failed (${reloadError.message.split('\n')[0]})`;
      void handleRenderCanvasDeath(!reloadError ? 'had no time left to reload in a recovery' : timedOut ? 'did not reload within a recovery\'s time' : 'failed to reload during a recovery');
    }
    const relaunched = relaunchWhy !== null;
    if (relaunched) ended.blob = true;
    if (RECOVERY_THROW_FOR_TEST) throw new Error('a test-only fault after the reload');

    // 3. Put back what the room is missing of the harvest, whether or not the canvas came back clean.
    let delivery: Delivery | null = null;
    if (harvest) {
      try {
        delivery = deliverHarvest(roomId, harvest);
      } catch (e) {
        console.warn(`[recover] delivery failed: ${(e as Error).message}`);
      }
    }

    // 4. Recovered: the canvas is clean, the room holds everything recovery meant to deliver, and the
    // canvas a read of /shapes reaches shows it, with no launcher running, so a read made on the answer
    // does too.
    const missing = delivery ? undelivered(roomId, delivery) : null;
    const keptIds = delivery ? [...delivery.kept, ...delivery.retained] : [];
    const kept = keptIds.length ? { kept: keptIds } : {};
    const delivered = healthy && !!delivery && !!missing && missing.length === 0;
    const shown = delivered && (await canvasHasCaughtUp(roomDocumentClock(roomId), deadline));
    if (delivery && shown) {
      const n = delivery.intended.length;
      const r = delivery.removed.length;
      const k = delivery.kept.length;
      const t = delivery.retained.length;
      const changes = listOf([...countByKind(delivery.intended.map((record) => record.id)), ...(r ? [`${r} deletion${r === 1 ? '' : 's'}`] : [])]);
      const put = changes !== '' ? `put back ${changes} the corrupted canvas had not sent to the room` : k + t === 0 ? 'the room was missing nothing' : 'put back nothing';
      const left = k === 0 ? '' : ` ${listOf(countByKind(delivery.kept))} stay${k === 1 ? 's' : ''} as the room holds ${k === 1 ? 'it' : 'them'}, after someone's change during the recovery.`;
      const retained = t === 0 ? '' : ` ${listOf(countByKind(delivery.retained))} the canvas removed stay${t === 1 ? 's' : ''}, because a record in the room needs ${t === 1 ? 'it' : 'them'}.`;
      const text = `Recovered the board after ${reason}. Reloaded the canvas and ${put}.${left}${retained}`;
      postSystemMessage(text);
      console.log(`[recover] room '${roomId}' recovered after ${reason} (${n} record(s) put back, ${r} removed, ${k} left to a peer's change, ${t} kept for a record that needs them)`);
      return { recovered: true, text, ...kept };
    }
    const putBack = !harvest ? 'the corrupted canvas could not be read' : !missing ? 'the room could not be written' : `${missing.length} change${missing.length === 1 ? '' : 's'} could not be put back in the room`;
    // When the reload's probe read the store clean or went unanswered, and a launcher run that began during
    // the recovery is running now, the canvas went down during the recovery: the line says so, and so why
    // a read answers 503 until it is back. It may have gone down before the reload, which then reached the
    // launcher's new page or none, so the reloaded-but line does not then open by saying it was reloaded.
    const downSince = healthy && renderCanvasRestarting && launcherRun !== runAtStart ? ` The canvas went down during the recovery (${relaunchCause}), and the server is relaunching it from the room.` : '';
    const text = relaunched
      ? `Manual recovery needed: the recovery after ${reason} could not reload the canvas: ${relaunchWhy}, so the server is relaunching it from the room${!harvest || !missing || missing.length ? `, and ${putBack}` : ''}. The last write may be missing from the board. Read the board and redraw what is missing.`
      : !healthy
        ? `Manual recovery needed: the board could not be repaired after ${reason} (${attempts === 0 ? "the recovery's time ran out before a reload could begin" : `tried ${attempts} time${attempts === 1 ? '' : 's'}`}). The canvas may be frozen. Reload it, or restart the whiteboard.`
        : delivered
          ? `Manual recovery needed: the room holds what recovery put back after ${reason}, but the reloaded canvas had not shown it when the recovery's time ran out.${downSince} Read the board again in a few seconds, then redraw what is still missing.`
          : `Manual recovery needed: ${downSince ? `in the recovery after ${reason}, ${putBack}` : `the canvas was reloaded after ${reason}, but ${putBack}`}, so the last write may be missing from the board.${downSince} Read the board and redraw what is missing.`;
    postSystemMessage(text);
    const detail = relaunched ? `the canvas is relaunched: ${relaunchWhy}` : !healthy ? `the canvas store is still corrupted after ${attempts} reload attempt(s)` : delivered ? 'the canvas had not caught up with the put-back' : !harvest ? 'the harvest failed' : !missing ? 'the delivery failed' : `not in the room: ${missing.join(', ')}`;
    console.warn(`[recover] room '${roomId}' NOT recovered after ${reason} (${detail})`);
    const why = harvest && missing ? Object.fromEntries([...harvest.unread].filter(([id]) => missing.includes(id))) : {};
    return { recovered: false, text, ...(missing && missing.length ? { missing } : {}), ...(Object.keys(why).length ? { why } : {}), ...kept };
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

// [render-cap] Fail every request still parked on the page a switch's navigation replaced (an /image
// waiter, or a /shapes request): no answer to it can arrive once the page is gone. It records no export
// health, unlike failPendingImageWaiters: the canvas is not failing, the request was caught by the
// switch, and a retry lands on the new board. It fails every entry, which is right only while every
// wsRequest caller but /shapes runs inside runExclusive with the switch, and /shapes waits for it.
function failParkedRequests(reason: string): void {
  for (const w of imageWaiters.splice(0, imageWaiters.length)) {
    clearTimeout(w.timer);
    w.reject(new Error(reason));
  }
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(reason));
  }
}

// [render-cap] Null the handles (so browserUp stops lying) and close the old browser, dead or alive.
// Called to bury a dead browser, to clean up a PARTIAL launch — chromium.launch() can succeed while
// newPage/goto/verifyCanvasSynced then throws, leaving `browser` non-null with no working page;
// nulling here keeps browserUp honest on that failure path — and to close a live one the relaunch
// replaces (a failed navigation, or a launch the board moved away from). Its 'disconnected' listener
// stays attached: Playwright's own close() waits on that event, and the identity guard in
// launchRenderCanvas ignores it, because `browser` is nulled before the close. It bumps canvasGen, so
// a launch or verify still running for the browser it closes acts on nothing.
const CANVAS_CLOSE_TIMEOUT_MS = 3_000;
async function closeDeadBrowser(): Promise<void> {
  const dead = browser;
  canvasGen++;
  browser = null;
  canvasPage = null;
  if (!dead) return;
  // Bounded at 3 s so the relaunch moves on. The close itself goes on: Playwright's close() kills a
  // browser that has not closed after 30 s, so an abandoned one is gone within 30 s.
  const closed = await Promise.race([dead.close().then(() => true, () => true), delay(CANVAS_CLOSE_TIMEOUT_MS).then(() => false)]);
  if (!closed) console.warn(`[canvas] the old render-canvas did not close within ${CANVAS_CLOSE_TIMEOUT_MS} ms; abandoned`);
}

// [render-cap] Is the current render-canvas actually usable? Catches the case where the browser
// process died (isConnected false), the page renderer crashed, or it stopped answering (no answer by
// the check's own deadline) during a relaunch's own verify window — where the re-entry guard would
// otherwise swallow the death and leave a dead-but-non-null handle reading healthy.
// The check has one 15 s deadline, and watches the page it started on, and that page's browser, until it
// ends. A page that crashes or closes, or whose browser disconnects, reads dead when that happens, even
// while the evaluate waits for a new document's context, a wait Playwright does not end when the page
// dies. A close is named before the check returns, which waits at most 50 ms: `its browser disconnected`
// if the browser disconnects by then, as one that is killed or quits does, and `it closed` if it stays
// up. A page that does not answer reads dead at the deadline. A page that navigates while it is asked
// (a reload, or a page reloading itself) drops the document the evaluate was sent to, and Playwright
// rejects it with the message below, for which it has no error class. Such a page is asked again, on the
// document that replaced it, 250 ms after each ask a navigation drops, until the deadline. A check that
// met a navigation writes one log line when it ends, with how often it asked again and how it ended.
// Any other rejection reads dead when it comes.
const NAVIGATED_DURING_EVALUATE = 'Execution context was destroyed, most likely because of a navigation';
const ASK_AGAIN_PAUSE_MS = 250; // a page that navigates on every document is asked at most 60 times in 15 s
const CLOSE_CAUSE_WAIT_MS = 50; // a close waits at most this long for its browser to disconnect before it is named
const times = (n: number): string => (n === 1 ? 'once' : `${n} times`);
async function canvasPageAlive(): Promise<boolean> {
  const b = browser;
  const page = canvasPage;
  if (!b || !b.isConnected() || !page || page.isClosed()) return false;
  const deadline = Date.now() + CANVAS_CALL_TIMEOUT_MS;
  const timers: NodeJS.Timeout[] = [];
  const after = (ms: number, outcome: string): Promise<string> =>
    new Promise((resolve) => { timers.push(setTimeout(() => resolve(outcome), Math.max(0, ms))); });
  const timedOut = `it did not answer within ${CANVAS_CALL_TIMEOUT_MS / 1000} s`;
  const expired = after(CANVAS_CALL_TIMEOUT_MS, timedOut);
  let died: (outcome: string) => void = () => undefined;
  const death = new Promise<string>((resolve) => { died = resolve; });
  let browserWent: () => void = () => undefined;
  const browserGone = new Promise<string>((resolve) => { browserWent = () => resolve('its browser disconnected'); });
  const onCrash = (): void => died('it crashed');
  const onClose = (): void => died('it closed');
  const onDisconnected = (): void => { browserWent(); died('its browser disconnected'); };
  // Playwright reports a dead browser's page closes before the browser's own close: together for a browser
  // that is killed or crashes, and milliseconds apart for one that quits on a signal (SIGTERM, SIGINT,
  // SIGHUP) or on close(). So the check stops waiting at a close, and names it when the browser disconnects
  // or 50 ms pass, whichever comes first: `its browser disconnected`, or `it closed`. The wait uses the
  // check's own disconnect listener and timer list, which the finally removes and clears.
  const cause = async (o: string): Promise<string> =>
    o !== 'it closed' ? o : Promise.race([browserGone, after(CLOSE_CAUSE_WAIT_MS, o)]);
  page.on('crash', onCrash);
  page.on('close', onClose);
  b.on('disconnected', onDisconnected);
  let navigated = 0;
  let askedAgain = 0;
  let outcome = '';
  try {
    for (;;) {
      const ask = page.evaluate(() => true).then(
        () => 'it answered',
        (e: unknown) => {
          const message = String((e as Error)?.message);
          return message.includes(NAVIGATED_DURING_EVALUATE) ? 'navigated' : `the ask was rejected: ${message.split('\n')[0]?.slice(0, 160)}`;
        },
      );
      outcome = await cause(await Promise.race([ask, death, expired]));
      if (outcome !== 'navigated') return outcome === 'it answered';
      navigated++;
      outcome = await cause(await Promise.race([after(Math.min(ASK_AGAIN_PAUSE_MS, remainingMs(deadline)), 'paused'), death, expired]));
      if (outcome === 'paused' && remainingMs(deadline) <= 0) outcome = timedOut;
      if (outcome !== 'paused') return false;
      askedAgain++;
    }
  } finally {
    for (const t of timers) clearTimeout(t);
    page.off('crash', onCrash);
    page.off('close', onClose);
    b.off('disconnected', onDisconnected);
    if (navigated > 0) console.log(`[canvas] the render-canvas navigated while it was checked and was asked again ${times(askedAgain)}; ${outcome}`);
  }
}

// A driver fault (canvas-fault.ts) names no browser, and one the launcher has replaced can still be
// dispatching Chromium's messages: closeDeadBrowser abandons its close after 3 s. So, as the identity
// guards on 'crash' and 'disconnected' ignore a replaced browser's events, a fault hands the canvas to
// the launcher only when the current canvas does not answer, and the launcher is not running and has
// not replaced the canvas while it was checked.
async function handleCanvasDriverFault(): Promise<void> {
  if (shuttingDown || renderCanvasRestarting) return;
  const gen = canvasGen;
  if (await canvasPageAlive()) {
    console.warn('[canvas] the render-canvas still answers, so it stays up');
    return;
  }
  if (gen !== canvasGen) return;
  await handleRenderCanvasDeath('driver faulted');
}

// The give-up the launcher last recorded in lastExportError, until a later launch succeeds.
let launcherGaveUp: string | null = null;

// [render-cap] The one launcher: the boot launch, and the relaunch of a dead render-canvas. Chromium
// can crash or disconnect (renderer OOM, GPU-process loss after a laptop suspend) while the Playwright
// handle stays non-null — so `browserUp` (!!browser) keeps reporting true and `/image` hangs forever
// with no live page to answer. This is the #61-deferred "self-recovery after suspend". SILENT on
// recovery by operator decision (2026-09-28): server-log only, no panel message — a missed export beat
// is self-healing and not worth a chat line. A permanent failure IS surfaced (see below). Guarded
// against re-entry, and against the graceful teardown path (shutdown() sets shuttingDown before it
// closes the browser, so that close is not mistaken for a crash). It always ends: every wait on a
// Chromium in it is bounded, and so is each attempt as a whole.
async function handleRenderCanvasDeath(cause: string, boot = false): Promise<void> {
  if (shuttingDown) return; // graceful teardown closes the browser on purpose — not a crash
  if (renderCanvasRestarting) return; // an incident is already being handled
  renderCanvasRestarting = true;
  relaunchCause = cause;
  launcherRun++;
  launcherBoot = boot;
  if (!boot) console.warn(`[canvas] render-canvas ${cause}; relaunching into room '${activeRoomId}' (silent)`);
  try {
    if (!boot) failPendingImageWaiters(`render-canvas ${cause}; restarting`);
    await closeDeadBrowser();
    for (let attempt = 1; attempt <= RENDER_RELAUNCH_MAX_ATTEMPTS; attempt++) {
      // [#64] Always the board this process hosts, read per attempt. A switch that commits while a
      // launch runs does not navigate (navigateRenderCanvas stands aside), so this is the only
      // launcher. A launch is judged by the room it launched, not the shared canvasRoom: one the board
      // moved away from is closed and relaunched into the hosted board, at no cost of an attempt, so
      // the canvas ends on the hosted board, never the old one.
      const room = activeRoomId;
      const gen = ++canvasGen;
      try {
        const attemptRun = (async () => {
          await launchRenderCanvas(room, gen);
          // A crash during the launch's own verify window is swallowed by the re-entry guard, so
          // confirm the fresh canvas is actually alive before declaring success.
          return canvasPageAlive();
        })();
        const alive = await withTimeout(attemptRun, CANVAS_ATTEMPT_TIMEOUT_MS, 'the launch attempt');
        if (alive && room === activeRoomId) {
          lastNavError = null;
          // The canvas is back, so this launcher's own give-up, if it still stands, is withdrawn.
          if (launcherGaveUp !== null && lastExportError === launcherGaveUp) {
            lastExportOk = null;
            lastExportError = null;
            lastExportAt = null;
          }
          launcherGaveUp = null;
          console.log(boot ? `[canvas] render-canvas up (attempt ${attempt})` : `[canvas] render-canvas relaunched after ${cause} (attempt ${attempt})`);
          return;
        }
        if (alive) {
          console.log(`[canvas] the board moved to '${activeRoomId}' during the relaunch; relaunching there`);
          await closeDeadBrowser();
          attempt--; // not a failure: no attempt spent, no backoff
          continue;
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
    lastExportError = launcherGaveUp = `render-canvas self-heal failed after ${RENDER_RELAUNCH_MAX_ATTEMPTS} attempts (${cause}); manual restart needed`;
    lastExportAt = Date.now();
    console.error(`[canvas] render-canvas NOT recovered after ${RENDER_RELAUNCH_MAX_ATTEMPTS} attempts (${cause}); browserUp=false`);
  } finally {
    renderCanvasRestarting = false;
  }
}

// One launch attempt, generation `gen`. After every await it checks that no newer canvas has replaced
// it (the attempt ran out of time and was closed), and if one has it stops, closing what it launched.
async function launchRenderCanvas(roomId: string, gen: number): Promise<void> {
  const current = (): boolean => gen === canvasGen;
  const superseded = (): CanvasSuperseded => new CanvasSuperseded('the launch was superseded by a newer render-canvas');
  canvasRoom = roomId;
  const since = renderCanvasSocket;
  if (failLaunches > 0) {
    failLaunches--;
    throw new Error('the launch failed (WHITEBOARD_TEST_FAIL_LAUNCHES)');
  }
  const b = await chromium.launch({ headless: true, timeout: CANVAS_NAV_TIMEOUT_MS });
  if (!current()) {
    void b.close().catch(() => undefined); // never assigned, so nothing else would close it
    throw superseded();
  }
  browser = b;
  // [render-cap] Watch for a dead renderer. 'disconnected' fires when the Browser process exits
  // (crash/OOM); 'crash' fires when the page's renderer process dies but the browser survives.
  // Either way the handle is stale and exports would hang — relaunch. The `b === browser` identity
  // guard ignores a STALE browser's late event (e.g. the intentional dead.close() firing after a
  // relaunch already swapped in a new browser), which would otherwise tear down the healthy new
  // canvas. void: fire-and-forget (handleRenderCanvasDeath never rejects).
  b.on('disconnected', () => { if (browser === b) void handleRenderCanvasDeath('browser disconnected'); });
  const page = await withTimeout(b.newPage({ viewport: { width: 1280, height: 800 } }), CANVAS_CALL_TIMEOUT_MS, 'newPage');
  if (!current()) throw superseded(); // b was closed with the generation it belonged to
  canvasPage = page;
  page.on('console', (m) => console.log(`[canvas] ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => console.warn(`[canvas] pageerror: ${e.message}`));
  page.on('crash', () => { if (canvasPage === page) void handleRenderCanvasDeath('page crashed'); });
  const url = canvasUrl(roomId);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CANVAS_NAV_TIMEOUT_MS });
  if (!current()) throw superseded();
  console.log(`[canvas] render-canvas launched at ${canvasLogUrl(roomId)}`);
  if (++launchCount === WEDGE_LAUNCH) wedgeForTest(page, `launch ${launchCount}`);
  await verifyCanvasSynced(roomId, 'launch', page, current, since);
}

// A test-only failure of every navigation of a live render-canvas (WHITEBOARD_FAIL_NAV), so a test can
// make a switch's navigation fail while the browser is alive. A launch is never failed by it. Unset,
// as the skill always leaves it, no navigation is failed.
const FAIL_NAV = !!process.env.WHITEBOARD_FAIL_NAV;

// A test-only renderer that stops answering: right after a page loads, it runs an endless loop in that
// page, so every later evaluate on it waits until its bound. WHITEBOARD_TEST_WEDGE_LAUNCH=N wedges the
// Nth launch (the boot launch is 1); WHITEBOARD_TEST_WEDGE_NAV=<room> wedges the first navigation to
// that room. WHITEBOARD_TEST_FAIL_LAUNCHES=N fails the first N launch attempts before any Chromium
// starts, so a test can make the launcher give up; a failed attempt is not counted as a launch. Unset,
// as the skill always leaves them, nothing is wedged or failed.
const WEDGE_LAUNCH = Number(process.env.WHITEBOARD_TEST_WEDGE_LAUNCH || 0);
let wedgeNavRoom = process.env.WHITEBOARD_TEST_WEDGE_NAV || '';
let failLaunches = Number(process.env.WHITEBOARD_TEST_FAIL_LAUNCHES || 0);
let launchCount = 0;
// The test-only hooks this process was started with armed, which the boot names in a warning, so one
// a shell left exported shows in the log rather than only in its effect.
function armedTestHooks(): string[] {
  return [
    RECOVERY_THROW_FOR_TEST ? 'WHITEBOARD_TEST_RECOVERY_THROW' : '',
    WEDGE_LAUNCH > 0 ? 'WHITEBOARD_TEST_WEDGE_LAUNCH' : '',
    wedgeNavRoom ? 'WHITEBOARD_TEST_WEDGE_NAV' : '',
    failLaunches > 0 ? 'WHITEBOARD_TEST_FAIL_LAUNCHES' : '',
    FAIL_NAV ? 'WHITEBOARD_FAIL_NAV' : '',
  ].filter(Boolean);
}
function wedgeForTest(page: Page, what: string): void {
  console.log(`[canvas] TEST: wedging the renderer after ${what}`);
  void page.evaluate(() => { for (;;) { /* a renderer that stops answering */ } }).catch(() => undefined);
}

// True when the canvas was navigated to roomId; false when the launcher is running and the switch
// stands aside, leaving lastNavError for it to clear. With no canvas to navigate it throws, and the
// switch hands the launch to the launcher, which launches into the hosted board.
async function navigateRenderCanvas(roomId: string): Promise<boolean> {
  if (renderCanvasRestarting) return false; // the launcher is the only launcher; it re-reads activeRoomId
  canvasRoom = roomId;
  const page = canvasPage;
  if (!page) throw new Error('no render-canvas to navigate');
  const gen = canvasGen;
  const url = canvasUrl(roomId);
  if (FAIL_NAV) throw new Error(`page.goto: navigation to ${canvasLogUrl(roomId)} failed (WHITEBOARD_FAIL_NAV)`);
  const since = renderCanvasSocket;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CANVAS_NAV_TIMEOUT_MS });
  failParkedRequests('render-canvas switched boards; retry'); // the page they were sent to is gone
  console.log(`[canvas] render-canvas navigated to ${canvasLogUrl(roomId)}`);
  if (wedgeNavRoom && wedgeNavRoom === roomId) { wedgeNavRoom = ''; wedgeForTest(page, `navigation to ${roomId}`); }
  await verifyCanvasSynced(roomId, 'navigate', page, () => gen === canvasGen, since);
  return true;
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
  // [v9.11 §7 #64] Whether the lead hears the board is per item, not board-wide: each Send carries its
  // state (rung / fetched / done / not-heard), the lead's roster row its lifecycle, and `doorbell`
  // below the ring outcomes.
  res.json({
    connected,
    room: canvasRoom,
    // [v8 §8.3] The board this process actually hosts (canvasRoom is null until the render-canvas
    // navigates, and stays null headless; activeRoom is always set). [#64] With `pid` and `held`
    // (every board whose lock names this process, including one an in-app switch is releasing), it
    // is what another process's one-server probe reads (probeOwner): active, releasing or stale.
    activeRoom: activeRoomId,
    pid: process.pid,
    held: [...heldBoards],
    // [#64] The last render-canvas navigation's failure (a switch), or null; the relaunch follows it.
    lastNavError,
    // [render-cap] True while the canvas is being launched or relaunched; false again when the launcher ends, up or given up.
    relaunching: renderCanvasRestarting,
    // [v9.6] Identify the CC session that booted this board (mirrors the lock's owner fields) so a
    // guest/second /whiteboard session reads the owner here without re-parsing the lock, and knows it
    // must not tear down a board it did not boot. Null when the board was booted without owner env.
    ownerSession: OWNER_SESSION,
    ownerSessionId: OWNER_SESSION_ID,
    // [#64] Whether this server's parent is the session's Claude process (CLAUDE_PID): false means
    // the boot shape is wrong and the canary will refuse; null means no CLAUDE_PID was inherited.
    ownerIsClaude: OWNER_IS_CLAUDE,
    // [port] True when started with WHITEBOARD_OWNER_WATCH=off: it lives until /done.
    detached: OWNER_WATCH_OFF,
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
    // [v9.11 §8.5 #64] The lead doorbell: inbox configured, ring count and last outcome, and each
    // unfetched item's state (queued / rung / not-heard).
    doorbell: doorbellStatus(),
  });
});

// ===========================================================================
// Shutdown / done (SPEC §11: no orphan Chromium)
// ===========================================================================
// [v9.10 #63] Once shutdown starts, the process exits by this deadline even if the graceful path
// hangs (a frozen Chromium never answers page.close/browser.close). Generous next to a healthy
// teardown (well under a second), short enough that a stalled one never leaves the process running.
const SHUTDOWN_DEADLINE_MS = 5_000;
let shuttingDown = false;
let finalStateFlushed = false;

// [v9.10 #63] The load-bearing half of the graceful path: the final .tldr snapshot and the lock
// removal. Synchronous and idempotent, so the hard-exit paths below run it too and an exit that
// skips the rest of teardown still leaves the board saved and bootable. [#64] It never touches the
// port record: only /done forgets the board's port. It writes and unlocks every board this process
// still holds: the hosted one, and one an in-app switch is releasing at this moment. A board whose
// release has finished is no longer held, and may be another server's now.
function flushFinalState(): void {
  if (finalStateFlushed) return;
  finalStateFlushed = true;
  clearInterval(persistTimer); // no save starts after the final snapshot
  clearInterval(sweepTimer);
  clearInterval(doorbellTimer);
  clearInterval(ownerWatch);
  for (const roomId of new Set([activeRoomId, ...heldBoards])) {
    const entry = rooms.get(roomId);
    if (entry) persistRoomSync(roomId, entry);
    removeLock(roomId);
  }
}

// [v9.11 §3 #64] The owner watch. The board server is the owning Claude process's own child and
// dies with it: every OWNER_WATCH_MS it checks that its parent is still the process that booted it.
// When the parent dies or changes (the session exited, was killed, or was respawned by a resume or
// an update, any of which also retires its inbox socket and token), it writes the board's `.tldr`
// snapshot, removes its lock and exits, leaving `<name>.port`. The next `/whiteboard open` boots a
// new owner from the snapshot, which binds the port that record names when it is still free (else
// an ephemeral one, rewriting the record), so the operator's open tab can reconnect to the same
// origin. This is also the reaper for orphaned board servers, and
// it keeps a server from ringing a dead session's socket path, which a later session reusing the
// pid could own.
const OWNER_WATCH_MS = envMs('WHITEBOARD_OWNER_WATCH_MS', 2_000);
// [port] Off when detached (WHITEBOARD_OWNER_WATCH=off).
const ownerWatch = OWNER_WATCH_OFF ? undefined : setInterval(() => {
  if (process.ppid === OWNER_PID && pidAlive(OWNER_PID)) return;
  console.log(`[bridge] owner process ${OWNER_PID} is gone (parent now ${process.ppid}); saving the board and exiting`);
  void shutdown(0);
}, OWNER_WATCH_MS);

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // [v9.10 #63] Arm the hard exit before the first await. Not unref'd: when the graceful path
  // stalls, this timer is what ends the process.
  setTimeout(() => {
    console.error(`[bridge] graceful shutdown did not finish in ${SHUTDOWN_DEADLINE_MS}ms; exiting`);
    flushFinalState();
    process.exit(code);
  }, SHUTDOWN_DEADLINE_MS);
  console.log('[bridge] shutting down…');
  // [v9.6 fix 4] Tell any connected operator browsers the room is closing so they can export
  // before the socket drops — the client keeps NO local persistence, so unsynced edits after
  // close are lost. Broadcast BEFORE the sockets are torn down, then let the frame flush.
  try { broadcastToHumans({ type: 'server-closing', room: activeRoomId }); } catch { /* best effort */ }
  await new Promise((r) => setTimeout(r, 150));
  // [#64] Start no new save, and let any in flight land first (the hosted board's, or a board being
  // released): an older snapshot must not land after the final one. The hard-exit paths skip this
  // wait and flush synchronously.
  clearInterval(persistTimer);
  await Promise.all([...rooms.values()].map((entry) => entry.saving));
  flushFinalState();
  presence.closeAll();
  await teardownRenderCanvas();
  try {
    server.close();
  } catch {
    /* ignore */
  }
  process.exit(code);
}

app.post('/done', requireJson, (_req: Request, res: Response) => {
  // [v9.1 §9 #53] Defensive cleanup: clear the teardown flag on the graceful close. In the directive
  // path it is already cleared on consumption; this also covers the natural-language-Send fallback,
  // where the lead reaches /done without a directive ever being surfaced.
  clearTeardownRequested(activeRoomId);
  // [#64] The operator closed the board: forget its port, so its next open starts on a fresh one.
  // Every other exit keeps the record (see portPathFor).
  removePortRecord();
  res.json({ ok: true });
  void shutdown(0);
});

// [v9.10 #63] A lost log sink is never fatal. The pipe behind our stdout/stderr can close under a
// live server (it did when a board outlived its session, before #64). Every later log line then
// fails EPIPE, emitted as an 'error' event; unhandled, it became an uncaughtException whose handler
// logged to the same dead pipe and raised the next one — a self-sustaining loop that pinned a core
// and starved the timer the graceful shutdown awaited, so the process never exited. Swallow write
// errors on both streams: the board keeps serving while its owner lives, and when the owner dies
// (#64, the owner watch) the shutdown still completes on a dead pipe.
process.stdout.on('error', () => { /* log sink gone */ });
process.stderr.on('error', () => { /* log sink gone */ });

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
process.on('SIGHUP', () => void shutdown(0));
process.on('uncaughtException', (e) => {
  // [v9.10 #63] A fault while already shutting down means the graceful path cannot be trusted to
  // finish: save what is synchronous and exit now. Never hand it back to shutdown(), whose guard
  // would swallow it, and never wait on a timer, which a stream of faults can starve.
  if (shuttingDown) {
    flushFinalState();
    process.exit(1);
  }
  // A fault in Playwright's dispatch of a Chromium message is the render-canvas's (canvas-fault.ts), so
  // the board keeps serving, and the launcher has the canvas if it does not answer. Any other is the server's.
  if (isCanvasDriverFault(e)) {
    console.error(`[canvas] the render-canvas driver faulted on a message from Chromium (${(e as Error).message}); the server keeps serving`);
    void handleCanvasDriverFault();
    return;
  }
  console.error('[bridge] uncaughtException:', e);
  void shutdown(1);
});

// ===========================================================================
// Static app + boot
// ===========================================================================
app.use('/', express.static(APP_DIST));
// [port] Express's own final handler removes every header before it answers a miss or an error, which
// would drop the framing headers. These two answer both instead, so they keep them.
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: () => void) => {
  res.status(err.status ?? 500).json({ error: err.message });
});

// [v4 §8.3] Bind BOOT_PORT and read the real port back. [v9.11 §8.3 #64] BOOT_PORT is a non-zero
// WHITEBOARD_PORT, else the board's recorded `<name>.port`, else 0 (OS-assigned). The boot command
// passes no WHITEBOARD_PORT: the server keeps the board on its port by itself, so an open browser tab
// reconnects to the same origin. A preferred port is a preference, not a demand: if it is taken the
// server falls back to an ephemeral one, prints it, and records it, and the skill opens a new tab there.
server.once('listening', () => {
  const addr = server.address();
  assignedPort = addr && typeof addr === 'object' ? addr.port : BOOT_PORT;
  // [#64] The boot's lock write, with its synchronous re-check: a server that wrote the lock while
  // this one was checking and binding holds the board, and this one leaves before it says it listens.
  const raced = claimLockNow(activeRoomId, BOOT_STALE_PID);
  if (raced) refuseBoot(raced);
  sweepOrphanTemps(activeBoardPath);
  const source =
    assignedPort !== BOOT_PORT ? 'ephemeral' : PORT_OVERRIDE ? 'WHITEBOARD_PORT override' : RECORDED_PORT ? 'recorded port' : 'ephemeral';
  console.log(`[bridge] WHITEBOARD_PORT=${assignedPort}`);
  console.log(`[bridge] listening on http://${HOST}:${assignedPort} (${source})`);
  console.log(`[bridge] serving app from ${APP_DIST}`);
  console.log(`[bridge] bridge WS  ws://${HOST}:${assignedPort}/events`);
  console.log(`[sync]   sync   WS  ws://${HOST}:${assignedPort}/sync/:roomId`);
  const armed = armedTestHooks();
  if (armed.length) console.warn(`[bridge] WARNING: test-only hooks armed: ${armed.join(', ')}. The skill never sets these; unset them unless a test is running.`);
  writePortRecord();
  getOrCreateRoom(activeRoomId);
  // WHITEBOARD_NO_CANVAS skips the Playwright render-canvas — a headless-test affordance
  // for exercising the bridge (messages, discovery, isolation) without launching Chromium at boot. A
  // switch still hands the missing canvas to the launcher, which launches one ([navfail] relies on it).
  // The skill never sets it, so normal boot always brings the render-canvas up.
  if (process.env.WHITEBOARD_NO_CANVAS) {
    console.log('[canvas] skipped (WHITEBOARD_NO_CANVAS set)');
  } else {
    // Through the one launcher, so a switch during the boot launch stands aside and the canvas follows it.
    void handleRenderCanvasDeath('the boot launch', true);
  }
});
server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE' && BOOT_PORT && !server.listening) {
    console.warn(`[bridge] port ${BOOT_PORT} is taken; falling back to an ephemeral port`);
    server.listen(0, HOST);
    return;
  }
  console.error('[bridge] server error:', e.message);
  void shutdown(1);
});
// [#64] One server per board, checked before this process binds or writes anything. A board another
// live process holds is refused with exit 3, so the session reports it rather than booting a second
// writer of the same `.tldr`, with a line that says which refusal it is: the owner serves the board
// (the skill attaches instead), is still releasing it after the wait, or does not answer. A board
// being released is waited for first, here, with nothing bound or written, so the boot loads the
// snapshot the release flushed. The lock write itself is claimed in the listening handler above.
function refuseBoot(owner: LockOwner): never {
  const held =
    owner.state === 'active' ? `is already served by pid ${owner.pid} on port ${owner.port}`
    : owner.state === 'releasing' ? `is still being released by pid ${owner.pid} on port ${owner.port}`
    : `is held by pid ${owner.pid} on port ${owner.port}, which does not answer`;
  console.error(`[bridge] board '${activeRoomId}' ${held}; not starting a second server`);
  process.exit(3);
}
// [#65] Before any board's claim, a live server from before #64 on any board refuses the boot with
// exit 4 and one line naming each one, which the skill turns into the operator's stop-or-decline
// call. On this board too, so one path covers it: the board's own claim never sees such a lock.
const preSixtyFour = await findPre64Servers();
if (preSixtyFour.length) {
  console.error(`[bridge] ${describeOldServers(preSixtyFour)}; not starting a server while one runs`);
  process.exit(4);
}
// The waiting line names the state the probe answered: a release, or a live pid that is not answering.
const bootVerdict = await awaitBoardFree(activeRoomId, (lock, state) => {
  const held = state === 'releasing' ? `is being released by pid ${lock.pid}` : `is held by pid ${lock.pid}, which is not answering`;
  console.log(`[bridge] board '${activeRoomId}' ${held}; waiting up to ${RELEASE_WAIT_MS / 1000} s`);
});
if (bootVerdict.owner) refuseBoot(bootVerdict.owner);
const BOOT_STALE_PID = bootVerdict.stalePid;
// [port] A board file this server cannot load exits 1 before anything is bound or written, so it is
// never replaced by an empty board.
try {
  getOrCreateRoom(activeRoomId);
} catch (e) {
  console.error(`[bridge] ${(e as Error).message}; not starting`);
  process.exit(1);
}
server.listen(BOOT_PORT, HOST);

// Presence-state helper re-export used by nothing else; keep the type surface visible.
export type { PresenceState };

// Headless test of which file a board's name is, across checkouts and inside one server (SPEC §8.1,
// §8.3, decisions #71 and #72). It proves:
//   - [#71] Both checkouts' servers keep a board's lock in the main checkout's `.scratchpad/whiteboard/`,
//     so a second server on a board, from either checkout, exits 3 as already served; a server on
//     another file of the same name exits 3 as open from another file; a lock with no `boardPath`
//     counts as the same board.
//   - [#72] A switch onto another file of the hosted board's name loads that file, and the lock, the
//     saves, `/canvas-status`, `/boards`, the port record, the chat and the recipients follow it; a
//     sync tab that did not switch is reset to exactly that file when it reconnects, whether the two
//     files' sync clocks are equal or the target's is ahead.
//   - [#72] A later server on another same-named file takes a fresh port and starts with no chat, no
//     recipients and none of the first file's Sends on its doorbell; chat, port and recipient entries
//     with no stamp, from an older server, are the board's.
//   - [#71] An in-app switch onto a name another live server holds for another file answers 409 with
//     the `is open from another file` line, and nothing changes.
//   - [#72] One file reached through a symlinked folder is one board: one lock, port and chat.
//   - [#72] After a board is homed under its own name (copied to a tracked path and switched onto)
//     and closed with /done, its port record keeps only `{ board, boardPath }`; a boot on the tracked
//     file takes a fresh port and has the board's chat and its pending lead Send on the doorbell, and
//     /board/new with the bare name switches the host, on its own port, onto the tracked file with
//     the same chat and Send.
//   - [#72 clause 6] A bare name resolves through its port record: a record naming a file that no
//     longer exists makes /board/new answer 409 with the `is recorded at` line, and a default boot
//     (no WHITEBOARD_BOARD) exit 2 with it, each leaving the record as it was; a record whose file
//     name is not `<name>.tldr` counts as no record, so the name opens its home file; a record naming
//     the home file opens it even before it exists; and a default boot opens the file the default
//     name's record names.
// Builds a throwaway git repo, adds a linked worktree inside it as `.claude/worktrees/` does, and
// boots the real bridge on each checkout: from the skill's server/, with WHITEBOARD_REPO naming the
// checkout and no WHITEBOARD_HOME, so the server finds the home itself. scripts/whiteboard.sh's own
// resolution of the home is checked against it. Exit 0 = all pass.
//
//   node --import tsx tests/whiteboard/cross-checkout.test.ts      (run from the skill's server/)

import { execFileSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TLSyncClient as SyncClient } from '@tldraw/sync-core';
import type { Store as TLStore } from '@tldraw/store';
import type { TLGeoShape, TLParentId, TLRecord, TLShapeId, TLStoreProps } from '@tldraw/tlschema';
import { SCRUBBED_ENV, SERVER_DIR, SKILL_DIR } from './harness.mjs';

// This suite lives outside the skill, in tests/whiteboard/: the server and its packages come from
// the skill's server/.
const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { scratchpadHome } = (await import(pathToFileURL(path.join(SERVER_DIR, 'scratchpad-home.ts')).href)) as typeof import('../../skills/visual/whiteboard/server/scratchpad-home.js');
const WHITEBOARD_SH = path.join(SKILL_DIR, 'scripts', 'whiteboard.sh');
const SCRATCHPAD_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', 'core', 'scratchpad', 'scripts', 'scratchpad.sh');

// --- browser-global shim (mirrors server/headless-shim.ts) BEFORE any tldraw client code --------
const g = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
  requestAnimationFrame?: (cb: (t: number) => void) => unknown;
  cancelAnimationFrame?: (id: unknown) => void;
};
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1 };
g.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false, visibilityState: 'visible' };
g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame ??= (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>);
const { Store } = serverRequire('@tldraw/store') as typeof import('@tldraw/store');
const { createTLSchema } = serverRequire('@tldraw/tlschema') as typeof import('@tldraw/tlschema');
const { TLSyncClient, TLSocketRoom } = serverRequire('@tldraw/sync-core') as typeof import('@tldraw/sync-core');
// The published typings omit ClientWebSocketAdapter; the server's client-adapter.ts types the same
// runtime export.
const { ClientWebSocketAdapter } = serverRequire('@tldraw/sync-core') as unknown as typeof import('../../skills/visual/whiteboard/server/client-adapter.js');
const { atom } = serverRequire('@tldraw/state') as typeof import('@tldraw/state');

const BOARD = 'xcheckout';

interface BootedServer extends ChildProcessByStdio<null, Readable, Readable> {
  _log: string;
}
interface LockRecord { port: number; pid: number; boardPath?: string }
interface PortRecord { port: number; pid: number; boardPath?: string }
interface StoredMessage { id: string; text: string; boardPath?: string; receivedAt?: number }
interface Snapshot { documents?: { state?: { id?: string } }[] }
interface CanvasStatus { activeRoom?: string; boardPath?: string; roomClock?: number; doorbell?: { items?: { id: string }[] } }
interface BoardListing { path: string; room: string; active?: boolean }

// --- tiny assertion harness -------------------------------------------------
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq<T>(actual: T, expected: NoInfer<T>, msg: string): void {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
async function waitFor(pred: () => unknown, ms = 3000, step = 50): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(step);
  }
}
const readJson = <T>(p: string): T | null => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; } };
const readLock = (p: string): LockRecord | null => readJson<LockRecord>(p);
const fileHasShape = (file: string, id: string): boolean => !!readJson<Snapshot>(file)?.documents?.some((d) => d.state?.id === id);
// Each line of a chat log, parsed.
const logEntries = (p: string): StoredMessage[] => {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as StoredMessage); } catch { return []; }
};
async function getJson<T>(port: number, route: string): Promise<T> {
  return (await (await fetch(`http://127.0.0.1:${port}${route}`)).json()) as T;
}
async function postJson<T>(port: number, route: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as T };
}

// --- the fixture: a main checkout and a linked worktree ---------------------------------------
// realpath, so the paths here match the ones git prints (macOS's tmpdir is behind a symlink).
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wb-xcheckout-')));
const MAIN = path.join(ROOT, 'main');
const LOOSE = path.join(MAIN, 'loose');
const LINKED = path.join(MAIN, '.claude', 'worktrees', 'linked');
const MAIN_HOME = path.join(MAIN, '.scratchpad', 'whiteboard');
const BOARD_PATH = path.join(MAIN_HOME, `${BOARD}.tldr`);
const LOCK_PATH = path.join(MAIN_HOME, `${BOARD}.lock`);
// A board tracked at one relative path, so each checkout has its own copy under the same name.
const SAME = 'xsame';
const SAME_REL = path.join('boards', `${SAME}.tldr`);
const SAME_LOCK = path.join(MAIN_HOME, `${SAME}.lock`);
// [#72] A second tracked board, for a Send left pending on one copy and a server on the other.
const SEND = 'xsend';
const SEND_REL = path.join('boards', `${SEND}.tldr`);
const SEND_LOCK = path.join(MAIN_HOME, `${SEND}.lock`);

// The fixture's git, untouched by the caller's: no signing or hooks from its config, and none of the
// variables that locate a repository (a git hook's GIT_DIR would make every call describe that one).
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, stdio: 'ignore', env: GIT_ENV });
};
// An interrupted run stops the servers it booted and removes the fixture, as a finished one does.
const booted = new Set<BootedServer>();
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    for (const s of booted) s.kill('SIGKILL');
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

function buildFixture(): void {
  fs.mkdirSync(MAIN, { recursive: true });
  fs.writeFileSync(path.join(MAIN, '.gitignore'), 'node_modules\n.scratchpad/\n.claude/worktrees/\nloose/\n');
  // An empty board's snapshot: this port refuses a file it cannot load rather than start it empty.
  const empty = new TLSocketRoom({});
  const emptyBoard = JSON.stringify(empty.getCurrentSnapshot());
  empty.close();
  fs.mkdirSync(path.join(MAIN, 'boards'));
  fs.writeFileSync(path.join(MAIN, SAME_REL), emptyBoard);
  fs.writeFileSync(path.join(MAIN, SEND_REL), emptyBoard);
  git(MAIN, 'init', '-q');
  git(MAIN, 'add', '-A');
  git(MAIN, 'commit', '-q', '-m', 'fixture');
  git(MAIN, 'worktree', 'add', '-q', LINKED);
  fs.mkdirSync(MAIN_HOME, { recursive: true });
}

// Boot the bridge on `checkout` (WHITEBOARD_REPO) on a board (the one board unless named), the way the
// skill does, but leaving the home to the server.
// A switch hands the missing canvas to the launcher, so a test that switches fails every launch
// before any Chromium starts (WHITEBOARD_TEST_FAIL_LAUNCHES), and a fast doorbell tick lets a test
// read the doorbell's items within a fraction of a second.
// `board` null boots with WHITEBOARD_BOARD unset, on the default name's board.
function boot(checkout: string, board: string | null = BOARD_PATH): BootedServer {
  const env: NodeJS.ProcessEnv = {
    ...process.env, WHITEBOARD_REPO: checkout, WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: board ?? undefined, WHITEBOARD_TEST_FAIL_LAUNCHES: '9', WHITEBOARD_DOORBELL_TICK_MS: '100',
  };
  for (const k of [...SCRUBBED_ENV, 'WHITEBOARD_PORT', 'WHITEBOARD_HOME']) delete env[k];
  if (board === null) delete env.WHITEBOARD_BOARD;
  const child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: SERVER_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as BootedServer;
  child._log = '';
  booted.add(child);
  child.once('exit', () => booted.delete(child));
  child.stdout.on('data', (d) => { child._log += d.toString(); });
  child.stderr.on('data', (d) => { child._log += d.toString(); });
  return child;
}
const exited = (s: BootedServer): boolean => s.exitCode !== null || s.signalCode !== null;
// Whether a server has printed the line it prints once it listens, after the port's source and
// before its canvas: a check of an earlier boot line waits for this first, so it never reads the log
// before the line arrives.
const listening = (s: BootedServer): Promise<boolean> => waitFor(() => s._log.includes('[bridge] listening on'), 10000);
async function stop(s: BootedServer): Promise<void> {
  if (!exited(s)) s.kill('SIGTERM');
  if (!(await waitFor(() => exited(s), 8000))) s.kill('SIGKILL');
}

// A first server boots from `firstCheckout`, then a second from `secondCheckout` on the same board:
// the second must find the first one's lock in the main checkout's home and refuse.
async function secondServerRefused(firstCheckout: string, secondCheckout: string, label: string): Promise<void> {
  console.log(`\n[${label}] a server from the ${label.split(' then ')[0]} holds the board; one from the ${label.split(' then ')[1]} is refused`);
  const a = boot(firstCheckout);
  let b: BootedServer | null = null;
  try {
    ok(await waitFor(() => readLock(LOCK_PATH)?.pid === a.pid, 20000), "the first server's lock is in the main checkout's .scratchpad/whiteboard/");
    eq(readLock(LOCK_PATH)?.boardPath, BOARD_PATH, 'and names the board file it holds');
    const port = readLock(LOCK_PATH)?.port;
    const second = boot(secondCheckout);
    b = second;
    ok(await waitFor(() => exited(second), 20000), 'a second server on the same board exits at boot');
    eq(second.exitCode, 3, 'with exit code 3');
    ok(second._log.includes(`[bridge] board '${BOARD}' is already served by pid ${a.pid} on port ${port}; not starting a second server`), "and names the first server's pid and port");
    ok(!fs.existsSync(path.join(LINKED, '.scratchpad', 'whiteboard', `${BOARD}.lock`)), 'the linked worktree holds no lock of its own');
  } finally {
    for (const s of [a, b]) if (s) await stop(s);
    await waitFor(() => !fs.existsSync(LOCK_PATH), 5000);
  }
}

// [#71] A server holds the main checkout's copy of a tracked board; one on the linked worktree's copy
// (same name, another file) must be refused as another file, naming both files.
async function sameNameOtherFileRefused(): Promise<void> {
  console.log('\n[same name] a server holds the main checkout\'s copy of a board; one on the worktree\'s copy is refused');
  const mainCopy = path.join(MAIN, SAME_REL);
  const linkedCopy = path.join(LINKED, SAME_REL);
  ok(fs.existsSync(mainCopy) && fs.existsSync(linkedCopy), 'each checkout has its own tracked copy of the board');
  const a = boot(MAIN, mainCopy);
  let b: BootedServer | null = null;
  try {
    ok(await waitFor(() => readLock(SAME_LOCK)?.pid === a.pid, 20000), "the first server's lock is in the main checkout's .scratchpad/whiteboard/");
    eq(readLock(SAME_LOCK)?.boardPath, mainCopy, "and names the main checkout's copy");
    const port = readLock(SAME_LOCK)?.port;
    const second = boot(LINKED, linkedCopy);
    b = second;
    ok(await waitFor(() => exited(second), 20000), "a server on the worktree's copy exits at boot");
    eq(second.exitCode, 3, 'with exit code 3');
    ok(second._log.includes(`[bridge] board '${SAME}' is open from another file: ${mainCopy} (pid ${a.pid}, port ${port}); not serving ${linkedCopy}. Close it there, or open that file.`), 'and names the file that is open and the file it was asked to serve');
    ok(!second._log.includes('is already served by'), 'not that the board is already served');
    eq(readLock(SAME_LOCK)?.pid, a.pid, "the first server's lock is left in place");
  } finally {
    for (const s of [a, b]) if (s) await stop(s);
    await waitFor(() => !fs.existsSync(SAME_LOCK), 5000);
  }
}

// --- [#72] a headless tab that edits a board ------------------------------------------------------
function geoRecord(id: string): TLGeoShape {
  return {
    id: id as TLShapeId, typeName: 'shape', type: 'geo', x: 0, y: 0, rotation: 0, index: 'a1' as TLGeoShape['index'], parentId: 'page:page' as TLParentId,
    isLocked: false, opacity: 1, meta: {},
    props: {
      geo: 'rectangle', w: 100, h: 100, color: 'black', labelColor: 'black', fill: 'none', dash: 'draw',
      size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle', growY: 0, url: '', scale: 1,
      flipX: false, flipY: false, richText: { type: 'doc', content: [{ type: 'paragraph' }] },
    },
  };
}
// A real tldraw store and sync client joined to the room, so a put reaches the room and marks it
// changed.
interface SyncPeer { put: (id: string) => void; has: (id: string) => boolean; shapes: () => string; close: () => void }
async function syncPeer(port: number, room: string): Promise<SyncPeer> {
  const store: TLStore<TLRecord, TLStoreProps> = new Store<TLRecord, TLStoreProps>({ schema: createTLSchema(), props: {} as TLStoreProps });
  const socket = new ClientWebSocketAdapter(() => `ws://127.0.0.1:${port}/sync/${room}`);
  let client: SyncClient<TLRecord, TLStore<TLRecord, TLStoreProps>> | undefined;
  await new Promise<void>((resolve) => {
    client = new TLSyncClient<TLRecord, TLStore<TLRecord, TLStoreProps>>({ store, socket, presence: atom<TLRecord | null>('presence', null), onLoad: () => resolve(), onSyncError: () => {} });
  });
  return {
    put: (id) => store.put([geoRecord(id)]),
    has: (id) => !!store.get(id as TLShapeId),
    shapes: () => store.allRecords().filter((r) => r.typeName === 'shape').map((r) => r.id).sort().join(','),
    close: () => {
      try { client!.close(); } catch { /* already closed */ }
      try { socket.close(); } catch { /* already closed */ }
    },
  };
}

// [#72] One server switches from the main checkout's copy of a board to the worktree's copy (same
// name, another file): it loads that file, and the lock, the saves, the status and the chat follow
// it.
async function sameServerSwitchLoadsOtherFile(): Promise<void> {
  console.log("\n[same-name switch] a server on the main checkout's copy switches to the worktree's copy");
  const mainCopy = path.join(MAIN, SAME_REL);
  const linkedCopy = path.join(LINKED, SAME_REL);
  const a = boot(MAIN, mainCopy);
  let peer: SyncPeer | null = null;
  try {
    ok(await waitFor(() => readLock(SAME_LOCK)?.pid === a.pid, 20000), "the server's lock names it");
    const port = readLock(SAME_LOCK)!.port;
    peer = await syncPeer(port, SAME);
    peer.put('shape:on-main');
    ok(await waitFor(() => fileHasShape(mainCopy, 'shape:on-main'), 8000), "a drawing on the board is saved to the main checkout's copy");
    peer.close();
    peer = null;
    const sent = await postJson<{ ok?: boolean }>(port, '/message', { text: 'kept across the switch', idempotencyKey: 'xsame-chat', room: SAME });
    eq(sent.status, 200, 'the operator leaves a chat message on the board');
    eq(logEntries(path.join(MAIN_HOME, `${SAME}.messages.jsonl`)).find((m) => m.id === 'xsame-chat')?.boardPath, mainCopy, "and it is stamped with the main checkout's copy");

    const opened = await postJson<{ ok?: boolean; attach?: boolean; room?: string }>(port, '/board/open', { path: linkedCopy });
    eq(`${opened.status} ${opened.body.attach} ${opened.body.room}`, `200 false ${SAME}`, "the switch to the worktree's copy answers 200 on the same room");
    eq(readLock(SAME_LOCK)?.boardPath, linkedCopy, "the lock names the worktree's copy");
    eq(readLock(SAME_LOCK)?.pid, a.pid, 'and is still this server');
    eq((await getJson<CanvasStatus>(port, '/canvas-status')).boardPath, linkedCopy, "/canvas-status reports the worktree's copy");
    const listing = await getJson<BoardListing[]>(port, '/boards');
    eq(listing.filter((b) => b.active).map((b) => b.path).join(','), linkedCopy, "/boards marks only the worktree's copy active");
    eq(readJson<PortRecord>(path.join(MAIN_HOME, `${SAME}.port`))?.boardPath, linkedCopy, "the port record is stamped with the worktree's copy");

    const mainAfterSwitch = fs.readFileSync(mainCopy, 'utf8');
    ok(fileHasShape(mainCopy, 'shape:on-main'), "the main checkout's copy keeps the board as it was at the switch");
    peer = await syncPeer(port, SAME);
    ok(!peer.has('shape:on-main'), "the room is loaded from the worktree's copy, not kept from the main checkout's");
    peer.put('shape:on-linked');
    ok(await waitFor(() => fileHasShape(linkedCopy, 'shape:on-linked'), 8000), "a drawing after the switch is saved to the worktree's copy");
    ok(a._log.includes(`[sync] persisted room '${SAME}' -> ${linkedCopy}`), "and the save names the worktree's copy");
    ok(fs.readFileSync(mainCopy, 'utf8') === mainAfterSwitch, "the main checkout's copy is not written again");

    const messages = (await getJson<{ messages: StoredMessage[] }>(port, '/messages')).messages;
    const carried = messages.find((m) => m.id === 'xsame-chat');
    ok(carried?.text === 'kept across the switch', 'the chat message is still on the board');
    eq(carried?.boardPath, linkedCopy, "and is re-stamped with the worktree's copy");
    eq(logEntries(path.join(MAIN_HOME, `${SAME}.messages.jsonl`)).find((m) => m.id === 'xsame-chat')?.boardPath, linkedCopy, 'on disk too');
  } finally {
    peer?.close();
    await stop(a);
    await waitFor(() => !fs.existsSync(SAME_LOCK), 5000);
  }
}

// [#72] A Send left pending on the main checkout's copy stays with that file: a later server on the
// worktree's copy takes a fresh port, starts an empty conversation and never rings for it; the main
// checkout's copy, opened again, has it back.
async function otherFileServerStartsFresh(): Promise<void> {
  console.log("\n[same name, later] a Send pending on the main checkout's copy is not the worktree's copy's");
  const mainCopy = path.join(MAIN, SEND_REL);
  const linkedCopy = path.join(LINKED, SEND_REL);
  const log = path.join(MAIN_HOME, `${SEND}.messages.jsonl`);
  const portRecord = path.join(MAIN_HOME, `${SEND}.port`);
  const itemIds = async (port: number): Promise<string[]> => ((await getJson<CanvasStatus>(port, '/canvas-status')).doorbell?.items ?? []).map((i) => i.id);

  const a = boot(MAIN, mainCopy);
  let mainPort = 0;
  try {
    ok(await waitFor(() => readLock(SEND_LOCK)?.pid === a.pid, 20000), "a server holds the main checkout's copy");
    mainPort = readLock(SEND_LOCK)!.port;
    eq((await postJson<{ ok?: boolean }>(mainPort, '/message', { text: 'pending on main', idempotencyKey: 'xsend-pending' })).status, 200, 'a Send to the lead is left pending');
    ok(await waitFor(async () => (await itemIds(mainPort)).includes('xsend-pending'), 3000), 'and is on the doorbell');
    eq(readJson<PortRecord>(portRecord)?.boardPath, mainCopy, "the port record is stamped with the main checkout's copy");
  } finally {
    await stop(a);
    await waitFor(() => !fs.existsSync(SEND_LOCK), 5000);
  }

  const b = boot(LINKED, linkedCopy);
  try {
    ok(await waitFor(() => readLock(SEND_LOCK)?.pid === b.pid, 20000), "a server on the worktree's copy boots once the first has exited");
    await listening(b);
    const port = readLock(SEND_LOCK)!.port;
    ok(port !== mainPort && b._log.includes('(ephemeral)'), `it takes a fresh port, not the main checkout's copy's (${port} vs ${mainPort})`);
    eq((await getJson<{ messages: StoredMessage[] }>(port, '/messages')).messages.length, 0, 'its conversation is empty');
    await sleep(500); // several doorbell ticks
    ok(!(await itemIds(port)).includes('xsend-pending'), "the main checkout's copy's Send is not on its doorbell");
    eq((await postJson<{ ok?: boolean }>(port, '/message', { text: 'on the worktree copy', idempotencyKey: 'xsend-linked' })).status, 200, 'it takes a message of its own');
    ok(logEntries(log).some((m) => m.id === 'xsend-pending'), "the main checkout's copy's Send stays in the log on disk");
  } finally {
    await stop(b);
    await waitFor(() => !fs.existsSync(SEND_LOCK), 5000);
  }

  const c = boot(MAIN, mainCopy);
  try {
    ok(await waitFor(() => readLock(SEND_LOCK)?.pid === c.pid, 20000), "the main checkout's copy boots again");
    const port = readLock(SEND_LOCK)!.port;
    const ids = (await getJson<{ messages: StoredMessage[] }>(port, '/messages')).messages.map((m) => m.id);
    eq(ids.join(','), 'xsend-pending', 'its own conversation is back, without the worktree copy\'s message');
    ok(await waitFor(async () => (await itemIds(port)).includes('xsend-pending'), 3000), 'and its pending Send is on the doorbell again');
    // A rewrite of the log (the lead's fetch stamps the receipt) keeps the other file's entries.
    const lead = (await postJson<{ sessionId?: string }>(port, '/session/register', { name: 'Claude', clientKey: 'lead' })).body.sessionId;
    await getJson(port, `/pending?sessionId=${lead}`);
    ok(await waitFor(() => logEntries(log).find((m) => m.id === 'xsend-pending')?.receivedAt !== undefined, 3000), 'the log is rewritten with the receipt');
    eq(logEntries(log).find((m) => m.id === 'xsend-linked')?.boardPath, linkedCopy, "and keeps the worktree copy's message, stamped with its file");
  } finally {
    await stop(c);
    await waitFor(() => !fs.existsSync(SEND_LOCK), 5000);
  }
}

// [#71] A lock with no `boardPath`, from a server older than #71, counts as the same board: a server
// on the other file is told the board is already served, not that another file is open.
async function lockWithoutBoardPathIsSameBoard(): Promise<void> {
  console.log('\n[old lock] a lock with no boardPath is taken to be the same board');
  const mainCopy = path.join(MAIN, SAME_REL);
  const linkedCopy = path.join(LINKED, SAME_REL);
  const a = boot(MAIN, mainCopy);
  let b: BootedServer | null = null;
  try {
    ok(await waitFor(() => readLock(SAME_LOCK)?.pid === a.pid, 20000), "a server holds the main checkout's copy");
    const lock = readJson<Record<string, unknown>>(SAME_LOCK)!;
    delete lock.boardPath;
    fs.writeFileSync(SAME_LOCK, JSON.stringify(lock));
    const second = boot(LINKED, linkedCopy);
    b = second;
    ok(await waitFor(() => exited(second), 20000), "a server on the worktree's copy exits at boot");
    eq(second.exitCode, 3, 'with exit code 3');
    ok(second._log.includes(`[bridge] board '${SAME}' is already served by pid ${a.pid} on port ${lock.port}; not starting a second server`), 'as the same board, already served');
    ok(!second._log.includes('is open from another file'), 'not as another file');
  } finally {
    for (const s of [a, b]) if (s) await stop(s);
    await waitFor(() => !fs.existsSync(SAME_LOCK), 5000);
  }
}

// --- [#72] boards outside the repo, each in a folder of its own -----------------------------------
// A board file in `ROOT/<folder>/<name>.tldr`, its folder created.
// [port] Inside the main checkout, where the placement rule lets a board be; git-ignored.
function boardIn(folder: string, name: string): string {
  const dir = path.join(LOOSE, folder);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.tldr`);
}
// Write a room snapshot holding `ids`, edited `bumps` more times, to `file`; with `clock`, its sync
// clock is set to that value. Answers the snapshot's sync clock.
async function writeBoard(file: string, ids: string[], bumps = 0, clock?: number): Promise<number> {
  const room = new TLSocketRoom<TLRecord>({});
  for (const id of ids) await room.updateStore((s) => { s.put(geoRecord(id)); });
  for (let i = 0; i < bumps; i++) await room.updateStore((s) => { s.put({ ...geoRecord(ids[0]!), x: i + 1 }); });
  const snapshot = room.getCurrentSnapshot();
  room.close();
  if (clock !== undefined) Object.assign(snapshot, { clock, documentClock: clock, tombstoneHistoryStartsAtClock: Math.min(snapshot.tombstoneHistoryStartsAtClock ?? clock, clock) });
  fs.writeFileSync(file, JSON.stringify(snapshot));
  return snapshot.documentClock ?? 0;
}
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});
const homeFile = (name: string, ext: string): string => path.join(MAIN_HOME, `${name}.${ext}`);
async function bootOn(file: string, name: string): Promise<{ server: BootedServer; port: number }> {
  const server = boot(MAIN, file);
  ok(await waitFor(() => readLock(homeFile(name, 'lock'))?.pid === server.pid, 20000), `a server holds ${path.relative(ROOT, file)}`);
  await listening(server);
  return { server, port: readLock(homeFile(name, 'lock'))?.port ?? 0 };
}
async function stopOn(server: BootedServer, name: string): Promise<void> {
  await stop(server);
  await waitFor(() => !fs.existsSync(homeFile(name, 'lock')), 5000);
}
const itemIdsOn = async (port: number): Promise<string[]> => ((await getJson<CanvasStatus>(port, '/canvas-status')).doorbell?.items ?? []).map((i) => i.id);
const messageIdsOn = async (port: number): Promise<string[]> => (await getJson<{ messages: StoredMessage[] }>(port, '/messages')).messages.map((m) => m.id);
type RecipientEntry = string | { id: string; boardPath: string };
const recipientEntries = (name: string): RecipientEntry[] => readJson<RecipientEntry[]>(homeFile(name, 'recipients.json')) ?? [];
const sendToWorker = (port: number, id: string, key: string) =>
  postJson<{ ok?: boolean; error?: string }>(port, '/message', { text: `to ${id}`, idempotencyKey: key, recipient: { kind: 'worker', id } });

// [#72] SPEC §8.3's sync-clock fence. A sync tab that stays connected to the board while it switches
// onto another file of its name reconnects to a room loaded from that file, and holds exactly that
// file's shapes: when the target's clock is ahead of the room's, and when the two are equal.
async function otherTabResetOnSameNameSwitch(): Promise<void> {
  console.log('\n[fence] a tab that did not switch holds exactly the new file after a same-name switch');
  const name = 'xfence';
  const first = boardIn('fence-a', name);
  const ahead = boardIn('fence-b', name);
  const equal = boardIn('fence-c', name);
  await writeBoard(first, ['shape:fence-a1', 'shape:fence-a2']);
  const { server, port } = await bootOn(first, name);
  let tab: SyncPeer | null = null;
  try {
    tab = await syncPeer(port, name);
    eq(tab.shapes(), 'shape:fence-a1,shape:fence-a2', 'the tab holds the first file');
    const left = (await getJson<CanvasStatus>(port, '/canvas-status')).roomClock ?? 0;
    const aheadClock = await writeBoard(ahead, ['shape:fence-b1'], 30);
    ok(aheadClock > left, `the target's sync clock is ahead of the room's (${aheadClock} > ${left})`);
    eq((await postJson<{ room?: string }>(port, '/board/open', { path: ahead })).status, 200, 'the switch onto the file whose clock is ahead answers 200');
    ok(await waitFor(() => tab!.shapes() === 'shape:fence-b1', 15000), `the tab reconnects holding exactly that file's shapes (holds ${tab.shapes()})`);

    const now = (await getJson<CanvasStatus>(port, '/canvas-status')).roomClock ?? 0;
    await writeBoard(equal, ['shape:fence-c1'], 0, now);
    // Read back from disk and against the room as it is just before the switch: a room that moved on
    // would make this the target-behind case, which passes without the fence.
    const atSwitch = (await getJson<CanvasStatus>(port, '/canvas-status')).roomClock;
    eq(readJson<{ documentClock?: number }>(equal)?.documentClock, atSwitch, "a third file's sync clock, on disk, equals the room's just before the switch");
    eq((await postJson<{ room?: string }>(port, '/board/open', { path: equal })).status, 200, 'the switch onto it answers 200');
    ok(await waitFor(() => tab!.shapes() === 'shape:fence-c1', 15000), `the tab reconnects holding exactly that file's shapes (holds ${tab.shapes()})`);
    tab.put('shape:fence-after');
    ok(await waitFor(() => fileHasShape(equal, 'shape:fence-after'), 8000), 'and its next drawing is saved to that file');
  } finally {
    tab?.close();
    await stopOn(server, name);
  }
}

// [#72] The recipients follow a same-name switch, re-stamped with the new file; a server on the file
// left then starts with none, and a server on the new file has them.
async function recipientsFollowSameNameSwitch(): Promise<void> {
  console.log('\n[recipients] a same-name switch carries the worker keys; a server on the file left has none');
  const name = 'xrcpt';
  const first = boardIn('rcpt-a', name);
  const second = boardIn('rcpt-b', name);
  const keysFor = (file: string): string => recipientEntries(name).filter((e) => typeof e !== 'string' && e.boardPath === file).map((e) => (e as { id: string }).id).join(',');
  const a = await bootOn(first, name);
  try {
    eq((await postJson<{ sessionId?: string }>(a.port, '/session/register', { name: 'Claude-7', clientKey: 'worker-7' })).status, 200, 'a worker registers on the board');
    ok(await waitFor(() => keysFor(first) === 'worker-7', 3000), "its key is recorded, stamped with the board's file");
    eq((await postJson(a.port, '/board/open', { path: second })).status, 200, 'the board switches onto another file of its name');
    eq(keysFor(second), 'worker-7', 'the key is re-stamped with the new file');
    eq(keysFor(first), '', 'and none is left stamped with the file left');
  } finally {
    await stopOn(a.server, name);
  }
  const left = await bootOn(first, name);
  try {
    const sent = await sendToWorker(left.port, 'worker-7', 'xrcpt-left');
    eq(`${sent.status} ${sent.body.error}`, '400 unknown recipient id: worker-7', 'a server on the file left starts with no recipients');
  } finally {
    await stopOn(left.server, name);
  }
  const moved = await bootOn(second, name);
  try {
    eq((await sendToWorker(moved.port, 'worker-7', 'xrcpt-moved')).status, 200, 'a server on the new file knows the worker');
  } finally {
    await stopOn(moved.server, name);
  }
}

// [#72] A chat entry, a port record and a recipient with no stamp, as a server older than #72 wrote
// them, are the board's: the board boots on that port, shows and rings that chat, and knows that
// worker, and stamps each with its file when it next writes it.
async function unstampedEntriesAdopted(): Promise<void> {
  console.log('\n[adopt] unstamped chat, port and recipient entries are the board\'s');
  const name = 'xadopt';
  const file = boardIn('adopt', name);
  const recorded = await freePort();
  fs.writeFileSync(homeFile(name, 'port'), JSON.stringify({ port: recorded, board: name, pid: 999999, at: Date.now() }));
  fs.writeFileSync(homeFile(name, 'messages.jsonl'), `${JSON.stringify({ id: 'xadopt-old', room: name, ts: Date.now() - 1000, author: { kind: 'human', name: 'You' }, text: 'from an older server', selection: [] })}\n`);
  fs.writeFileSync(homeFile(name, 'recipients.json'), JSON.stringify(['worker-9']));
  const { server, port } = await bootOn(file, name);
  try {
    ok(port === recorded && server._log.includes('(recorded port)'), `it boots on the unstamped record's port (${port} vs ${recorded})`);
    eq(readJson<PortRecord>(homeFile(name, 'port'))?.boardPath, file, "and re-stamps the record with the board's file");
    eq((await messageIdsOn(port)).join(','), 'xadopt-old', 'the unstamped chat entry is its conversation');
    ok(await waitFor(async () => (await itemIdsOn(port)).includes('xadopt-old'), 3000), 'and its pending lead Send is on the doorbell');
    eq((await sendToWorker(port, 'worker-9', 'xadopt-w9')).status, 200, 'the unstamped worker key is a known recipient');
    const lead = (await postJson<{ sessionId?: string }>(port, '/session/register', { name: 'Claude', clientKey: 'lead' })).body.sessionId;
    await getJson(port, `/pending?sessionId=${lead}`);
    ok(await waitFor(() => logEntries(homeFile(name, 'messages.jsonl')).find((m) => m.id === 'xadopt-old')?.boardPath === file, 3000), "the chat entry is stamped with the board's file on the next rewrite");
    await postJson(port, '/session/register', { name: 'Claude-10', clientKey: 'worker-10' });
    ok(await waitFor(() => recipientEntries(name).some((e) => typeof e !== 'string' && e.id === 'worker-9' && e.boardPath === file), 3000), "and the worker key on the next recipients write");
  } finally {
    await stopOn(server, name);
  }
}

// [#71] An in-app switch onto a name that another live server holds for another file is a 409 with
// the documented line, and the switching server stays on its board.
async function switchOntoOtherServersFileRefused(): Promise<void> {
  console.log('\n[switch 409] a switch onto a name another server holds for another file is refused');
  const name = 'x409';
  const held = boardIn('409-a', name);
  const asked = boardIn('409-b', name);
  const hostFile = boardIn('409-host', 'xhost409');
  const owner = await bootOn(held, name);
  let host: { server: BootedServer; port: number } | null = null;
  try {
    host = await bootOn(hostFile, 'xhost409');
    const refused = await postJson<{ error?: string }>(host.port, '/board/open', { path: asked });
    eq(refused.status, 409, 'the switch answers 409');
    eq(refused.body.error, `board '${name}' is open from another file: ${held} (pid ${owner.server.pid}, port ${owner.port}); not serving ${asked}. Close it there, or open that file.`, 'with the documented line');
    const status = await getJson<CanvasStatus>(host.port, '/canvas-status');
    eq(`${status.activeRoom} ${status.boardPath}`, `xhost409 ${hostFile}`, 'and the switching server stays on its board');
    eq(readLock(homeFile(name, 'lock'))?.pid, owner.server.pid, "the owner's lock is left in place");
  } finally {
    if (host) await stopOn(host.server, 'xhost409');
    await stopOn(owner.server, name);
  }
}

// [#72] One file reached through a symlinked folder is one board: the lock and stamps name its real
// folder, a second server through the other spelling is refused as the same board, and a boot
// through the real folder keeps the port and the chat stamped through the symlink.
async function symlinkedFolderIsOneBoard(): Promise<void> {
  console.log('\n[spelling] one file through a symlinked folder is one board');
  const name = 'xlink';
  const real = boardIn('link-real', name);
  const alias = path.join(LOOSE, 'link-alias', `${name}.tldr`);
  fs.symlinkSync(path.dirname(real), path.dirname(alias));
  await writeBoard(real, ['shape:link']);
  const a = await bootOn(alias, name);
  let second: BootedServer | null = null;
  try {
    eq(readLock(homeFile(name, 'lock'))?.boardPath, real, 'booted through the symlink, the lock names the real folder');
    eq((await postJson(a.port, '/message', { text: 'kept', idempotencyKey: 'xlink-chat' })).status, 200, 'a chat message is left on the board');
    second = boot(MAIN, real);
    const s = second;
    ok(await waitFor(() => exited(s), 20000), 'a second server through the real folder exits at boot');
    ok(s.exitCode === 3 && s._log.includes(`[bridge] board '${name}' is already served by pid ${a.server.pid}`), 'as the same board, already served');
    ok(!s._log.includes('is open from another file'), 'not as another file');
  } finally {
    if (second) await stop(second);
    await stopOn(a.server, name);
  }
  // Stamps from a server that compared spellings, through the symlink.
  const portRecord = readJson<Record<string, unknown>>(homeFile(name, 'port'))!;
  fs.writeFileSync(homeFile(name, 'port'), JSON.stringify({ ...portRecord, boardPath: alias }));
  const log = homeFile(name, 'messages.jsonl');
  fs.writeFileSync(log, logEntries(log).map((m) => `${JSON.stringify({ ...m, boardPath: alias })}\n`).join(''));
  const b = await bootOn(real, name);
  try {
    ok(b.port === portRecord.port && b.server._log.includes('(recorded port)'), `a boot through the real folder keeps the port stamped through the symlink (${b.port} vs ${String(portRecord.port)})`);
    eq((await messageIdsOn(b.port)).join(','), 'xlink-chat', 'and the chat');
    eq((await postJson(b.port, '/board/open', { path: alias })).status, 200, 'a switch to the symlinked spelling answers 200');
    ok(!b.server._log.includes(`room '${name}' moved from`), 'as the board it hosts, with no move to another file');
  } finally {
    await stopOn(b.server, name);
  }
}

// [#72] Blocker of PR #291 round 3. A board homed under its own name (copied to a tracked path and
// switched onto) and closed with /done keeps `{ board, boardPath }` in its port record, and its bare
// name then opens the tracked file, with its chat and its pending lead Send, never the scratch copy
// it left. The server's resolution of the bare name is /board/new's here, and the default boot's in
// bareNameRecordedFile.
async function bareNameOpensHomedFile(): Promise<void> {
  console.log('\n[homing] after homing under the same name and /done, the bare name opens the tracked file');
  const name = 'xhome';
  const scratch = homeFile(name, 'tldr');
  const tracked = path.join(MAIN, 'boards', `${name}.tldr`);
  const portFile = homeFile(name, 'port');
  const first = await bootOn(scratch, name);
  let tab: SyncPeer | null = null;
  try {
    tab = await syncPeer(first.port, name);
    tab.put('shape:before-home');
    ok(await waitFor(() => fileHasShape(scratch, 'shape:before-home'), 8000), 'a drawing is saved to the scratch board');
    tab.close();
    tab = null;
    eq((await postJson(first.port, '/message', { text: 'draw this', idempotencyKey: 'xhome-pending' })).status, 200, 'a Send to the lead is left pending');
    fs.copyFileSync(scratch, tracked);
    const opened = await postJson<{ room?: string }>(first.port, '/board/open', { path: tracked });
    eq(`${opened.status} ${opened.body.room}`, `200 ${name}`, 'the board switches onto its tracked copy under its own name');
    tab = await syncPeer(first.port, name);
    tab.put('shape:after-home');
    ok(await waitFor(() => fileHasShape(tracked, 'shape:after-home'), 8000), 'a drawing after the switch is saved to the tracked file');
    ok(!fileHasShape(scratch, 'shape:after-home'), 'and not to the scratch board');
    tab.close();
    tab = null;
    eq((await postJson(first.port, '/done', {})).status, 200, 'the operator closes the board with /done');
    ok(await waitFor(() => exited(first.server), 10000), 'and the server exits');
  } finally {
    tab?.close();
    await stopOn(first.server, name);
  }
  eq(fs.readFileSync(portFile, 'utf8'), JSON.stringify({ board: name, boardPath: tracked }), '/done leaves the port record as exactly { board, boardPath }');

  // A boot on the file the record names, as SKILL step 1 resolves the bare name.
  const again = await bootOn(tracked, name);
  try {
    ok(again.server._log.includes('(ephemeral)'), 'it boots on a fresh port');
    const reopened = await syncPeer(again.port, name);
    ok(reopened.has('shape:after-home'), 'on the tracked file, with the drawing made after the switch');
    reopened.close();
    ok((await messageIdsOn(again.port)).includes('xhome-pending'), 'with its chat');
    ok(await waitFor(async () => (await itemIdsOn(again.port)).includes('xhome-pending'), 3000), 'and its pending lead Send on the doorbell');
  } finally {
    await stopOn(again.server, name);
  }

  // The server's own resolution of a bare name: /board/new from a server on another board.
  const host = await bootOn(boardIn('home-host', 'xhomehost'), 'xhomehost');
  try {
    const made = await postJson<{ path?: string; room?: string }>(host.port, '/board/new', { name });
    eq(`${made.status} ${made.body.room} ${made.body.path}`, `200 ${name} ${tracked}`, '/board/new with the bare name opens the tracked file');
    ok((await messageIdsOn(host.port)).includes('xhome-pending'), 'with its chat');
    ok(await waitFor(async () => (await itemIdsOn(host.port)).includes('xhome-pending'), 3000), 'and its pending lead Send on the doorbell');
  } finally {
    await stop(host.server);
    await waitFor(() => !fs.existsSync(homeFile(name, 'lock')), 5000);
  }
}

// [#72 clause 6] Blocker of PR #291 round 4. A bare name resolves through its port record, by
// /board/new and by a default boot alike: a record naming a file that no longer exists is refused
// with one line and left as it is, never resolved to the home's copy; a record whose file name is not
// `<name>.tldr` is no record; a record naming the home's file opens it even before it exists.
async function bareNameRecordedFile(): Promise<void> {
  console.log('\n[bare name] a bare name opens the file its record names, and refuses one that is gone');
  const hostFile = boardIn('bare-host', 'xbarehost');
  const host = await bootOn(hostFile, 'xbarehost');
  try {
    const gone = boardIn('bare-gone', 'xgone');
    const goneRecord = JSON.stringify({ board: 'xgone', boardPath: gone });
    fs.writeFileSync(homeFile('xgone', 'port'), goneRecord);
    const refused = await postJson<{ error?: string }>(host.port, '/board/new', { name: 'xgone' });
    eq(refused.status, 409, '/board/new with a name whose recorded file is gone answers 409');
    eq(refused.body.error, `board 'xgone' is recorded at ${gone}, which no longer exists; see boot-failures.md § "The name's recorded file no longer exists".`, 'with the line naming the recorded file');
    eq(fs.readFileSync(homeFile('xgone', 'port'), 'utf8'), goneRecord, 'and the record is left as it was');
    eq((await getJson<CanvasStatus>(host.port, '/canvas-status')).boardPath, hostFile, 'and the host stays on its board');
    ok(!fs.existsSync(homeFile('xgone', 'tldr')) && !fs.existsSync(homeFile('xgone', 'lock')), 'with no home copy or lock made for the name');

    const fresh = homeFile('xfresh', 'tldr');
    fs.writeFileSync(homeFile('xfresh', 'port'), JSON.stringify({ board: 'xfresh', boardPath: fresh }));
    const opened = await postJson<{ path?: string }>(host.port, '/board/new', { name: 'xfresh' });
    eq(`${opened.status} ${opened.body.path}`, `200 ${fresh}`, "a record naming the home's file opens it before it exists");

    const other = boardIn('bare-mis', 'other');
    await writeBoard(other, ['shape:mis']);
    fs.writeFileSync(homeFile('xmis', 'port'), JSON.stringify({ board: 'xmis', boardPath: other }));
    const mis = await postJson<{ path?: string }>(host.port, '/board/new', { name: 'xmis' });
    eq(`${mis.status} ${mis.body.path}`, `200 ${homeFile('xmis', 'tldr')}`, "a record naming a file not called <name>.tldr counts as no record: the name opens its home file");
  } finally {
    await stop(host.server);
    await waitFor(() => !fs.existsSync(homeFile('xmis', 'lock')), 5000);
  }

  // The default boot (WHITEBOARD_BOARD unset) resolves the default name, `board`, the same way.
  const recorded = boardIn('bare-default', 'board');
  await writeBoard(recorded, ['shape:default']);
  fs.writeFileSync(homeFile('board', 'port'), JSON.stringify({ board: 'board', boardPath: recorded }));
  const first = boot(MAIN, null);
  try {
    ok(await waitFor(() => readLock(homeFile('board', 'lock'))?.pid === first.pid, 20000), 'a default boot holds the default board');
    eq(readLock(homeFile('board', 'lock'))?.boardPath, recorded, "on the file the default name's record names");
  } finally {
    await stopOn(first, 'board');
  }
  fs.rmSync(recorded);
  const record = fs.readFileSync(homeFile('board', 'port'), 'utf8');
  const second = boot(MAIN, null);
  try {
    ok(await waitFor(() => exited(second), 20000), "a default boot whose recorded file is gone exits at boot");
    eq(second.exitCode, 2, 'with exit code 2, as every refused board');
    ok(second._log.includes(`[bridge] board 'board' is recorded at ${recorded}, which no longer exists; see boot-failures.md § "The name's recorded file no longer exists".`), 'and the line naming the recorded file');
    eq(fs.readFileSync(homeFile('board', 'port'), 'utf8'), record, 'and the record is left as it was');
    ok(!fs.existsSync(homeFile('board', 'tldr')) && !fs.existsSync(homeFile('board', 'lock')), 'with no home copy or lock made for the name');
  } finally {
    await stop(second);
  }
}

async function main(): Promise<void> {
  buildFixture();
  console.log('\n[home] the scratchpad home is the main checkout\'s, from either checkout');
  eq(scratchpadHome(MAIN), MAIN_HOME, 'from the main checkout');
  eq(scratchpadHome(LINKED), MAIN_HOME, 'from a linked worktree');
  let bash = false;
  try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); bash = true; } catch { /* no bash */ }
  if (!bash) {
    console.log('  - skipped: comparing with scratchpad.sh root and whiteboard.sh (bash is unavailable)');
  } else {
    // [#71] The server's resolver, the scratchpad skill's and whiteboard.sh's agree on the
    // repository's one `.scratchpad/`.
    for (const [checkout, label] of [[MAIN, 'the main checkout'], [LINKED, 'a linked worktree']] as const) {
      const root = execFileSync('bash', [SCRATCHPAD_SH, 'root'], { cwd: checkout, encoding: 'utf8', env: GIT_ENV }).trim();
      eq(path.dirname(scratchpadHome(checkout)), root, `from ${label}, the home's .scratchpad/ is scratchpad.sh root's`);
      const located = JSON.parse(execFileSync('bash', [WHITEBOARD_SH, 'locate', '--name', BOARD], { cwd: checkout, encoding: 'utf8', env: GIT_ENV })) as { board?: string; lock?: string };
      eq(located.lock, LOCK_PATH, `from ${label}, whiteboard.sh locates the board's lock in the same home`);
    }
    // An inherited GIT_DIR names another repository; the home is still this one's.
    const elsewhere = path.join(ROOT, 'elsewhere');
    git(ROOT, 'init', '-q', elsewhere);
    const located = JSON.parse(execFileSync('bash', [WHITEBOARD_SH, 'locate', '--name', BOARD, '--repo', LINKED], { cwd: LINKED, encoding: 'utf8', env: { ...GIT_ENV, GIT_DIR: path.join(elsewhere, '.git') } })) as { lock?: string };
    eq(located.lock, LOCK_PATH, 'with an inherited GIT_DIR, whiteboard.sh still locates the lock in the main checkout');
  }
  await secondServerRefused(LINKED, MAIN, 'worktree then main checkout');
  await secondServerRefused(MAIN, LINKED, 'main checkout then worktree');
  await sameNameOtherFileRefused();
  await sameServerSwitchLoadsOtherFile();
  await otherFileServerStartsFresh();
  await lockWithoutBoardPathIsSameBoard();
  await otherTabResetOnSameNameSwitch();
  await recipientsFollowSameNameSwitch();
  await unstampedEntriesAdopted();
  await switchOntoOtherServersFileRefused();
  await symlinkedFolderIsOneBoard();
  await bareNameOpensHomedFile();
  await bareNameRecordedFile();
}

main()
  .catch((e) => { failures.push(`ERROR ${(e as Error).stack ?? e}`); console.error('\nERROR', e); })
  .finally(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
    if (failures.length) for (const f of failures) console.log(`  - ${f}`);
    process.exit(failures.length ? 1 : 0);
  });

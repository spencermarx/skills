// Board identity, placement and the board lock, shared by the bridge (index.ts), scripts/whiteboard.sh
// and the tests, so none of them can drift from the others.
//
// A board IS its .tldr file's canonical absolute path. The room id, and the names of the board's
// files in the boards folder (lock, chat log, render, server log), all derive from that path, so
// two boards that share a file name never share a room, and a board keeps one lock however it was
// opened. Plain ESM with no dependencies, so whiteboard.sh and the tests run it with bare node.
//
//   node boards.mjs (--board <file.tldr> | --name <name>) --home <boards folder> --repo <repository>
//     prints {board, name, room, lock, messages, png, log, live} as JSON. `--name` resolves to
//     <boards folder>/<slugFor(name)>.tldr. `live` is the lock when a server holding it is running
//     (pid alive and its port answers for this room), else null. Exit 0 when nothing live holds
//     the board, 4 when a live server does, 2 on a bad argument or a board outside the repository
//     and the boards folder (refused before anything is created).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * The canonical absolute path of a board file (or folder). Neither it nor its folders need exist
 * yet: the nearest existing ancestor is resolved through realpath and the rest is re-appended, so a
 * path through a symlinked folder names the same board before and after its folders are created,
 * and a confinement check sees where the path really leads.
 * @param {string} p
 * @returns {string}
 */
export function canonicalBoardPath(p) {
  const abs = path.resolve(p);
  const tail = [];
  for (let cur = abs; ;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * The file name (without `.tldr`) a board called `name` gets in the boards folder: every run of
 * characters outside letters, digits, `_`, `.` and `-` becomes one `-`, case is kept, and leading
 * or trailing `-` and `.` are dropped. The one rule for the panel's new board, `new <name>` and
 * `open <name>`, so a board made one way is found the others.
 * @param {string} name
 * @returns {string}
 */
export function slugFor(name) {
  const slug = String(name)
    .normalize('NFKC')
    .replace(/\.tldr$/i, '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80)
    .replace(/[-.]+$/g, '');
  return slug || 'board';
}

/**
 * The name people see: the file's base name without `.tldr`.
 * @param {string} p
 * @returns {string}
 */
export function displayName(p) {
  return path.basename(p, path.extname(p));
}

/**
 * The room id for a canonical board path: a slug of its name for legibility, plus a hash of the
 * whole path for identity. Always matches isRoomId.
 * @param {string} canonicalPath
 * @returns {string}
 */
export function roomIdFor(canonicalPath) {
  const slug = displayName(canonicalPath).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'board';
  const hash = createHash('sha256').update(canonicalPath).digest('hex').slice(0, 10);
  return `${slug}-${hash}`;
}

/**
 * A room id the bridge accepts from a client: the `[\w.-]` alphabet `/board/new` slugs names
 * into, never a path separator, never `..`.
 * @param {unknown} id
 * @returns {id is string}
 */
export function isRoomId(id) {
  return typeof id === 'string' && /^[\w.-]{1,128}$/.test(id) && !id.includes('..');
}

/**
 * Whether `p` is `dir` or inside it. Both must already be canonical.
 * @param {string} dir
 * @param {string} p
 * @returns {boolean}
 */
export function isWithin(dir, p) {
  const rel = path.relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Why a canonical board path may not be a board, or null when it may: it must be a .tldr file
 * inside the repository or the boards folder. All three paths must already be canonical.
 * @param {string} board
 * @param {string} repo
 * @param {string} home
 * @returns {string | null}
 */
export function placementRefusal(board, repo, home) {
  if (path.extname(board).toLowerCase() !== '.tldr') return `not a board: ${board} (a board is a .tldr file)`;
  if (!isWithin(repo, board) && !isWithin(home, board)) return `outside the repository: ${board}`;
  return null;
}

/**
 * Where a board's own files live: always the boards folder, wherever its .tldr is.
 * @param {string} home the boards folder
 * @param {string} room
 */
export function sidecarPaths(home, room) {
  return {
    lock: path.join(home, `${room}.lock`),
    messages: path.join(home, `${room}.messages.jsonl`),
    png: path.join(home, `${room}.png`),
    log: path.join(home, `${room}.log`),
  };
}

/**
 * The lock: `room` is the room id, `path` the board file. `port` is 0 while the server that
 * claimed it is still starting.
 * @typedef {{ port: number, pid: number, room: string, path?: string, name?: string,
 *   startedAt: number, ownerSession?: string, ownerSessionId?: string }} LockInfo
 */

/**
 * The lock's contents, or null when there is none or it cannot be read.
 * @param {string} lockPath
 * @returns {LockInfo | null}
 */
export function readLock(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (parsed && typeof parsed.port === 'number' && typeof parsed.pid === 'number') return parsed;
  } catch {
    /* no lock, or unreadable: no owner */
  }
  return null;
}

/**
 * kill(pid, 0) probes without signalling: ESRCH is gone, EPERM is alive under another user. A
 * live pid alone proves nothing (pids are reused); probeCanvasStatus is the confirmation.
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM';
  }
}

/**
 * Whether a whiteboard server on `port` answers and is hosting `room`. Never throws. It sends no
 * Origin and no Sec-Fetch-* header, so the bridge's client check lets it through. A 403 means
 * something answered and refused: it counts as live but unverified, never as "not live", so a
 * refused probe can never make a live server's lock read as stale.
 * @param {number} port
 * @param {string} room
 * @returns {Promise<boolean>}
 */
export function probeCanvasStatus(port, room) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/canvas-status', timeout: 1000 }, (res) => {
      if (res.statusCode === 403) { res.resume(); resolve(true); return; }
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw).activeRoom === room);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * The lock of a live server hosting `room`, or null: no lock, a stale lock (dead pid, or a port
 * that no longer answers for this room), or a lock held by `selfPid`.
 * @param {string} home
 * @param {string} room
 * @param {number} [selfPid]
 * @returns {Promise<LockInfo | null>}
 */
export async function liveOwner(home, room, selfPid) {
  const lock = readLock(sidecarPaths(home, room).lock);
  if (!lock || !lock.port || lock.pid === selfPid || !pidAlive(lock.pid)) return null;
  return (await probeCanvasStatus(lock.port, room)) ? lock : null;
}

// How long a lock claimed by a server that has not yet listened (port 0) counts as held while its
// pid lives. Boot takes a second or two; past this the claimant is presumed hung and its lock stale.
const BOOT_GRACE_MS = 60_000;

/**
 * Who holds a lock against `selfPid`: a live server answering for the room, or one still starting
 * (port 0, pid alive, claimed within BOOT_GRACE_MS). Null when nobody does, or the lock is ours.
 * @param {string} lockPath
 * @param {string} room
 * @param {number} selfPid
 * @returns {Promise<LockInfo | null>}
 */
async function lockHolder(lockPath, room, selfPid) {
  const lock = readLock(lockPath);
  if (!lock || lock.pid === selfPid || !pidAlive(lock.pid)) return null;
  if (!lock.port) return Date.now() - Number(lock.startedAt) < BOOT_GRACE_MS ? lock : null;
  return (await probeCanvasStatus(lock.port, room)) ? lock : null;
}

/** @param {string} p */
function readRaw(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a file whole: a reader sees the old contents or the new, never a partial write.
 * @param {string} file
 * @param {string} body
 */
function writeWhole(file, body) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
}

/**
 * Claim a board's lock exclusively. The lock is created by hard-linking a fully written temp file
 * into place: an exclusive create, like open(lock, 'wx'), that never shows a reader a half-written
 * lock. On EEXIST the holder is probed: a live or starting server keeps it ({ok:false, holder}); a
 * stale lock is removed, only if it has not changed since it was judged stale, and the claim is
 * retried once. A lock this process already holds is rewritten with `content`.
 * @param {string} lockPath
 * @param {string} room
 * @param {LockInfo} content
 * @returns {Promise<{ ok: true } | { ok: false, holder: LockInfo | null }>}
 */
export async function claimLock(lockPath, room, content) {
  const body = JSON.stringify(content);
  for (let attempt = 0; attempt < 2; attempt++) {
    const tmp = `${lockPath}.${content.pid}.claim`;
    fs.writeFileSync(tmp, body);
    try {
      fs.linkSync(tmp, lockPath);
      return { ok: true };
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'EEXIST') throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const seen = readRaw(lockPath);
    if (readLock(lockPath)?.pid === content.pid) {
      writeWhole(lockPath, body);
      return { ok: true };
    }
    const holder = await lockHolder(lockPath, room, content.pid);
    if (holder) return { ok: false, holder };
    if (seen !== null && readRaw(lockPath) === seen) fs.rmSync(lockPath, { force: true });
  }
  return { ok: false, holder: readLock(lockPath) };
}

/**
 * Rewrite a lock this process holds, to fill in the port once it listens. Returns false, and
 * writes nothing, when the lock is no longer ours.
 * @param {string} lockPath
 * @param {LockInfo} content
 * @returns {boolean}
 */
export function updateLock(lockPath, content) {
  if (readLock(lockPath)?.pid !== content.pid) return false;
  writeWhole(lockPath, JSON.stringify(content));
  return true;
}

function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  /** @type {Record<string, string>} */
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? '';
    if (!['--board', '--name', '--home', '--repo'].includes(flag) || argv[i + 1] === undefined) {
      console.error(`boards.mjs: unknown or incomplete argument: ${flag}`);
      process.exit(2);
    }
    args[flag.slice(2)] = argv[i + 1] ?? '';
  }
  if (!args.home || !args.repo || !!args.board === !!args.name) {
    console.error('usage: node boards.mjs (--board <file.tldr> | --name <name>) --home <boards folder> --repo <repository>');
    process.exit(2);
  }
  const home = canonicalBoardPath(args.home);
  const repo = canonicalBoardPath(args.repo);
  const board = canonicalBoardPath(args.board ?? path.join(home, `${slugFor(args.name ?? '')}.tldr`));
  const refusal = placementRefusal(board, repo, home);
  if (refusal) {
    console.error(`boards.mjs: ${refusal}`);
    process.exit(2);
  }
  const room = roomIdFor(board);
  const live = await liveOwner(home, room);
  console.log(JSON.stringify({ board, name: displayName(board), room, ...sidecarPaths(home, room), live }));
  process.exit(live ? 4 : 0);
}

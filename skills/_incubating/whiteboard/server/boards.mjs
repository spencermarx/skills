// Board identity and the board lock, shared by the bridge (index.ts) and scripts/whiteboard.sh.
//
// A board IS its .tldr file's canonical absolute path. The room id, and the names of the board's
// files in the boards folder (lock, chat log, render, server log), all derive from that path, so
// two boards that share a file name never share a room, and a board keeps one lock however it was
// opened. Plain ESM with no dependencies, so whiteboard.sh and the tests run it with bare node.
//
//   node boards.mjs <board.tldr> <boards folder>
//     prints {board, name, room, lock, messages, png, log, live} as JSON. `live` is the lock when
//     a server holding it is running (pid alive and its port answers for this room), else null.
//     Exit 0 when nothing live holds the board, 4 when a live server does, 2 on a bad argument.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/**
 * The canonical absolute path of a board file. The file need not exist yet: its folder is
 * resolved through realpath when it exists, so a symlinked folder and its target name one board.
 * @param {string} p
 * @returns {string}
 */
export function canonicalBoardPath(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* the board does not exist yet; canonicalise its folder */
  }
  let dir = path.dirname(abs);
  try {
    dir = fs.realpathSync.native(dir);
  } catch {
    /* nor does its folder */
  }
  return path.join(dir, path.basename(abs));
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
 * @typedef {{ port: number, pid: number, board: string, path?: string, name?: string,
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
 * Whether a whiteboard server on `port` answers and is hosting `room`. Never throws.
 * @param {number} port
 * @param {string} room
 * @returns {Promise<boolean>}
 */
export function probeCanvasStatus(port, room) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/canvas-status', timeout: 1000 }, (res) => {
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
  if (!lock || lock.pid === selfPid || !pidAlive(lock.pid)) return null;
  return (await probeCanvasStatus(lock.port, room)) ? lock : null;
}

function isMain() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [boardArg, homeArg] = process.argv.slice(2);
  if (!boardArg || !homeArg) {
    console.error('usage: node boards.mjs <board.tldr> <boards folder>');
    process.exit(2);
  }
  if (path.extname(boardArg).toLowerCase() !== '.tldr') {
    console.error(`boards.mjs: a board is a .tldr file, not ${boardArg}`);
    process.exit(2);
  }
  const home = canonicalBoardPath(homeArg);
  const board = canonicalBoardPath(boardArg);
  const room = roomIdFor(board);
  const live = await liveOwner(home, room);
  console.log(JSON.stringify({ board, name: displayName(board), room, ...sidecarPaths(home, room), live }));
  process.exit(live ? 4 : 0);
}

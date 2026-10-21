// Board naming, placement and liveness, shared by the bridge (index.ts), scripts/whiteboard.sh and the
// tests, so none of them can drift from the others. Plain ESM with no dependencies, so whiteboard.sh
// and the tests run it with bare node.
//
// A board is a .tldr file; its room id is the file's name without `.tldr`, and its own files (lock,
// port record, chat log, recipients, render, server log) live in the boards folder under that name.
// The lock and its one-server check belong to the bridge (index.ts, claimLock); this file only reads
// a lock to say whether a live server holds it.
//
//   node boards.mjs (--board <file.tldr> | --name <name>) --home <boards folder> --repo <repository>
//     prints {board, name, room, lock, port, messages, recipients, png, log, live} as JSON. `--name`
//     resolves to <boards folder>/<slugFor(name)>.tldr. `live` is the lock when a live server holds
//     the board (see liveOwner), else null. Exit 0 when nothing live holds it, 3 when a live server
//     does, 2 on a bad argument or a board the placement rule refuses (refused before anything is
//     created; the reason is on stderr).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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
 * A board's room id, as the bridge names it: its file name without `.tldr`.
 * @param {string} boardPath
 * @returns {string}
 */
export function roomFor(boardPath) {
  return displayName(boardPath);
}

/**
 * A room id the bridge accepts from a client: never a path separator, never `..`.
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
 * inside the repository or the boards folder, and its folder must already exist, since a board the
 * server could never save is refused rather than lost. The boards folder itself is the exception:
 * `whiteboard.sh start` and the server create it. One rule for `locate`, `start`, the server's boot,
 * `/board/open` and `/snapshot`, so each refuses before anything is created. All three paths must
 * already be canonical.
 * @param {string} board
 * @param {string} repo
 * @param {string} home
 * @returns {string | null}
 */
export function placementRefusal(board, repo, home) {
  if (path.extname(board).toLowerCase() !== '.tldr') return `not a board: ${board} (a board is a .tldr file)`;
  if (!isWithin(repo, board) && !isWithin(home, board)) return `outside the repository: ${board}`;
  const folder = path.dirname(board);
  if (folder !== home && !fs.existsSync(folder)) return `its folder does not exist: ${folder}`;
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
    port: path.join(home, `${room}.port`),
    messages: path.join(home, `${room}.messages.jsonl`),
    recipients: path.join(home, `${room}.recipients.json`),
    png: path.join(home, `${room}.png`),
    log: path.join(home, `${room}.log`),
  };
}

/**
 * The lock the bridge writes: `board` is the room id; `parentPid` the process it exits with (its own
 * pid when `detached`).
 * @typedef {{ port: number, pid: number, board?: string, startedAt?: number, ownerSession?: string,
 *   ownerSessionId?: string, parentPid?: number, ownerIsClaude?: boolean | null, detached?: boolean }} LockInfo
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
 * live pid alone proves nothing (pids are reused); the /canvas-status probe is the confirmation.
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
 * Whether a whiteboard server on `port` answers within 3 s and hosts `room`: only a 200 whose
 * `activeRoom` is the room counts. Never throws.
 * @param {number} port
 * @param {string} room
 * @returns {Promise<boolean>}
 */
function hostsRoom(port, room) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/canvas-status', timeout: 3000 }, (res) => {
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
 * The lock of a live server hosting `room`, or null. Live is the skill's attach check: the lock's
 * pid is alive, its parentPid is a number and alive, and its port's /canvas-status names the room.
 * A lock with no parentPid is from an older server, which the bridge's own boot refuses to run
 * beside (exit 4); it never reads as live here.
 * @param {string} home
 * @param {string} room
 * @returns {Promise<LockInfo | null>}
 */
export async function liveOwner(home, room) {
  const lock = readLock(sidecarPaths(home, room).lock);
  if (!lock || !lock.port || !pidAlive(lock.pid)) return null;
  if (typeof lock.parentPid !== 'number' || !pidAlive(lock.parentPid)) return null;
  return (await hostsRoom(lock.port, room)) ? lock : null;
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
  const room = roomFor(board);
  const live = await liveOwner(home, room);
  console.log(JSON.stringify({ board, name: displayName(board), room, ...sidecarPaths(home, room), live }));
  process.exit(live ? 3 : 0);
}

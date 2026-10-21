// Shared by the whiteboard server suites: each suite works in its own throwaway repository (a temp
// folder with its own boards folder, never this repository's .scratchpad/), and every server it
// starts is stopped, in the suite's `finally` and again when the suite process exits.
//
// A server runs as `node --import tsx index.ts`, the skill's boot, so the server is the spawned
// process itself. Each is spawned in its own process group and stopped by signalling the whole group,
// so neither it nor a Chromium it launched outlives the suite, whichever signal is sent.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', '_incubating', 'whiteboard');
export const SERVER_DIR = path.join(SKILL_DIR, 'server');
export const TSX = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
// The board identity the server and whiteboard.sh use, so a suite derives the same room ids.
export const boards = await import(pathToFileURL(path.join(SERVER_DIR, 'boards.mjs')).href);

// What the real-browser phases need, so a suite skips them where they are missing (CI has neither).
const chromiumPath = await (async () => {
  try {
    const { chromium } = await import(pathToFileURL(path.join(SERVER_DIR, 'node_modules', 'playwright', 'index.mjs')).href);
    return chromium.executablePath();
  } catch {
    return null;
  }
})();
export const hasChromium = () => !!chromiumPath && fs.existsSync(chromiumPath);
export const hasAppBuild = () => fs.existsSync(path.join(SKILL_DIR, 'app', 'dist', 'index.html'));

// The environment a suite server must never inherit: a real session's inbox (it would ring the
// session running the tests), its identity, and a PORT from the caller's profile.
export const SCRUBBED_ENV = ['CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_JOB_DIR', 'PORT'];
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of SCRUBBED_ENV) delete env[name];
  return { ...env, ...extra };
}

const spawned = [];
const sandboxes = [];

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* the group is already gone */
  }
}

process.on('exit', () => {
  for (const child of spawned) killGroup(child, 'SIGKILL');
  for (const root of sandboxes) fs.rmSync(root, { recursive: true, force: true });
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(130));

// A throwaway repository: `root` is the repository, `home` its boards folder.
export function sandbox(label) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wb-${label}-`)));
  sandboxes.push(root);
  const home = path.join(root, '.scratchpad', 'whiteboard');
  fs.mkdirSync(home, { recursive: true });
  const board = (name, dir = home) => path.join(dir, `${name}.tldr`);
  const room = (boardPath) => boards.roomFor(boardPath);
  const files = (boardPath) => boards.sidecarPaths(home, room(boardPath));
  return { root, home, board, room, files, env: { WHITEBOARD_REPO: root, WHITEBOARD_HOME: home } };
}

// The render-canvas key every suite server is started with, so a suite's stand-in render-canvas
// can take the role=agent /events slot: `/events?role=agent&canvasKey=${CANVAS_KEY}`.
export const CANVAS_KEY = 'suite-canvas-key';

// Start a bridge on `boardPath` with the render-canvas skipped. `server.port` resolves once it is
// listening; `server.exited` resolves with {code, signal} when it exits; `server.output` is its log.
export function startServer(sb, boardPath, extraEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'index.ts'], {
    cwd: SERVER_DIR,
    detached: true,
    env: cleanEnv({ WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_CANVAS_KEY: CANVAS_KEY, ...sb.env, WHITEBOARD_BOARD: boardPath, ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.port = new Promise((resolve, reject) => {
    const onData = () => {
      const m = child.output.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.exited.then(({ code }) => reject(new Error(`server for ${boardPath} exited early (code ${code})\n${child.output}`)));
    setTimeout(() => reject(new Error(`server for ${boardPath} never printed a port\n${child.output}`)), 20000).unref();
  });
  child.port.catch(() => {}); // a suite that expects a refused boot awaits `exited` instead
  child._port = child.port;
  return child;
}

// Stop a server: `signal` to its whole group, then SIGKILL if it has not exited within `ms`.
export async function stopServer(child, signal = 'SIGTERM', ms = 5000) {
  if (child.exitCode === null && child.signalCode === null) {
    killGroup(child, signal);
    const timer = setTimeout(() => killGroup(child, 'SIGKILL'), ms);
    await child.exited;
    clearTimeout(timer);
  }
  killGroup(child, 'SIGKILL');
}

export async function stopAllServers() {
  await Promise.all(spawned.map((child) => stopServer(child)));
}

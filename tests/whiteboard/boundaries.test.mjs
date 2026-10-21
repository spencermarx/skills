// The port's own boundaries, re-applied on upstream's server: what upstream's Origin/Host guard and
// lock do not already cover (doorbell.test.ts tests those). Headless (WHITEBOARD_NO_CANVAS), in a
// throwaway repository. Each check fails against the server without its fix. Exit 0 = all pass.
//
//   1. No framing: every answer, a 403, a 404 and the app's own page included, forbids framing.
//   2. The render-canvas slot: /events as role=agent (or with no role) needs the server's canvas
//      key, and the key is never logged.
//   3. JSON-only control POSTs: /done and /request-teardown refuse any other content-type (415).
//   4. Sends only by POST: an /events `message` frame stores nothing.
//   5. Placement: a board outside the repository, in a folder that does not exist, or not a .tldr is
//      refused at boot (exit 2, nothing created), by /board/open and by /snapshot?path; a relative
//      path resolves against the repository; GET /messages refuses a room id that is a path.
//   6. A board it cannot load is never overwritten: unparseable JSON and tldraw.com's file format exit
//      1 at boot and answer 422 on a switch, leaving the file byte-identical.
//   7. A switch whose outgoing board cannot be saved is refused (503): the server stays on it, keeps
//      its lock, takes no lock on the target, and says in the panel that saving failed.
//   8. Naming: /board/new uses the one slug rule, an agent without a name is "Agent", and boards.mjs
//      locates a board in WHITEBOARD_HOME (exit 3 live, 0 free, 2 refused).
//
//   node --import tsx tests/whiteboard/boundaries.test.mjs   (cwd: the skill's server/)

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CANVAS_KEY, SERVER_DIR, sandbox, startServer, stopAllServers, stopServer } from './harness.mjs';

const serverRequire = createRequire(path.join(SERVER_DIR, 'package.json'));
const { WebSocket } = serverRequire('ws');
const { TLSocketRoom } = serverRequire('@tldraw/sync-core');

const SB = sandbox('boundaries');

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// A real room snapshot, pretty-printed so any rewrite by the server (which writes compact JSON)
// shows up as a byte change.
function writeValidBoard(p) {
  const room = new TLSocketRoom({});
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(room.getCurrentSnapshot(), null, 2));
  room.close();
  return fs.readFileSync(p);
}
function writeFile(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return fs.readFileSync(p);
}
const sameBytes = (p, bytes) => fs.existsSync(p) && fs.readFileSync(p).equals(bytes);

// A raw HTTP request, so a test controls every header. Resolves { status, body, headers }.
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const json = (port, p) => request(port, { path: p }).then((r) => JSON.parse(r.body));
const postJson = (port, p, body) =>
  request(port, { method: 'POST', path: p, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => ({ status: r.status, body: r.body ? JSON.parse(r.body) : null }));

// Open a WebSocket and report how it ended: { opened: true, ws } or { opened: false, status }.
function wsAttempt(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve({ opened: true, ws }));
    ws.once('unexpected-response', (_req, res) => { resolve({ opened: false, status: res.statusCode }); ws.terminate(); });
    ws.once('error', () => resolve({ opened: false, status: null }));
  });
}

// A boot that is expected to be refused: its exit code and output.
async function refusedBoot(boardPath) {
  const server = startServer(SB, boardPath);
  const { code } = await server.exited;
  return { code, output: server.output };
}

async function framing(port) {
  console.log('\n[1] no framing');
  const framed = (r) => r.headers['x-frame-options'] === 'DENY' && /frame-ancestors 'none'/.test(r.headers['content-security-policy'] ?? '');
  ok(framed(await request(port, { path: '/canvas-status' })), 'an API answer forbids framing');
  ok(framed(await request(port, { path: '/' })), 'the app\'s own page forbids framing');
  const refused = await request(port, { path: '/canvas-status', headers: { Origin: 'https://evil.example' } });
  eq(refused.status, 403, 'a foreign Origin is refused');
  ok(framed(refused), 'and the refusal forbids framing');
  const miss = await request(port, { method: 'POST', path: '/no-such-route', headers: { 'content-type': 'application/json' }, body: '{}' });
  eq(miss.status, 404, 'an unknown route is a 404');
  ok(framed(miss), 'which forbids framing too');
  const bad = await request(port, { method: 'POST', path: '/message', headers: { 'content-type': 'application/json' }, body: '{not json' });
  ok(bad.status >= 400 && framed(bad), `a malformed body's error (${bad.status}) forbids framing`);
}

async function canvasSlot(server, port, room) {
  console.log('\n[2] the render-canvas slot needs the canvas key');
  for (const [label, url] of [
    ['no key', `ws://127.0.0.1:${port}/events?role=agent&room=${room}`],
    ['a wrong key', `ws://127.0.0.1:${port}/events?role=agent&room=${room}&canvasKey=guess`],
    ['no role and no key', `ws://127.0.0.1:${port}/events?room=${room}`],
  ]) {
    const a = await wsAttempt(url);
    ok(!a.opened && a.status === 403, `${label}: refused (status ${a.status})`);
  }
  eq((await json(port, '/canvas-status')).connected, false, 'no refused socket became the render-canvas');
  const human = await wsAttempt(`ws://127.0.0.1:${port}/events?role=human&room=${room}`);
  ok(human.opened, 'an operator socket needs no key');
  const canvas = await wsAttempt(`ws://127.0.0.1:${port}/events?role=agent&room=${room}&canvasKey=${CANVAS_KEY}`);
  ok(canvas.opened, 'the server\'s own key opens the render-canvas slot');
  await sleep(100);
  eq((await json(port, '/canvas-status')).connected, true, 'and it is the render-canvas');

  console.log('\n[4] sends only by POST');
  canvas.ws?.send(JSON.stringify({ type: 'message', text: 'from a socket', selection: [] }));
  await sleep(300);
  const log = (await json(port, `/messages?room=${room}`)).messages;
  ok(!log.some((m) => m.text === 'from a socket'), 'an /events message frame stores no Send');
  human.ws?.close();
  canvas.ws?.close();

  await request(port, { path: `/?role=agent&room=${room}&canvasKey=${CANVAS_KEY}` });
  await sleep(100);
  ok(!server.output.includes(CANVAS_KEY), 'the canvas key never appears in the server\'s log');
}

async function jsonOnly(port) {
  console.log('\n[3] JSON-only control POSTs');
  for (const route of ['/request-teardown', '/done']) {
    const plain = await request(port, { method: 'POST', path: route, headers: { 'content-type': 'text/plain' }, body: '{}' });
    eq(plain.status, 415, `${route} refuses text/plain`);
    const none = await request(port, { method: 'POST', path: route });
    eq(none.status, 415, `${route} refuses a body with no content-type`);
  }
  eq((await json(port, '/canvas-status')).teardownRequested, false, 'no refused request flagged a teardown');
  eq((await request(port, { path: '/canvas-status' })).status, 200, 'and the server is still up');
  eq((await postJson(port, '/request-teardown', {})).status, 200, '/request-teardown takes JSON');
}

async function placement(port) {
  console.log('\n[5] placement');
  const outside = path.join(path.dirname(SB.root), `wb-outside-${process.pid}.tldr`); // an existing folder
  const missing = path.join(SB.root, 'no-such-folder', 'x.tldr');
  for (const [label, p, why] of [
    ['outside the repository', outside, /outside the repository/],
    ['in a folder that does not exist', missing, /absolute \.tldr path|folder does not exist/],
    ['not absolute', 'relative/x.tldr', /absolute \.tldr path/],
    ['not a .tldr', path.join(SB.root, 'notes.json'), /absolute \.tldr path/],
  ]) {
    const r = await refusedBoot(p);
    eq(r.code, 2, `a boot on a board ${label} exits 2`);
    ok(why.test(r.output), `saying why (${label})`);
  }
  ok(!fs.existsSync(outside) && !fs.existsSync(path.dirname(missing)), 'and nothing was created for them');

  const open = (p) => postJson(port, '/board/open', { path: p });
  eq((await open(outside)).status, 403, '/board/open refuses a board outside the repository (403)');
  eq((await open(missing)).status, 400, '/board/open refuses a board in a folder that does not exist (400)');
  eq((await open(path.join(SB.root, 'notes.json'))).status, 400, '/board/open refuses a file that is not a .tldr (400)');
  writeFile(outside, '{"documents":[]}');
  const snap = await request(port, { path: `/snapshot?path=${encodeURIComponent(outside)}` });
  eq(snap.status, 403, '/snapshot?path refuses a file outside the repository');
  fs.rmSync(outside, { force: true });
  const local = writeValidBoard(path.join(SB.root, 'docs', 'relative.tldr'));
  const rel = await request(port, { path: `/snapshot?path=${encodeURIComponent('docs/relative.tldr')}` });
  eq(rel.status, 200, 'a relative /snapshot?path resolves against the repository');
  ok(sameBytes(path.join(SB.root, 'docs', 'relative.tldr'), local), 'and reads without writing');
  eq((await request(port, { path: `/messages?room=${encodeURIComponent('../x')}` })).status, 400, 'GET /messages refuses a room id that is a path');
}

async function unloadable(port) {
  console.log('\n[6] a board it cannot load is never overwritten');
  const garbled = SB.board('bd_garbled');
  const garbledBytes = writeFile(garbled, '{"documents": [ this is not json');
  const tldrawCom = SB.board('bd_tldrawcom');
  const tldrawComBytes = writeFile(tldrawCom, JSON.stringify({ tldrawFileFormatVersion: 1, schema: {}, records: [] }));
  for (const [label, p, bytes, why] of [
    ['unparseable JSON', garbled, garbledBytes, /not valid JSON/],
    ['tldraw.com\'s format', tldrawCom, tldrawComBytes, /tldraw\.com's file format/],
  ]) {
    const r = await refusedBoot(p);
    eq(r.code, 1, `a boot on ${label} exits 1`);
    ok(why.test(r.output), `saying why (${label})`);
    ok(sameBytes(p, bytes), `the file is byte-identical (${label})`);
    const sw = await postJson(port, '/board/open', { path: p });
    eq(sw.status, 422, `a switch to ${label} is a 422`);
    ok(sameBytes(p, bytes), `and the file is still byte-identical (${label})`);
  }
}

async function unsavedSwitch() {
  console.log('\n[7] a switch whose outgoing board cannot be saved is refused');
  const folder = path.join(SB.root, 'locked');
  const board = path.join(folder, 'outgoing.tldr');
  writeValidBoard(board);
  const target = SB.board('bd_target');
  const server = startServer(SB, board);
  const port = await server.port;
  const room = SB.room(board);
  fs.chmodSync(folder, 0o555); // no temp file can be written beside the board
  try {
    const sw = await postJson(port, '/board/open', { path: target });
    eq(sw.status, 503, `the switch is refused (503: ${sw.body?.error})`);
    const status = await json(port, '/canvas-status');
    eq(status.activeRoom, room, 'the server stays on the board it could not save');
    ok(fs.existsSync(SB.files(board).lock), 'which keeps its lock');
    ok(!fs.existsSync(SB.files(target).lock), 'and no lock is taken on the target');
    const said = (await json(port, `/messages?room=${room}`)).messages.some((m) => /cannot be saved/.test(m.text ?? ''));
    ok(said, 'the panel is told the board cannot be saved');
  } finally {
    fs.chmodSync(folder, 0o755);
    await stopServer(server);
  }
}

async function naming(port) {
  console.log('\n[8] naming');
  await postJson(port, '/agent-message', { text: 'hello from nobody' });
  const line = (await json(port, '/messages')).messages.find((m) => m.text === 'hello from nobody');
  eq(line?.author?.name, 'Agent', 'an agent message with no registered session is from "Agent"');
  const made = await postJson(port, '/board/new', { name: 'Sales Engine Design' });
  eq(made.status, 200, '/board/new answers 200');
  eq(made.body?.room, 'Sales-Engine-Design', 'with the slug rule\'s room');
  eq(made.body?.path, path.join(SB.home, 'Sales-Engine-Design.tldr'), 'in the boards folder');
}

const locate = (args) => spawnSync(process.execPath, [path.join(SERVER_DIR, 'boards.mjs'), ...args, '--home', SB.home, '--repo', SB.root], { encoding: 'utf8' });

async function boardsCli(port, boardPath) {
  console.log('\n[8b] boards.mjs');
  const live = locate(['--board', boardPath]);
  eq(live.status, 3, 'a live board exits 3');
  const where = JSON.parse(live.stdout);
  eq(where.room, SB.room(boardPath), 'its room is the file name');
  eq(where.lock, path.join(SB.home, `${where.room}.lock`), 'its lock is in WHITEBOARD_HOME');
  eq(where.port, path.join(SB.home, `${where.room}.port`), 'and so is its port record');
  eq(where.live?.port, port, 'live names the server\'s port');
  eq(locate(['--name', 'Never Opened']).status, 0, 'a board nothing serves exits 0');
  const refused = locate(['--board', path.join(path.dirname(SB.root), 'elsewhere.tldr')]);
  eq(refused.status, 2, 'a board outside the repository exits 2');
  ok(/outside the repository/.test(refused.stderr), 'saying why');
}

async function main() {
  const boardPath = SB.board('bd_main');
  const server = startServer(SB, boardPath);
  const port = await server.port;
  const room = SB.room(boardPath);
  await framing(port);
  await canvasSlot(server, port, room);
  await jsonOnly(port);
  await placement(port);
  await unloadable(port);
  await boardsCli(port, boardPath);
  await unsavedSwitch();
  await naming(port);
}

try {
  await main();
} catch (e) {
  failures.push(`threw: ${e.stack ?? e}`);
  console.log(`  ✗ threw: ${e.stack ?? e}`);
} finally {
  await stopAllServers();
}
console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

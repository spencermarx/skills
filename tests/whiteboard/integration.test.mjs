// Headless integration test for whiteboard v4 (SPEC §8.2 messages, §8.3 multi-board).
// Boots two bridge processes on ephemeral ports with the render-canvas skipped
// (WHITEBOARD_NO_CANVAS), then exercises the message store, idempotency, the
// GET /messages read model + since= filter, per-board isolation, and lockfile
// lifecycle over real HTTP. No Chromium, no browser. Exit 0 = all pass.
//
//   node server/integration.test.mjs      (run from the skill root)

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills', '_incubating', 'whiteboard');
const SERVER_DIR = path.join(SKILL_DIR, 'server');
const TSX = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');

// Mirror the server's repo-root walk to locate HOME = <root>/.scratchpad/whiteboard.
function repoRoot(start) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}
const HOME = path.join(repoRoot(SKILL_DIR), '.scratchpad', 'whiteboard');
fs.mkdirSync(HOME, { recursive: true });

const A = 'wbtest_a';
const B = 'wbtest_b';
const C = 'wbtest_c'; // [v5] durable-queue + re-drain (rebooted across three lives)
const D = 'wbtest_d'; // [v5] agentParked flip
const E = 'wbtest_e'; // [v5.1] lease/visibility-timeout: lead-only crash while the bridge lives
const F = 'wbtest_f'; // [v6] a Send addressed to a worker reaches that worker, not the lead
const G = 'wbtest_g'; // [v6] a worker stays reachable across turns (self-park + re-arm on its queue)
const H = 'wbtest_h'; // [v6] a Send to a dead worker is held + drained after the lead revives it
const I = 'wbtest_i'; // [v6] per-recipient lease/reclaim (a stalled worker lease re-queues on its queue)
const J = 'wbtest_j'; // [v6] an `everyone` broadcast reaches all registered recipients
const K = 'wbtest_k'; // [v7] typed AgentId: an unknown recipient id is rejected 400 at every seam
const L = 'wbtest_l'; // [v7] structural nudge: the revive directive's nudge is verbatim + instruction-invariant
const M = 'wbtest_m'; // [v8] one-server guard: a live board's lock is attached-to, never stolen by a switch
const N = 'wbtest_n'; // [v8] the second process that tries to open M — must attach, not split-brain
const O = 'wbtest_o'; // [v8] an unowned board the switcher opens in-process (attach:false control)
const P = 'wbtest_p'; // [v9.2] concurrent in-flight leases: a same-session re-poll gets the NEXT Send, not its own in-flight one
const Q = 'wbtest_q'; // [v9.2] never-stop-listening: a parked waiter spares its lease from the stall sweep; a waiterless holder still reclaims
const R = 'wbtest_r'; // [v9.3] lead liveness: a live lead is never stalled through the wake→re-arm gap; a confirmed-dead lead re-queues to a new sid
const boards = [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R];

// --- tiny assertion harness -------------------------------------------------
let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- boot a bridge, resolve its port from stdout ----------------------------
function boot(board, extraEnv = {}) {
  const boardPath = path.join(HOME, `${board}.tldr`);
  const child = spawn(TSX, ['index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: '0', WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: boardPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child._board = board;
  child._port = new Promise((resolve, reject) => {
    let buf = '';
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { if (/Error|error:/.test(d.toString())) buf += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  return child;
}

const j = (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init).then((r) => r.json());
const post = (port, p, body) =>
  j(port, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// [v7] Raw variants that expose the HTTP status (the JSON helpers above swallow it), so a
// seam-validation rejection can be asserted as a 400 rather than inferred from the body.
const postStatus = (port, p, body) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
const getStatus = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.status);

// [v5] Poll /next-instruction with a client-side deadline. A pending Send is served
// synchronously, so it returns fast; an empty queue makes the server long-poll, which
// we abort and read as "nothing pending" (null). 204 (server-side timeout) is also null.
async function nextOrNull(port, ms = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/next-instruction`, { signal: ac.signal });
    if (r.status === 204) return null;
    return await r.json();
  } catch { return null; } // aborted mid-long-poll → nothing was pending
  finally { clearTimeout(timer); }
}

// [v6] Poll a SPECIFIC recipient's queue (?for=<id>&sessionId=<sid>). Same null semantics
// as nextOrNull: a pending Send returns fast; an empty queue long-polls, which we abort → null.
async function nextForOrNull(port, forId, sid, ms = 2500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const q = new URLSearchParams();
  if (forId) q.set('for', forId);
  if (sid) q.set('sessionId', sid);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/next-instruction?${q}`, { signal: ac.signal });
    if (r.status === 204) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

// [v6] The lead's supervisor long-poll (?supervise=1). Returns its own lead Send, a revive
// directive {revive,name?}, or null (aborted long-poll / 204).
async function superviseOrNull(port, sid, ms = 2500) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/next-instruction?supervise=1&sessionId=${sid}`, { signal: ac.signal });
    if (r.status === 204) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function cleanupFiles() {
  for (const b of boards) for (const ext of ['tldr', 'messages.jsonl', 'lock', 'png']) {
    fs.rmSync(path.join(HOME, `${b}.${ext}`), { force: true });
  }
}

async function main() {
  cleanupFiles();
  const srvA = boot(A);
  const srvB = boot(B);
  const portA = await srvA._port;
  const portB = await srvB._port;

  console.log(`\n[ports] A=${portA} B=${portB}`);
  ok(Number.isInteger(portA) && portA > 0, 'server A bound an ephemeral port');
  ok(Number.isInteger(portB) && portB > 0, 'server B bound an ephemeral port');
  ok(portA !== portB, 'the two boards got distinct ports');

  // lockfiles written with the expected shape. Note: the lock records the server's
  // own process.pid (the inner node that tsx forks), which is exactly what the skill's
  // `kill -0 <lock.pid>` attach-vs-boot liveness check reads back — not the launcher pid.
  const isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const [b, port] of [[A, portA], [B, portB]]) {
    const lockPath = path.join(HOME, `${b}.lock`);
    ok(fs.existsSync(lockPath), `lockfile ${b}.lock written`);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    eq(lock.port, port, `${b}.lock port matches the bound port`);
    eq(lock.board, b, `${b}.lock board is the basename`);
    ok(Number.isInteger(lock.pid) && isAlive(lock.pid), `${b}.lock pid is a live process (the attach liveness key)`);
    ok(typeof lock.startedAt === 'number' || typeof lock.startedAt === 'string', `${b}.lock has startedAt`);
  }

  console.log('\n[messages] store + idempotency');
  const r1 = await post(portA, '/message', { text: 'hello A', selection: ['shape:x'], idempotencyKey: 'k1' });
  ok(r1.ok === true, 'POST /message accepted');
  eq(r1.id, 'k1', 'stored message id == idempotencyKey');

  let msgs = (await j(portA, `/messages?room=${A}`)).messages;
  eq(msgs.length, 1, 'GET /messages returns the one human message');
  eq(msgs[0].author.kind, 'human', 'human message attributed to a human author');
  eq(msgs[0].text, 'hello A', 'human message text round-trips');
  eq(msgs[0].id, 'k1', 'human message id is the key');
  const firstTs = msgs[0].ts;

  const dup = await post(portA, '/message', { text: 'hello A again', idempotencyKey: 'k1' });
  ok(dup.deduped === true, 'repeat idempotencyKey is deduped');
  msgs = (await j(portA, `/messages?room=${A}`)).messages;
  eq(msgs.length, 1, 'duplicate did not double-store');

  console.log('\n[messages] agent utterance attribution');
  const reg = await post(portA, '/session/register', { name: 'Claude', clientKey: 'ck1', transcriptPath: '/tmp/x.jsonl' });
  ok(typeof reg.sessionId === 'string' && reg.sessionId.length > 0, '/session/register returns a sessionId');
  await sleep(5); // ensure a distinct ts from the human message
  const am = await post(portA, '/agent-message', { text: 'drew a box', sessionId: reg.sessionId, idempotencyKey: 'k2' });
  ok(am.ok === true, 'POST /agent-message accepted');
  msgs = (await j(portA, `/messages?room=${A}`)).messages;
  eq(msgs.length, 2, 'agent message stored alongside the human one');
  const agent = msgs.find((m) => m.id === 'k2');
  ok(!!agent, 'agent message present by id');
  eq(agent.author.kind, 'agent', 'agent message attributed to an agent author');
  eq(agent.author.name, 'Claude', 'agent author name from the registered session');

  console.log('\n[messages] since= filter + reload persistence');
  const since = (await j(portA, `/messages?room=${A}&since=${firstTs}`)).messages;
  eq(since.length, 1, 'since= returns only messages after the cursor');
  eq(since[0].id, 'k2', 'since= returned the later (agent) message');

  const sidecar = path.join(HOME, `${A}.messages.jsonl`);
  ok(fs.existsSync(sidecar), 'JSONL sidecar written');
  const lines = fs.readFileSync(sidecar, 'utf8').trim().split('\n').filter(Boolean);
  eq(lines.length, 2, 'sidecar holds both messages (survives a reload)');

  console.log('\n[isolation] board B is independent');
  const bMsgs = (await j(portB, `/messages?room=${B}`)).messages;
  eq(bMsgs.length, 0, 'board B has no messages despite board A traffic');
  ok(!fs.existsSync(path.join(HOME, `${B}.messages.jsonl`)), 'no sidecar created for the untouched board B');

  // ---- [v5] durable queue: pending Sends survive a restart and drain in order ----
  console.log('\n[v5 durable] pending Sends survive a restart and drain oldest-first');
  const srvC1 = boot(C);
  const portC1 = await srvC1._port;
  await post(portC1, '/message', { text: 'first', idempotencyKey: 'c1' });
  await sleep(8); // guarantee c1.ts < c2.ts
  await post(portC1, '/message', { text: 'second', idempotencyKey: 'c2' });
  // no waiter is parked — both Sends sit durably in the message log as pending
  let cMsgs = (await j(portC1, `/messages?room=${C}`)).messages;
  eq(cMsgs.length, 2, 'both Sends stored while no agent was parked');
  ok(cMsgs.every((m) => m.completedAt == null), 'neither Send is completed yet');
  srvC1.kill('SIGTERM');
  await sleep(1300);
  ok(!fs.existsSync(path.join(HOME, `${C}.lock`)), 'board C lock removed on shutdown');

  const srvC2 = boot(C); // fresh process, same board file
  const portC2 = await srvC2._port;
  const d1 = await nextOrNull(portC2, 3000);
  ok(d1 && d1.id === 'c1', 'after restart the OLDEST pending Send drains first');
  const d2 = await nextOrNull(portC2, 3000);
  ok(d2 && d2.id === 'c2', 'the second pending Send drains next, in order');
  const d3 = await nextOrNull(portC2, 1500);
  eq(d3, null, 'nothing more pending once the backlog is drained');
  cMsgs = (await j(portC2, `/messages?room=${C}`)).messages;
  ok(cMsgs.find((m) => m.id === 'c1').deliveredAt != null, 'a drained Send is marked deliveredAt');
  ok(cMsgs.every((m) => m.completedAt == null), 'delivery is not completion — both still uncompleted');
  srvC2.kill('SIGTERM');
  await sleep(1300);

  // ---- [v5] re-drain: a delivered-but-not-completed Send is not lost to a crash ----
  console.log('\n[v5 re-drain] delivered-but-not-completed Sends re-drain, then complete-ack retires them');
  const srvC3 = boot(C);
  const portC3 = await srvC3._port;
  const rd1 = await nextOrNull(portC3, 3000);
  ok(rd1 && rd1.id === 'c1', 'a delivered-but-not-completed Send re-drains after a crash (nothing lost)');
  const ackC1 = await post(portC3, '/instruction-complete', { id: 'c1' });
  ok(ackC1.ok === true, 'POST /instruction-complete acks the turn');
  const ackC1Again = await post(portC3, '/instruction-complete', { id: 'c1' });
  ok(ackC1Again.alreadyComplete === true, 'repeat /instruction-complete is idempotent');
  cMsgs = (await j(portC3, `/messages?room=${C}`)).messages;
  ok(cMsgs.find((m) => m.id === 'c1').completedAt != null, 'a completed Send carries completedAt');
  const rd2 = await nextOrNull(portC3, 3000);
  ok(rd2 && rd2.id === 'c2', 'only the still-uncompleted Send remains pending');
  await post(portC3, '/instruction-complete', { id: 'c2' });
  const rd3 = await nextOrNull(portC3, 1500);
  eq(rd3, null, 'once every Send is completed, nothing re-drains');
  srvC3.kill('SIGTERM');
  await sleep(1300);

  // ---- [v5] agentParked flips with a waiting lead (the loud "nobody's home" signal) ----
  console.log('\n[v5 agentParked] the parked flag flips with a waiting lead');
  const srvD = boot(D);
  const portD = await srvD._port;
  eq((await j(portD, '/canvas-status')).agentParked, false, 'agentParked is false with no lead parked');
  const poll = fetch(`http://127.0.0.1:${portD}/next-instruction`)
    .then((r) => (r.status === 204 ? null : r.json())).catch(() => null);
  await sleep(250);
  eq((await j(portD, '/canvas-status')).agentParked, true, 'agentParked flips true once a lead long-polls');
  await post(portD, '/message', { text: 'wake', idempotencyKey: 'dwake' });
  const served = await poll;
  ok(served && served.id === 'dwake', 'the parked lead receives the Send directly');
  await sleep(250);
  eq((await j(portD, '/canvas-status')).agentParked, false, 'agentParked flips back to false after the waiter is served');
  srvD.kill('SIGTERM');
  await sleep(1300);

  // ---- [v9.3 #55] a lead-only crash re-queues the Send (never stalled), no bridge restart ----
  // Supersedes the v5.1 timed-lease version: #55 removed the lead's lease AND its 'stalled' state, so
  // recovery is now LIVENESS-driven, not clock-driven. The bridge never restarts, so only the lead
  // liveness reclaim recovers the Send. Short LEAD_GRACE_MS so the crash is confirmed in ~1s. (The
  // worker timed-lease reclaim → 'stalled' still lives, and is exercised by board I below.)
  console.log('\n[v9.3 lead-recovery] a lead-only crash re-queues the Send (never stalled) and a new lead drains it (no bridge restart)');
  const srvE = boot(E, { WHITEBOARD_STALL_MS: '400', WHITEBOARD_SWEEP_MS: '150', WHITEBOARD_LEAD_GRACE_MS: '500' });
  const portE = await srvE._port;
  const stateOf = async (id) => {
    const list = (await j(portE, `/messages?room=${E}`)).messages;
    return (list.find((x) => x.id === id) || {}).state;
  };
  await post(portE, '/message', { text: 'recover me', idempotencyKey: 'e1' });
  eq(await stateOf('e1'), 'queued', 'a stored Send with no lead is queued');
  const took = await j(portE, `/next-instruction?sessionId=sess-1`);
  ok(took && took.id === 'e1', 'lead sess-1 takes the Send');
  // [v9.4 #56] the delivered payload leads with a fixed, content-free re-arm reminder
  ok(Object.keys(took)[0] === 'reArmFirst', 'reArmFirst is the payload\'s first field (top of the wake body)');
  ok(typeof took.reArmFirst === 'string' && /RE-ARM FIRST/.test(took.reArmFirst), 'reArmFirst carries the RE-ARM FIRST directive');
  ok(/poll\.sh/.test(took.reArmFirst) && /background poller/.test(took.reArmFirst), 'the lead directive names poll.sh + the background poller (the lead re-arm)');
  ok(!took.reArmFirst.includes('recover me'), 'reArmFirst carries no Send text (no paraphrase can ride it)');
  eq(await stateOf('e1'), 'working', 'the received Send is working (receipt held by sess-1)');
  // sess-1 goes silent (crashed mid-draw) with no waiter parked; past LEAD_GRACE_MS it is confirmed dead.
  await sleep(1000);
  eq(await stateOf('e1'), 'queued', 'a confirmed-dead lead re-queues the Send (queued, never stalled)');
  // a DIFFERENT lead polls and is redelivered the re-queued Send — the bridge never restarted
  const redo = await j(portE, `/next-instruction?sessionId=sess-2`);
  ok(redo && redo.id === 'e1', 'a new lead is redelivered the re-queued Send (no bridge restart)');
  eq(await stateOf('e1'), 'working', 'the redelivered Send is working again');
  await post(portE, '/instruction-complete', { id: 'e1' });
  eq(await stateOf('e1'), 'done', 'completing retires it for good');
  const noMore = await nextOrNull(portE, 1500);
  eq(noMore, null, 'nothing pending once the recovered Send is completed');
  srvE.kill('SIGTERM');
  await sleep(1300);

  // ---- [v6] a Send addressed to a worker reaches THAT worker, not the lead ----
  console.log('\n[v6 addressing] a worker-addressed Send is served to the worker, not the lead');
  const srvF = boot(F);
  const portF = await srvF._port;
  // [v7 #43] the worker must be a registered (known) recipient before it can be addressed.
  await post(portF, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' });
  await post(portF, '/message', { text: 'for w2', idempotencyKey: 'f1',
    recipient: { kind: 'worker', id: 'worker-2', name: 'Claude-2' } });
  const leadGetsF = await nextForOrNull(portF, 'lead', 'lead-sid', 1500);
  eq(leadGetsF, null, 'a worker-addressed Send is NOT served to the lead queue');
  const w2GetsF = await nextForOrNull(portF, 'worker-2', 'w2-sid', 2500);
  ok(w2GetsF && w2GetsF.id === 'f1', 'the worker-addressed Send is served to worker-2');
  eq(w2GetsF && w2GetsF.for, 'worker-2', 'the instruction payload echoes for=worker-2');
  // [v9.4 #56] the re-arm reminder is recipient-classed: a worker is told to re-arm its long-poll,
  // NOT to relaunch poll.sh (the lead-scoped poller a worker never uses, SKILL §4).
  ok(w2GetsF && /RE-ARM FIRST/.test(w2GetsF.reArmFirst || ''), 'worker payload also carries a reArmFirst directive');
  ok(/next-instruction/.test(w2GetsF.reArmFirst) && !/poll\.sh/.test(w2GetsF.reArmFirst), 'the worker directive says re-arm the long-poll, not relaunch poll.sh');
  ok(!w2GetsF.reArmFirst.includes('for w2'), 'worker reArmFirst carries no Send text either (content-free, mirrors the lead assertion)');
  srvF.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] a worker stays reachable across turns (self-park + re-arm on its OWN queue) ----
  console.log('\n[v6 reachable] a worker stays addressable turn after turn on its own queue');
  const srvG = boot(G);
  const portG = await srvG._port;
  await post(portG, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' }); // [v7 #43] known recipient
  await post(portG, '/message', { text: 'turn 1', idempotencyKey: 'g1', recipient: { kind: 'worker', id: 'worker-1' } });
  const g1 = await nextForOrNull(portG, 'worker-1', 'w1', 2500);
  ok(g1 && g1.id === 'g1', 'worker-1 gets its first Send');
  await post(portG, '/instruction-complete', { id: 'g1', for: 'worker-1' });
  const gEmpty = await nextForOrNull(portG, 'worker-1', 'w1', 1200);
  eq(gEmpty, null, 'worker-1 re-arms with nothing pending (204 = re-arm, not exit)');
  await post(portG, '/message', { text: 'turn 2', idempotencyKey: 'g2', recipient: { kind: 'worker', id: 'worker-1' } });
  const g2 = await nextForOrNull(portG, 'worker-1', 'w1', 2500);
  ok(g2 && g2.id === 'g2', 'worker-1 stays reachable across turns for a later Send');
  srvG.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] a Send to a dead worker is held and drained after the lead revives it ----
  // Large grace so the storm-guard is deterministic: the 2nd supervise poll is inside the window.
  console.log('\n[v6 revival] a Send to a dead worker surfaces a revive directive + is drained on revival');
  const srvH = boot(H, { WHITEBOARD_REVIVE_GRACE_MS: '5000' });
  const portH = await srvH._port;
  // [v7 #43] register worker-3 so it is a known recipient; it never long-polls, so it still reads
  // as needing revive (candidateWorkerIds keys on a pending Send, revive skips only a live waiter).
  await post(portH, '/session/register', { name: 'Claude-3', clientKey: 'worker-3' });
  await post(portH, '/message', { text: 'wake w3', idempotencyKey: 'h1',
    recipient: { kind: 'worker', id: 'worker-3', name: 'Claude-3' } });
  const sup = await superviseOrNull(portH, 'lead-sid', 2500);
  ok(sup && sup.revive === 'worker-3', 'the supervisor long-poll returns a revive directive for the dead worker');
  const supAgain = await superviseOrNull(portH, 'lead-sid', 800);
  ok(!(supAgain && supAgain.revive === 'worker-3'), 'the revive is not re-issued within the grace window (no storm)');
  const h1 = await nextForOrNull(portH, 'worker-3', 'w3', 2500);
  ok(h1 && h1.id === 'h1', 'the revived worker drains the Send that waited for it (nothing lost)');
  await post(portH, '/instruction-complete', { id: 'h1', for: 'worker-3' });
  const hDone = ((await j(portH, `/messages?room=${H}`)).messages.find((x) => x.id === 'h1') || {}).state;
  eq(hDone, 'done', 'the revived-and-completed Send is done');
  srvH.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] per-recipient lease/reclaim: a stalled worker lease re-queues on THAT worker's queue ----
  console.log('\n[v6 lease] a worker-only crash reclaims its Send on its own queue, not the lead\'s');
  const srvI = boot(I, { WHITEBOARD_STALL_MS: '400', WHITEBOARD_SWEEP_MS: '150' });
  const portI = await srvI._port;
  const stateOfI = async (id) => ((await j(portI, `/messages?room=${I}`)).messages.find((x) => x.id === id) || {}).state;
  await post(portI, '/session/register', { name: 'Claude-4', clientKey: 'worker-4' }); // [v7 #43] known recipient
  await post(portI, '/message', { text: 'lease w4', idempotencyKey: 'i1', recipient: { kind: 'worker', id: 'worker-4' } });
  const tookI = await nextForOrNull(portI, 'worker-4', 'w4-a', 2500);
  ok(tookI && tookI.id === 'i1', 'worker-4 session A takes the Send');
  eq(await stateOfI('i1'), 'working', 'the leased worker Send is working');
  await sleep(900); // A goes silent; its lease expires and the sweep reclaims it
  eq(await stateOfI('i1'), 'stalled', 'the expired worker lease reclaims the Send to stalled');
  const leadSteals = await nextForOrNull(portI, 'lead', 'lead-sid', 1200);
  eq(leadSteals, null, 'the reclaimed worker Send does not leak onto the lead queue');
  const redoI = await nextForOrNull(portI, 'worker-4', 'w4-b', 2500);
  ok(redoI && redoI.id === 'i1', 'a new worker-4 session is redelivered the reclaimed Send on its own queue');
  eq(await stateOfI('i1'), 'working', 'the redelivered worker Send is working again');
  await post(portI, '/instruction-complete', { id: 'i1', for: 'worker-4' });
  eq(await stateOfI('i1'), 'done', 'completing retires the worker Send');
  srvI.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] an `everyone` broadcast reaches all registered recipients ----
  console.log('\n[v6 broadcast] `everyone` fans one Send to every registered worker, done only when all complete');
  const srvJ = boot(J);
  const portJ = await srvJ._port;
  await post(portJ, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' });
  await post(portJ, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' });
  await post(portJ, '/message', { text: 'everyone!', idempotencyKey: 'j1', recipient: { kind: 'broadcast' } });
  const jw1 = await nextForOrNull(portJ, 'worker-1', 'w1', 2500);
  const jw2 = await nextForOrNull(portJ, 'worker-2', 'w2', 2500);
  ok(jw1 && jw1.id === 'j1', 'the broadcast reaches worker-1');
  ok(jw2 && jw2.id === 'j1', 'the broadcast reaches worker-2 (same message id, both queues)');
  const jLead = await nextForOrNull(portJ, 'lead', 'lead-sid', 1200);
  eq(jLead, null, 'the broadcast does not go to the lead');
  await post(portJ, '/instruction-complete', { id: 'j1', for: 'worker-1' });
  const jPartial = ((await j(portJ, `/messages?room=${J}`)).messages.find((x) => x.id === 'j1') || {}).state;
  ok(jPartial !== 'done', 'the broadcast is not done while worker-2 has not completed');
  await post(portJ, '/instruction-complete', { id: 'j1', for: 'worker-2' });
  const jDone = ((await j(portJ, `/messages?room=${J}`)).messages.find((x) => x.id === 'j1') || {}).state;
  eq(jDone, 'done', 'the broadcast reads done only once every recipient completes');
  srvJ.kill('SIGTERM'); await sleep(1300);

  // ---- [v7 #43] typed AgentId: an unknown recipient id is rejected 400 at every seam ----
  console.log('\n[v7 typed-AgentId] an unknown recipient id is rejected 400 at every seam');
  const srvK = boot(K);
  const portK = await srvK._port;
  await post(portK, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' }); // a known worker
  // negatives — an unknown id is 400 at each of the three seams
  eq(await postStatus(portK, '/message', { text: 'x', idempotencyKey: 'k-ghost', recipient: { kind: 'worker', id: 'ghost' } }),
     400, 'POST /message with an unknown worker recipient is 400');
  eq(await getStatus(portK, '/next-instruction?for=ghost&sessionId=ks'),
     400, 'GET /next-instruction?for=<unknown> is 400');
  eq(await getStatus(portK, '/next-instruction?for=everyone&sessionId=ks'),
     400, 'GET /next-instruction?for=everyone is 400 (nobody drains "everyone")');
  eq(await postStatus(portK, '/instruction-complete', { id: 'whatever', for: 'ghost' }),
     400, 'POST /instruction-complete with an unknown for is 400 (before the message 404)');
  // positives — lead, a registered worker, and a broadcast are all accepted
  const kLead = await post(portK, '/message', { text: 'to lead', idempotencyKey: 'k-lead' });
  ok(kLead.ok === true, 'POST /message to the lead (no recipient) is accepted');
  const kW1 = await post(portK, '/message', { text: 'to w1', idempotencyKey: 'k-w1', recipient: { kind: 'worker', id: 'worker-1' } });
  ok(kW1.ok === true, 'POST /message to a registered worker is accepted');
  const kBcast = await post(portK, '/message', { text: 'to all', idempotencyKey: 'k-all', recipient: { kind: 'broadcast' } });
  ok(kBcast.ok === true, 'POST /message broadcast (everyone) is accepted');
  // retained across death — a registered-THEN-unregistered worker id stays a valid recipient
  const kReg2 = await post(portK, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' });
  await post(portK, '/session/unregister', { sessionId: kReg2.sessionId });
  eq(await postStatus(portK, '/message', { text: 'held for dead w2', idempotencyKey: 'k-w2', recipient: { kind: 'worker', id: 'worker-2' } }),
     200, 'POST /message to a registered-then-dead worker is still accepted (id retained across death)');
  srvK.kill('SIGTERM'); await sleep(1300);

  // ---- [v7 #45] the revive directive's nudge is verbatim + invariant to the pending instruction ----
  console.log('\n[v7 verbatim-nudge] the revive nudge is fixed bootstrap text, never the instruction');
  const srvL = boot(L, { WHITEBOARD_REVIVE_GRACE_MS: '100' });
  const portL = await srvL._port;
  await post(portL, '/session/register', { name: 'Claude-3', clientKey: 'worker-3' });
  // first revival — a Send whose text must NOT appear in the nudge
  await post(portL, '/message', { text: 'ALPHA-SECRET-INSTRUCTION', idempotencyKey: 'l1', recipient: { kind: 'worker', id: 'worker-3' } });
  const lDir1 = await superviseOrNull(portL, 'lead-sid', 2500);
  ok(lDir1 && lDir1.revive === 'worker-3' && typeof lDir1.nudge === 'string' && lDir1.nudge.length > 0,
     'the revive directive carries a non-empty nudge string');
  // drain + complete l1 so worker-3's queue is empty, then let the grace window lapse
  const lDrain = await nextForOrNull(portL, 'worker-3', 'w3', 2500);
  ok(lDrain && lDrain.id === 'l1', 'worker-3 drains its first Send');
  await post(portL, '/instruction-complete', { id: 'l1', for: 'worker-3' });
  await sleep(250); // > REVIVE_GRACE_MS (100) so the next revive is not storm-suppressed
  // second revival — a DIFFERENT instruction; the nudge must be byte-identical
  await post(portL, '/message', { text: 'BRAVO-DIFFERENT-PAYLOAD', idempotencyKey: 'l2', recipient: { kind: 'worker', id: 'worker-3' } });
  const lDir2 = await superviseOrNull(portL, 'lead-sid', 2500);
  ok(lDir2 && lDir2.revive === 'worker-3' && typeof lDir2.nudge === 'string',
     'the second revive directive also carries a nudge');
  eq(lDir1.nudge, lDir2.nudge, 'the nudge is byte-identical across revivals with different pending instructions');
  ok(!lDir1.nudge.includes('ALPHA-SECRET-INSTRUCTION') && !lDir2.nudge.includes('BRAVO-DIFFERENT-PAYLOAD'),
     'the nudge contains neither instruction text (no paraphrase can ride it)');
  ok(lDir1.nudge.includes('worker-3'), 'the nudge names the recipient AgentId');
  ok(lDir1.nudge.includes(`127.0.0.1:${portL}`), 'the nudge carries the bridge base URL');
  srvL.kill('SIGTERM'); await sleep(1300);

  // ---- [v8 §8.3] runtime one-server guard: /board/open attaches, never steals a live lock ----
  // The split-brain bug: /board/open did an in-process room switch that overwrote the target
  // board's lock with NO owner check, so two processes served one board and a parked waiter on
  // one never met a Send on the other. Two processes here — srvM owns board M, srvN owns board N —
  // and srvN is told to open M. The guard must refuse the steal and hand back M's live port.
  console.log('\n[v8 one-server-guard] /board/open attaches to a live board instead of stealing its lock');
  const srvM = boot(M);
  const srvN = boot(N);
  const portM = await srvM._port;
  const portN = await srvN._port;
  await sleep(300); // the port prints just before writeLock() runs in the listen callback — let both locks flush
  const mLockPath = path.join(HOME, `${M}.lock`);
  eq(JSON.parse(fs.readFileSync(mLockPath, 'utf8')).port, portM, 'M.lock initially points at M\'s own server');

  // srvN opens M (already live on srvM). Attach, do NOT switch in-process.
  const openLive = await post(portN, '/board/open', { path: path.join(HOME, `${M}.tldr`) });
  eq(openLive.attach, true, '/board/open reports attach:true when the target board is already live');
  eq(openLive.port, portM, '/board/open hands back the live owner\'s port to attach to');
  eq(JSON.parse(fs.readFileSync(mLockPath, 'utf8')).port, portM, 'M.lock still points at M\'s server (not stolen by N) — the split-brain is prevented');
  eq((await j(portN, '/canvas-status')).activeRoom, N, 'srvN stayed on its own board N (no in-process steal)');

  // Control: opening an UNOWNED board switches in-process (attach:false, the common single-server case).
  const openUnowned = await post(portN, '/board/open', { path: path.join(HOME, `${O}.tldr`) });
  eq(openUnowned.attach, false, '/board/open switches in-process (attach:false) for an unowned board');
  eq((await j(portN, '/canvas-status')).activeRoom, O, 'srvN switched to the unowned board O in-process');

  // Stale-lock reclaim: kill M's actual server (its lock.pid — the inner node tsx forks, NOT the
  // launcher srvM) with SIGKILL. SIGKILL is uncatchable, so no graceful removeLock runs: M.lock
  // stays on disk pointing at a now-dead process. Opening M must reclaim it in-process
  // (attach:false), distinguishing a stale lock from a live owner (the guard confirms liveness via
  // the /canvas-status probe, which a dead server fails, so a lingering zombie pid can't fool it).
  const mLock = JSON.parse(fs.readFileSync(mLockPath, 'utf8'));
  try { process.kill(mLock.pid, 'SIGKILL'); } catch { /* already gone */ }
  try { srvM.kill('SIGKILL'); } catch { /* drop the orphaned tsx launcher too */ }
  await sleep(800);
  ok(fs.existsSync(mLockPath), 'the killed server left a stale M.lock behind (no graceful cleanup)');
  const openStale = await post(portN, '/board/open', { path: path.join(HOME, `${M}.tldr`) });
  eq(openStale.attach, false, '/board/open reclaims a stale-locked (dead-pid) board in-process, not attach');
  eq((await j(portN, '/canvas-status')).activeRoom, M, 'srvN took over M after its owner died (stale lock reclaimed)');
  srvN.kill('SIGTERM'); await sleep(1300);

  // ---- [v9.2] concurrent in-flight leases: a same-session re-poll is served the NEXT Send ----
  // The immediate-relaunch case (#48/v9.2): the lead relaunches its poller mid-act while its own
  // Send is still leased. Per-message leases (the inFlightByRecipient Set) let 'lead' hold m1 and m2
  // at once; nextPendingFor skips the leased m1, so the re-poll gets m2 — the Send that arrived
  // mid-act is heard, not the in-flight one re-served. Default STALL_MS so the sweep never fires here.
  console.log('\n[v9.2 concurrent-leases] a same-session re-poll is served the NEXT Send while its first is still leased');
  const srvP = boot(P);
  const portP = await srvP._port;
  const stateOfP = async (id) => ((await j(portP, `/messages?room=${P}`)).messages.find((x) => x.id === id) || {}).state;
  await post(portP, '/message', { text: 'm1', idempotencyKey: 'p1' });
  await sleep(8); // guarantee p1.ts < p2.ts so ordering is deterministic
  await post(portP, '/message', { text: 'm2', idempotencyKey: 'p2' });
  const pTook1 = await nextForOrNull(portP, 'lead', 'lead-A', 2500);
  ok(pTook1 && pTook1.id === 'p1', 'the first lead poll takes m1');
  eq(await stateOfP('p1'), 'working', 'm1 is working (leased) after the first poll');
  // [v9.7 §8.5 #60] The poller acks receipt of m1 before it re-arms (poll.sh POSTs
  // /instruction-received on a 200, before exit) — so the re-poll is a normal relaunch, not a
  // possibly-lost delivery, and m1 (received, being handled) is NOT re-served on the re-poll.
  await post(portP, '/instruction-received', { id: 'p1', for: 'lead' });
  // WITHOUT completing m1, the SAME sessionId polls again (the relaunched poller): it must get m2.
  const pTook2 = await nextForOrNull(portP, 'lead', 'lead-A', 2500);
  ok(pTook2 && pTook2.id === 'p2', 'the same-session re-poll is served m2 (the next Send), not its own in-flight m1');
  eq(await stateOfP('p1'), 'working', 'm1 stays working (still leased) — it was not re-served');
  eq(await stateOfP('p2'), 'working', 'm2 is working too — both Sends are leased concurrently (per-message leases)');
  srvP.kill('SIGTERM'); await sleep(1300);

  // ---- [v9.3 #55] a parked waiter spares the lead receipt; a confirmed-dead holder still reclaims ----
  // The v9.2 "never-stop-listening" board, re-cut to the v9.3 lead model: the lead has no timed lease
  // and no 'stalled' state, so redelivery is liveness/grace-driven, not clock-driven. Two legs, one
  // board, under a short LEAD_GRACE_MS so the reclaim bites in ~1s.
  //  (2) A deliberate pause: a receipt is held by lead-P AND lead-P has a real waiter parked open. The
  //      lead reclaim must SPARE it (an armed listener proves the holder alive) — it stays 'working',
  //      never anything else, and agentParked stays true. No clock reclaims a live lead.
  //  (3) A confirmed-dead holder: a receipt held by a session with NO waiter, silent past
  //      LEAD_GRACE_MS, re-queues to 'queued' (never 'stalled') — the spare is liveness-scoped, it does
  //      not over-spare. (The lead never reaches 'stalled'; the worker 'stalled' path is board I.)
  console.log('\n[v9.3 never-stop] a parked waiter spares the lead receipt; a confirmed-dead waiterless holder re-queues (never stalled)');
  const srvQ = boot(Q, { WHITEBOARD_STALL_MS: '400', WHITEBOARD_SWEEP_MS: '150', WHITEBOARD_LEAD_GRACE_MS: '500' });
  const portQ = await srvQ._port;
  const stateOfQ = async (id) => ((await j(portQ, `/messages?room=${Q}`)).messages.find((x) => x.id === id) || {}).state;

  // leg (2): hold receipt q1 for session lead-P, then park a REAL supervise waiter for lead on the same session.
  await post(portQ, '/message', { text: 'pause me', idempotencyKey: 'q1' });
  const qTook = await nextForOrNull(portQ, 'lead', 'lead-P', 2500);
  ok(qTook && qTook.id === 'q1', 'lead session lead-P takes q1');
  eq(await stateOfQ('q1'), 'working', 'q1 is working (receipt held by lead-P)');
  // [v9.7 §8.5 #60] The lead acks receipt of q1 (poll.sh POSTs /instruction-received before it
  // re-arms), so the armed listener it parks next is a normal relaunch, not evidence of a lost
  // delivery — q1 (received, being handled) is spared, never reclaimed and re-served to that waiter.
  await post(portQ, '/instruction-received', { id: 'q1', for: 'lead' });
  // A genuinely parked waiter: a long-poll fetch for lead we do NOT abort (q1 is leased, so
  // nextPendingFor skips it and this parks). We hold it open across the whole pause.
  const parkAC = new AbortController();
  let parkResolved = false;
  const parkPromise = fetch(`http://127.0.0.1:${portQ}/next-instruction?supervise=1&sessionId=lead-P`, { signal: parkAC.signal })
    .then((r) => { parkResolved = true; return r.status === 204 ? null : r.json(); })
    .catch(() => null);
  await sleep(250); // let the waiter park
  eq((await j(portQ, '/canvas-status')).agentParked, true, 'agentParked is true while lead-P is parked');
  // let more than LEAD_GRACE_MS (500ms) elapse with NO further calls carrying lead-P — only sessionless reads.
  await sleep(900);
  eq(await stateOfQ('q1'), 'working', 'q1 is STILL working — an armed listener spares the receipt from the lead reclaim (never stalled, never re-queued)');
  ok(!parkResolved, 'the parked waiter is still parked (the receipt was never reclaimed + redelivered to it)');
  eq((await j(portQ, '/canvas-status')).agentParked, true, 'agentParked stays true — the session is proven alive and listening');
  eq((await j(portQ, '/canvas-status')).leadAlive, true, 'leadAlive stays true — an armed listener proves the lead alive');
  parkAC.abort(); await parkPromise; await sleep(50);

  // leg (3): a receipt held by a session with NO waiter, silent past LEAD_GRACE_MS, must be reclaimed.
  await post(portQ, '/instruction-complete', { id: 'q1', for: 'lead' }); // retire q1 so it can't interfere
  await post(portQ, '/message', { text: 'no waiter', idempotencyKey: 'q2' });
  const qTook2 = await j(portQ, `/next-instruction?sessionId=lead-DEAD`); // takes q2, then goes silent (no waiter parked)
  ok(qTook2 && qTook2.id === 'q2', 'lead session lead-DEAD takes q2');
  eq(await stateOfQ('q2'), 'working', 'q2 is working (receipt held by lead-DEAD)');
  await sleep(900); // lead-DEAD is silent, no waiter — past the grace window it is confirmed dead
  eq(await stateOfQ('q2'), 'queued', 'a waiterless holder confirmed dead past the grace re-queues to queued (never stalled; the spare does not over-spare)');
  srvQ.kill('SIGTERM'); await sleep(1300);

  // ---- [v9.3 #55] LEAD LIVENESS: a live lead is never stalled; a confirmed-dead lead re-queues ----
  // The P6 regression, promoted from repro-p6.mjs. The real single-poller protocol: ONE supervise
  // poller parks, a Send is delivered (200), and the poller EXITS (poll.sh 74-78), so NO waiter is
  // parked during the agent's processing window. Under v9.2 the stall sweep reclaimed the un-acked
  // lease after STALL_MS → false `stalled` + a redelivery busy-loop (the board-Q unit test passed
  // only because it kept a SECOND waiter parked across the pause — a state the real single-poller
  // never has mid-turn). Under v9.3 the lead is NOT swept on a clock: liveness = an armed listener
  // OR the lead sid seen within a grace window; the receipt marker (not a timed lease) keeps the
  // Send `working` while alive and blocks re-serving it to the same session; only a confirmed-dead
  // lead (grace elapsed, no listener, no touch) re-queues, and it re-queues — it is never `stalled`.
  //   leg (1) holder alive < grace: a delivered Send stays `working`, never `stalled`, a late re-arm
  //           on the same sid is NOT re-served it (no busy-loop), and leadAlive stays true.
  //   leg (2) holder dead > grace: the un-handled Send re-queues (never `stalled`) and drains to a
  //           NEW sid (crash recovery intact — caution (ii): board I above proves the worker sweep
  //           is untouched by the lead carve-out).
  // Env: short STALL_MS/SWEEP_MS so v9.2's sweep WOULD bite (proof-of-bite — this board FAILS on
  // v9.2 HEAD); LEAD_GRACE_MS set BETWEEN the two waits so one board arbitrates alive vs dead by
  // elapsed time (v9.2 ignores the unknown var, so the same file runs against both revisions).
  console.log('\n[v9.3 lead-liveness] a live lead is never stalled through the wake→re-arm gap; a confirmed-dead lead re-queues to a new sid');
  const srvR = boot(R, { WHITEBOARD_STALL_MS: '400', WHITEBOARD_SWEEP_MS: '150', WHITEBOARD_LEAD_GRACE_MS: '1500' });
  const portR = await srvR._port;
  const stateOfR = async (id) => ((await j(portR, `/messages?room=${R}`)).messages.find((x) => x.id === id) || {}).state;
  const leadAliveR = async () => (await j(portR, '/canvas-status')).leadAlive;

  // A supervise poller that resolves (and would EXIT, like poll.sh) on a 200. It does NOT re-arm on
  // its own — the caller decides — faithfully modeling the single-poller wake→re-arm gap.
  function parkR(sid) {
    const ac = new AbortController();
    let resolved = false;
    const got = fetch(`http://127.0.0.1:${portR}/next-instruction?supervise=1&sessionId=${sid}`, { signal: ac.signal })
      .then((r) => { resolved = true; return r.status === 204 ? null : r.json(); })
      .catch(() => null);
    return { got, abort: () => ac.abort(), isResolved: () => resolved };
  }

  // leg (1): a single poller takes a Send and EXITS; no waiter is parked during the silent window.
  const pollerR = parkR('lead-R');
  await sleep(200); // let it park
  eq((await j(portR, '/canvas-status')).agentParked, true, 'lead-R is parked before delivery');
  await post(portR, '/message', { text: 'draw the arch', idempotencyKey: 'r1' });
  const deliveredR = await pollerR.got; // the parked poller got the 200 and would EXIT now (poll.sh)
  ok(deliveredR && deliveredR.id === 'r1', 'the single supervise poller is delivered r1 and exits (the wake)');
  // [v9.7 §8.5 #60] poll.sh acks receipt of r1 on the 200, before it exits — confirming the delivery
  // reached the consumer. This is what distinguishes lead-R's later re-arm (a normal relaunch) from a
  // lost delivery, so r1 is NOT re-served on the re-arm below (the busy-loop stays gone).
  await post(portR, '/instruction-received', { id: 'r1', for: 'lead' });
  eq(await stateOfR('r1'), 'working', 'r1 is working right after delivery (receipt held by lead-R)');
  eq((await j(portR, '/canvas-status')).agentParked, false, 'no waiter is parked during the processing window (the wake consumed it)');
  // The agent "narrates" longer than STALL_MS (400) but less than LEAD_GRACE_MS (1500), making NO
  // bridge call carrying lead-R and re-arming NO waiter — the exact P6 silent window.
  await sleep(900);
  eq(await stateOfR('r1'), 'working', 'r1 is STILL working after the silent window — a live lead is never stalled (P6 regression)');
  eq(await leadAliveR(), true, 'leadAlive is true within the grace window (honest UX: no false "stepped away")');
  // The lead finally re-arms (same sid). It must NOT be re-served r1 (still held, un-handled) — the
  // v9.2 busy-loop is gone. superviseOrNull long-polls then aborts → null (parked, nothing served).
  const rReArm = await superviseOrNull(portR, 'lead-R', 1200);
  eq(rReArm, null, 'a late re-arm on the same sid is NOT re-served r1 (idempotent receipt, no busy-loop)');
  eq(await stateOfR('r1'), 'working', 'r1 stays working across the re-arm — it was never reclaimed');
  await post(portR, '/instruction-complete', { id: 'r1', for: 'lead' });
  eq(await stateOfR('r1'), 'done', 'completing (handled) retires r1 for good');

  // leg (2): a holder takes a Send and CRASHES (no re-arm, no further calls). Past the grace window
  // with no armed listener and no touch, the lead is confirmed dead: its un-handled Send re-queues
  // (never `stalled`) and a NEW lead session drains it — crash recovery to a fresh sid.
  await post(portR, '/message', { text: 'crash me', idempotencyKey: 'r2' });
  const deadPoller = parkR('lead-DEAD-R');
  const deliveredR2 = await deadPoller.got; // takes r2 and would exit; the session is then DEAD
  ok(deliveredR2 && deliveredR2.id === 'r2', 'lead-DEAD-R takes r2, then crashes (no re-arm, no bridge calls)');
  eq(await stateOfR('r2'), 'working', 'r2 is working (received, being handled) right after delivery');
  await sleep(2200); // > LEAD_GRACE_MS (1500): no listener, no touch → the lead is confirmed dead
  eq(await leadAliveR(), false, 'leadAlive is false once the grace window elapses with no listener (confirmed dead)');
  eq(await stateOfR('r2'), 'queued', 'a confirmed-dead lead re-queues its un-handled Send (queued, never stalled)');
  const newLead = await superviseOrNull(portR, 'lead-NEW-R', 2500);
  ok(newLead && newLead.id === 'r2', 'a new lead session is redelivered the re-queued Send (crash recovery to a fresh sid)');
  eq(await stateOfR('r2'), 'working', 'the redelivered Send is working again under the new lead');
  await post(portR, '/instruction-complete', { id: 'r2', for: 'lead' });
  eq(await stateOfR('r2'), 'done', 'completing retires the recovered Send');
  deadPoller.abort(); pollerR.abort();
  srvR.kill('SIGTERM'); await sleep(1300);

  console.log('\n[teardown] lockfiles removed on shutdown');
  srvA.kill('SIGTERM');
  srvB.kill('SIGTERM');
  await sleep(1200);
  ok(!fs.existsSync(path.join(HOME, `${A}.lock`)), 'board A lockfile removed on SIGTERM');
  ok(!fs.existsSync(path.join(HOME, `${B}.lock`)), 'board B lockfile removed on SIGTERM');

  // hard-stop any stragglers, then clean scratch
  for (const s of [srvA, srvB]) { try { s.kill('SIGKILL'); } catch {} }
  await sleep(200);
  cleanupFiles();

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('\nERROR', e); process.exit(1); });

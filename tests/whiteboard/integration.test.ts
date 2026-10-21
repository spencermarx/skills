// Headless integration test for whiteboard v4 (SPEC §8.2 messages, §8.3 multi-board).
// Boots two bridge processes on ephemeral ports with the render-canvas skipped
// (WHITEBOARD_NO_CANVAS), then exercises the message store, idempotency, the
// GET /messages read model + since= filter, per-board isolation, and lockfile
// lifecycle over real HTTP. No Chromium, no browser. Exit 0 = all pass.
//
//   node --import tsx integration.test.ts      (run from server/)

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(SKILL_DIR, 'server');
// Boot the server the way the skill does (node with the tsx loader in-process, no tsx CLI
// wrapper), so the spawned child IS the server and killing it never orphans a board.
const BOOT_ARGS = ['--import', 'tsx', 'index.ts'];

// Mirror the server's repo-root walk to locate HOME = <root>/.scratchpad/whiteboard.
function repoRoot(start: string): string {
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
const D = 'wbtest_d'; // [v9.11 #64] the lead's roster row follows its items, not a listener
const E = 'wbtest_e'; // [v9.11 #64] the lead does not long-poll: /next-instruction is workers-only
const F = 'wbtest_f'; // [v6] a Send addressed to a worker reaches that worker, not the lead
const G = 'wbtest_g'; // [v6] a worker stays reachable across turns (self-park + re-arm on its queue)
const H = 'wbtest_h'; // [v6] a Send to a dead worker is held + drained after the lead revives it
const I = 'wbtest_i'; // [v6] per-recipient lease/reclaim (a stalled worker lease re-queues on its queue)
const J = 'wbtest_j'; // [v6] an `everyone` broadcast reaches all registered recipients
const K = 'wbtest_k'; // [v7] typed AgentId: an unknown recipient id is rejected 400 at every seam
const L = 'wbtest_l'; // [v7] structural nudge: the revive directive's nudge is verbatim + instruction-invariant
const M = 'wbtest_m'; // [v8] one-server guard: a live board's lock is attached-to, never stolen by a switch
const N = 'wbtest_n'; // [v8] the second process that tries to open M — must attach, not split-brain
const RQ = 'wbtest_rq'; // [#64] dry-run defects: no revive for a busy worker, stable cursor color on revival
const O = 'wbtest_o'; // [v8] an unowned board the switcher opens in-process (attach:false control)
const GU = 'wbtest_guest'; // [#64] a guest session is present but never a recipient, revived, or waited on
const SID = 'wbtest_sid'; // [#66] a worker's fetch and any completion carry the recipient's registered sessionId
const SID2 = 'wbtest_sid2'; // [#66] a sibling board: its recipients are its own
const boards = [A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, RQ, GU, SID, SID2];

// --- tiny assertion harness -------------------------------------------------
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- boot a bridge, resolve its port from stdout ----------------------------
type Server = ChildProcessByStdio<null, Readable, Readable> & { _board: string; _port: Promise<number> };
function boot(board: string, extraEnv: Record<string, string> = {}): Server {
  const boardPath = path.join(HOME, `${board}.tldr`);
  const child = spawn(process.execPath, BOOT_ARGS, {
    cwd: SERVER_DIR,
    env: { ...process.env, CLAUDE_CODE_MESSAGING_SOCKET: undefined, CLAUDE_CODE_MESSAGING_TOKEN: undefined,
    CLAUDE_CODE_SESSION_ID: undefined, CLAUDE_PID: undefined, CLAUDE_JOB_DIR: undefined, WHITEBOARD_NO_CANVAS: '1', WHITEBOARD_BOARD: boardPath, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = new Promise<number>((resolve, reject) => {
    let buf = '';
    const onData = (d: Buffer): void => {
      buf += d.toString();
      const m = buf.match(/WHITEBOARD_PORT=(\d+)/);
      if (m) { child.stdout.off('data', onData); resolve(Number(m[1])); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d: Buffer) => { if (/Error|error:/.test(d.toString())) buf += d.toString(); });
    child.on('exit', (code) => reject(new Error(`server ${board} exited early (code ${code})\n${buf}`)));
    setTimeout(() => reject(new Error(`server ${board} never printed a port\n${buf}`)), 20000);
  });
  return Object.assign(child, { _board: board, _port: port });
}

// The shapes this file reads. Each names only the fields a check looks at; a field the server may
// leave out is optional.
interface Lock { port: number; board: string; pid: number; startedAt: number | string }
interface OkReply { ok?: boolean }
interface MessageReply { ok?: boolean; id?: string; deduped?: boolean }
interface CompleteReply { ok?: boolean; alreadyComplete?: boolean }
interface Registered { sessionId: string }
interface StoredMessage {
  id: string; ts: number; text: string; author: { kind: string; name?: string };
  state?: string; receivedAt?: number | null; completedAt?: number | null;
  deliveredAt?: number | null; deliveredBy?: string | null;
  broadcastTo?: string[]; delivery?: Record<string, { completedAt?: number | null }>;
}
interface MessagesReply { messages: StoredMessage[] }
interface PendingItem { kind: string; id?: string; revive?: string; nudge?: string }
interface PendingReply { items: PendingItem[] }
interface Instruction { id: string; for?: string; refetch?: boolean }
interface AgentRow { id: string; lifecycle?: string; parked?: boolean; color?: string; guest?: boolean }
interface CanvasStatus { agents: AgentRow[]; doorbell?: unknown; activeRoom?: string }
interface BoardRow { name: string; room?: string }
interface BoardOpenReply { attach?: boolean; port?: number }
interface RegisterReply { sessionId?: string; error?: string }
interface Refusal { error: string }
interface Full<T> { status: number; body: T }

const j = <T>(port: number, p: string, init?: RequestInit): Promise<T> => fetch(`http://127.0.0.1:${port}${p}`, init).then((r) => r.json() as Promise<T>);
const post = <T = OkReply>(port: number, p: string, body: unknown): Promise<T> =>
  j<T>(port, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// [v7] Raw variants that expose the HTTP status (the JSON helpers above swallow it), so a
// seam-validation rejection can be asserted as a 400 rather than inferred from the body.
const postStatus = (port: number, p: string, body: unknown): Promise<number> =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);
const getStatus = (port: number, p: string): Promise<number> => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.status);

// [v9.11 #64] The lead's pull: register the lead (idempotent on clientKey 'lead') and GET /pending.
// Returns the items array; it answers at once, it never parks.
async function leadPull(port: number): Promise<PendingItem[]> {
  const { sessionId } = await post<Registered>(port, '/session/register', { name: 'Claude', clientKey: 'lead' });
  return (await j<PendingReply>(port, `/pending?sessionId=${sessionId}`)).items;
}
const leadSends = (items: PendingItem[]): PendingItem[] => items.filter((i) => i.kind === 'send');
// [#66] The lead's own sessionId (register is idempotent on clientKey 'lead'), which it passes to
// POST /instruction-complete.
const leadSid = async (port: number): Promise<string> => (await post<Registered>(port, '/session/register', { name: 'Claude', clientKey: 'lead' })).sessionId;

// [v6] Poll a WORKER's own queue (?for=<id>&sessionId=<sid>): a pending Send returns fast; an empty
// queue long-polls, which we abort → null.
async function nextForOrNull(port: number, forId: string, sid: string, ms = 2500): Promise<Instruction | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const q = new URLSearchParams();
  if (forId) q.set('for', forId);
  if (sid) q.set('sessionId', sid);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/next-instruction?${q}`, { signal: ac.signal });
    if (r.status === 204) return null;
    return await r.json() as Instruction;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

function cleanupFiles() {
  for (const b of boards) for (const ext of ['tldr', 'messages.jsonl', 'recipients.json', 'lock', 'png', 'port']) {
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

  // lockfiles written with the expected shape. The lock records the server's own process.pid
  // (the spawned node itself: the loader runs in-process, so there is no launcher pid), which is
  // what the skill's `kill -0 <lock.pid>` attach-vs-boot liveness check reads back.
  const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const [b, port] of [[A, portA], [B, portB]] as const) {
    const lockPath = path.join(HOME, `${b}.lock`);
    ok(fs.existsSync(lockPath), `lockfile ${b}.lock written`);
    const lock: Lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    eq(lock.port, port, `${b}.lock port matches the bound port`);
    eq(lock.board, b, `${b}.lock board is the basename`);
    ok(Number.isInteger(lock.pid) && isAlive(lock.pid), `${b}.lock pid is a live process (the attach liveness key)`);
    ok(typeof lock.startedAt === 'number' || typeof lock.startedAt === 'string', `${b}.lock has startedAt`);
  }

  console.log('\n[messages] store + idempotency');
  const r1 = await post<MessageReply>(portA, '/message', { text: 'hello A', selection: ['shape:x'], idempotencyKey: 'k1' });
  ok(r1.ok === true, 'POST /message accepted');
  eq(r1.id, 'k1', 'stored message id == idempotencyKey');

  let msgs = (await j<MessagesReply>(portA, `/messages?room=${A}`)).messages;
  eq(msgs.length, 1, 'GET /messages returns the one human message');
  eq(msgs[0]!.author.kind, 'human', 'human message attributed to a human author');
  eq(msgs[0]!.text, 'hello A', 'human message text round-trips');
  eq(msgs[0]!.id, 'k1', 'human message id is the key');
  const firstTs = msgs[0]!.ts;

  const dup = await post<MessageReply>(portA, '/message', { text: 'hello A again', idempotencyKey: 'k1' });
  ok(dup.deduped === true, 'repeat idempotencyKey is deduped');
  msgs = (await j<MessagesReply>(portA, `/messages?room=${A}`)).messages;
  eq(msgs.length, 1, 'duplicate did not double-store');

  console.log('\n[messages] agent utterance attribution');
  const reg = await post<Registered>(portA, '/session/register', { name: 'Claude', clientKey: 'ck1', transcriptPath: '/tmp/x.jsonl' });
  ok(typeof reg.sessionId === 'string' && reg.sessionId.length > 0, '/session/register returns a sessionId');
  await sleep(5); // ensure a distinct ts from the human message
  const am = await post(portA, '/agent-message', { text: 'drew a box', sessionId: reg.sessionId, idempotencyKey: 'k2' });
  ok(am.ok === true, 'POST /agent-message accepted');
  msgs = (await j<MessagesReply>(portA, `/messages?room=${A}`)).messages;
  eq(msgs.length, 2, 'agent message stored alongside the human one');
  const agent = msgs.find((m) => m.id === 'k2');
  ok(!!agent, 'agent message present by id');
  eq(agent!.author.kind, 'agent', 'agent message attributed to an agent author');
  eq(agent!.author.name, 'Claude', 'agent author name from the registered session');

  console.log('\n[messages] since= filter + reload persistence');
  const since = (await j<MessagesReply>(portA, `/messages?room=${A}&since=${firstTs}`)).messages;
  eq(since.length, 1, 'since= returns only messages after the cursor');
  eq(since[0]!.id, 'k2', 'since= returned the later (agent) message');

  const sidecar = path.join(HOME, `${A}.messages.jsonl`);
  ok(fs.existsSync(sidecar), 'JSONL sidecar written');
  const lines = fs.readFileSync(sidecar, 'utf8').trim().split('\n').filter(Boolean);
  eq(lines.length, 2, 'sidecar holds both messages (survives a reload)');

  console.log('\n[isolation] board B is independent');
  const bMsgs = (await j<MessagesReply>(portB, `/messages?room=${B}`)).messages;
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
  let cMsgs = (await j<MessagesReply>(portC1, `/messages?room=${C}`)).messages;
  eq(cMsgs.length, 2, 'both Sends stored while no agent was parked');
  ok(cMsgs.every((m) => m.completedAt == null), 'neither Send is completed yet');
  srvC1.kill('SIGTERM');
  await sleep(1300);
  ok(!fs.existsSync(path.join(HOME, `${C}.lock`)), 'board C lock removed on shutdown');

  const srvC2 = boot(C); // fresh process, same board file
  const portC2 = await srvC2._port;
  const c2Items = leadSends(await leadPull(portC2));
  eq(c2Items.map((i) => i.id).join(','), 'c1,c2', 'after restart the lead pulls both pending Sends, oldest first');
  eq(leadSends(await leadPull(portC2)).length, 0, 'nothing more pending once the backlog is fetched');
  cMsgs = (await j<MessagesReply>(portC2, `/messages?room=${C}`)).messages;
  ok(cMsgs.find((m) => m.id === 'c1')!.receivedAt != null, 'a fetched Send carries receivedAt (the pull is the receipt)');
  ok(cMsgs.every((m) => m.completedAt == null), 'fetching is not completion — both still uncompleted');
  srvC2.kill('SIGTERM');
  await sleep(1300);

  // ---- [v5] re-drain: a fetched-but-not-completed Send is not lost when its owner ends ----
  console.log('\n[v5 re-drain] fetched-but-not-completed Sends re-drain to the next owner, then complete-ack retires them');
  const srvC3 = boot(C);
  const portC3 = await srvC3._port;
  const rd = leadSends(await leadPull(portC3));
  ok(rd[0] && rd[0].id === 'c1', 'a fetched-but-not-completed Send is fetched again by the next owner (nothing lost)');
  const c3Lead = await leadSid(portC3);
  const ackC1 = await post<CompleteReply>(portC3, '/instruction-complete', { id: 'c1', sessionId: c3Lead });
  ok(ackC1.ok === true, 'POST /instruction-complete acks the turn');
  const ackC1Again = await post<CompleteReply>(portC3, '/instruction-complete', { id: 'c1', sessionId: c3Lead });
  ok(ackC1Again.alreadyComplete === true, 'repeat /instruction-complete is idempotent');
  cMsgs = (await j<MessagesReply>(portC3, `/messages?room=${C}`)).messages;
  ok(cMsgs.find((m) => m.id === 'c1')!.completedAt != null, 'a completed Send carries completedAt');
  srvC3.kill('SIGTERM');
  await sleep(1300);
  const srvC4 = boot(C);
  const portC4 = await srvC4._port;
  eq(leadSends(await leadPull(portC4)).map((i) => i.id).join(','), 'c2', 'only the still-uncompleted Send re-drains to the next owner');
  await post(portC4, '/instruction-complete', { id: 'c2', sessionId: await leadSid(portC4) });
  srvC4.kill('SIGTERM');
  await sleep(1300);

  // ---- [v9.11 #64] the lead's roster row follows its items, never a listener ----
  console.log('\n[v9.11 lead-status] the lead row reads absent → idle → not-heard → working → idle with its items');
  const srvD = boot(D);
  const portD = await srvD._port;
  const leadRow = async () => (await j<CanvasStatus>(portD, '/canvas-status')).agents.find((a) => a.id === 'lead')!;
  ok(typeof (await j<CanvasStatus>(portD, '/canvas-status')).doorbell === 'object', '/canvas-status reports the doorbell');
  eq((await leadRow()).lifecycle, 'absent', 'no lead registered: the lead row reads absent');
  const dSid = (await post<Registered>(portD, '/session/register', { name: 'Claude', clientKey: 'lead' })).sessionId;
  eq((await leadRow()).lifecycle, 'idle', 'a registered lead with nothing pending reads idle');
  eq((await leadRow()).parked, false, 'the lead is never parked (it does not long-poll)');
  await post(portD, '/message', { text: 'no doorbell here', idempotencyKey: 'd1' });
  await sleep(1300); // the doorbell tick marks it: this test board has no inbox socket
  eq((await leadRow()).lifecycle, 'not-heard', 'a Send no ring can reach makes the lead row read not-heard');
  await j(portD, `/pending?sessionId=${dSid}`);
  eq((await leadRow()).lifecycle, 'working', 'a fetched, uncompleted Send makes the lead row read working');
  await post(portD, '/instruction-complete', { id: 'd1', sessionId: dSid });
  eq((await leadRow()).lifecycle, 'idle', 'completing it returns the lead row to idle');
  srvD.kill('SIGTERM');
  await sleep(1300);

  // ---- [v9.11 #64] the lead does not long-poll ----
  console.log('\n[v9.11 no-lead-long-poll] /next-instruction is the worker self-park only');
  const srvE = boot(E);
  const portE = await srvE._port;
  eq(await getStatus(portE, '/next-instruction?for=lead&sessionId=x'), 400, 'GET /next-instruction?for=lead is 400 (the lead pulls /pending)');
  eq(await getStatus(portE, '/next-instruction?sessionId=x'), 400, 'GET /next-instruction with no for is 400');
  srvE.kill('SIGTERM');
  await sleep(1300);

  // ---- [v6] a Send addressed to a worker reaches THAT worker, not the lead ----
  console.log('\n[v6 addressing] a worker-addressed Send is served to the worker, not the lead');
  const srvF = boot(F);
  const portF = await srvF._port;
  // [v7 #43] the worker must be a registered (known) recipient before it can be addressed.
  const fW2 = (await post<Registered>(portF, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' })).sessionId;
  await post(portF, '/message', { text: 'for w2', idempotencyKey: 'f1',
    recipient: { kind: 'worker', id: 'worker-2', name: 'Claude-2' } });
  eq(leadSends(await leadPull(portF)).length, 0, 'a worker-addressed Send is NOT served to the lead');
  const w2GetsF = await nextForOrNull(portF, 'worker-2', fW2, 2500);
  ok(w2GetsF && w2GetsF.id === 'f1', 'the worker-addressed Send is served to worker-2');
  eq(w2GetsF && w2GetsF.for, 'worker-2', 'the instruction payload echoes for=worker-2');
  eq(w2GetsF && Object.keys(w2GetsF).sort().join(','), 'at,for,id,instruction,selection', 'the worker payload carries the Send fields only');
  srvF.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] a worker stays reachable across turns (self-park + re-arm on its OWN queue) ----
  console.log('\n[v6 reachable] a worker stays addressable turn after turn on its own queue');
  const srvG = boot(G);
  const portG = await srvG._port;
  const gW1 = (await post<Registered>(portG, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId; // [v7 #43] known recipient
  await post(portG, '/message', { text: 'turn 1', idempotencyKey: 'g1', recipient: { kind: 'worker', id: 'worker-1' } });
  const g1 = await nextForOrNull(portG, 'worker-1', gW1, 2500);
  ok(g1 && g1.id === 'g1', 'worker-1 gets its first Send');
  await post(portG, '/instruction-complete', { id: 'g1', for: 'worker-1', sessionId: gW1 });
  const gEmpty = await nextForOrNull(portG, 'worker-1', gW1, 1200);
  eq(gEmpty, null, 'worker-1 re-arms with nothing pending (204 = re-arm, not exit)');
  await post(portG, '/message', { text: 'turn 2', idempotencyKey: 'g2', recipient: { kind: 'worker', id: 'worker-1' } });
  const g2 = await nextForOrNull(portG, 'worker-1', gW1, 2500);
  ok(g2 && g2.id === 'g2', 'worker-1 stays reachable across turns for a later Send');
  srvG.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] a Send to a dead worker is held and drained after the lead revives it ----
  // Large grace so the storm-guard is deterministic: the 2nd lead pull is inside the window.
  console.log('\n[v6 revival] a Send to a dead worker surfaces a revive directive + is drained on revival');
  const srvH = boot(H, { WHITEBOARD_REVIVE_GRACE_MS: '5000', WHITEBOARD_REVIVE_QUIET_MS: '200' });
  const portH = await srvH._port;
  // [v7 #43] register worker-3 so it is a known recipient; it never long-polls, so once its quiet
  // window passes it reads as needing revive (candidateWorkerIds keys on a pending Send).
  const hW3 = (await post<Registered>(portH, '/session/register', { name: 'Claude-3', clientKey: 'worker-3' })).sessionId;
  await sleep(300); // > REVIVE_QUIET_MS (200): worker-3 has gone quiet, i.e. died
  await post(portH, '/message', { text: 'wake w3', idempotencyKey: 'h1',
    recipient: { kind: 'worker', id: 'worker-3', name: 'Claude-3' } });
  const sup = (await leadPull(portH)).find((i) => i.kind === 'revive');
  ok(sup && sup.revive === 'worker-3', 'the lead pull returns a revive item for the dead worker');
  const supAgain = (await leadPull(portH)).find((i) => i.kind === 'revive');
  ok(!(supAgain && supAgain.revive === 'worker-3'), 'the revive is not re-issued within the grace window (no storm)');
  const h1 = await nextForOrNull(portH, 'worker-3', hW3, 2500);
  ok(h1 && h1.id === 'h1', 'the revived worker drains the Send that waited for it (nothing lost)');
  await post(portH, '/instruction-complete', { id: 'h1', for: 'worker-3', sessionId: hW3 });
  const hDone = ((await j<MessagesReply>(portH, `/messages?room=${H}`)).messages.find((x) => x.id === 'h1') || {} as Partial<StoredMessage>).state;
  eq(hDone, 'done', 'the revived-and-completed Send is done');
  srvH.kill('SIGTERM'); await sleep(1300);

  // ---- [#64] no revive for a worker that is busy (calling the bridge) but not parked; stable color ----
  console.log('\n[#64 revive quiet] a busy worker is not revived; a quiet one is; a revived worker keeps its color');
  const srvRQ = boot(RQ, { WHITEBOARD_REVIVE_GRACE_MS: '100', WHITEBOARD_REVIVE_QUIET_MS: '600' });
  const portRQ = await srvRQ._port;
  const reg1 = await post<Registered>(portRQ, '/session/register', { name: 'Claude-5', clientKey: 'worker-5' });
  const colorOf = async () => ((await j<CanvasStatus>(portRQ, '/canvas-status')).agents.find((a) => a.id === 'worker-5') || {} as Partial<AgentRow>).color;
  const color1 = await colorOf();
  await post(portRQ, '/message', { text: 'for w5', idempotencyKey: 'rq1', recipient: { kind: 'worker', id: 'worker-5' } });
  await j(portRQ, `/shapes?sessionId=${reg1.sessionId}`); // the worker is drawing: a bridge call carrying its session
  ok(!(await leadPull(portRQ)).some((i) => i.kind === 'revive'), 'no revive for a worker that just called the bridge (busy, not dead)');
  await sleep(750); // > REVIVE_QUIET_MS (600): the worker has gone quiet
  const rqRevive = (await leadPull(portRQ)).find((i) => i.kind === 'revive');
  ok(rqRevive && rqRevive.revive === 'worker-5', 'a worker quiet past the window is revived');
  await post(portRQ, '/session/unregister', { sessionId: reg1.sessionId }); // it died
  await post(portRQ, '/session/register', { name: 'Claude-5', clientKey: 'worker-5' }); // revived
  eq(await colorOf(), color1, 'a revived worker comes back in its original cursor color');
  // [#64] A worker holding a live lease is mid-Send (its critic subagent can run for minutes with no
  // bridge call): quiet past REVIVE_QUIET_MS with a second Send queued, it is still not revived.
  const reg6 = await post<Registered>(portRQ, '/session/register', { name: 'Claude-6', clientKey: 'worker-6' });
  await post(portRQ, '/message', { text: 'w6 job one', idempotencyKey: 'rq6a', recipient: { kind: 'worker', id: 'worker-6' } });
  const took6 = await nextForOrNull(portRQ, 'worker-6', reg6.sessionId, 2500);
  ok(took6 && took6.id === 'rq6a', 'worker-6 takes its first Send and holds the lease');
  await post(portRQ, '/message', { text: 'w6 job two', idempotencyKey: 'rq6b', recipient: { kind: 'worker', id: 'worker-6' } });
  await sleep(750); // > REVIVE_QUIET_MS (600), far inside STALL_MS: quiet, but the lease is live
  ok(!(await leadPull(portRQ)).some((i) => i.kind === 'revive' && i.revive === 'worker-6'), 'a lease holder quiet past REVIVE_QUIET_MS with a second Send queued is not revived');
  eq(((await j<CanvasStatus>(portRQ, '/canvas-status')).agents.find((a) => a.id === 'worker-6') || {} as Partial<AgentRow>).lifecycle, 'working', 'and its roster row reads working');
  srvRQ.kill('SIGTERM'); await sleep(1300);

  // ---- [#64 SF3] a guest is present, but never a recipient, revived, or waited on by a broadcast ----
  console.log('\n[#64 guest] a guest session shows its presence but is never addressed, revived, or waited on');
  const srvGU = boot(GU, { WHITEBOARD_REVIVE_GRACE_MS: '100', WHITEBOARD_REVIVE_QUIET_MS: '200' });
  const portGU = await srvGU._port;
  const postFull = (p: string, body: unknown): Promise<Full<RegisterReply>> => fetch(`http://127.0.0.1:${portGU}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() as RegisterReply }));
  eq((await postFull('/session/register', { name: 'Guest', clientKey: 'lead', guest: true })).status, 400, 'a guest registering as "lead" is a 400');
  eq((await postFull('/session/register', { name: 'Guest', guest: true })).status, 400, 'a guest registering with no clientKey of its own is a 400');
  // [#64 Sug 1] A key holding `$`, `{` or `}` is a shell expansion that never ran (the guest line
  // copied inside single quotes), so two guests would share it: refused, worker or guest.
  for (const [clientKey, guest] of [['guest-${CLAUDE_PID:-$PPID}', true], ['guest-$PPID', true], ['worker-{1}', false], ['worker-1}', false]] as const) {
    const r = await postFull('/session/register', { name: 'Unexpanded', clientKey, guest });
    eq(`${r.status} ${r.body.error}`, '400 clientKey must not contain $, { or }', `a clientKey ${JSON.stringify(clientKey)} is a 400 that names the characters`);
  }
  ok(!(await j<CanvasStatus>(portGU, '/canvas-status')).agents.some((a) => /[${}]/.test(a.id)), 'and none of them registers');
  await post(portGU, '/session/register', { name: 'Claude', clientKey: 'lead' });
  const guReg = await postFull('/session/register', { name: 'Guest session', clientKey: 'guest-abc', guest: true });
  ok(guReg.status === 200 && typeof guReg.body.sessionId === 'string', 'a guest registers under its own clientKey');
  const guW1Sid = (await post<Registered>(portGU, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId;
  const guRow = (await j<CanvasStatus>(portGU, '/canvas-status')).agents.find((a) => a.id === 'guest-abc');
  ok(!!guRow, 'the guest appears on the roster (its presence is shown)');
  eq(guRow && guRow.guest, true, 'and its roster entry carries guest: true');
  eq(((await j<CanvasStatus>(portGU, '/canvas-status')).agents.find((a) => a.id === 'worker-1') || {} as Partial<AgentRow>).guest, undefined, 'a worker entry carries no guest flag');
  const toGuest = await postFull('/message', { text: 'hi guest', idempotencyKey: 'gu1', recipient: { kind: 'worker', id: 'guest-abc' } });
  eq(toGuest.status, 400, 'a Send addressed to a guest is a 400');
  eq(toGuest.body.error, 'recipient is a guest session', 'and says the recipient is a guest');
  ok(!(await j<MessagesReply>(portGU, `/messages?room=${GU}`)).messages.some((m) => m.id === 'gu1'), 'and is not stored');
  eq(await getStatus(portGU, `/next-instruction?for=guest-abc&sessionId=${guReg.body.sessionId}`), 400, 'a guest has no queue to long-poll (not a recipient id)');
  await post(portGU, '/message', { text: 'everyone: stop', idempotencyKey: 'gub', recipient: { kind: 'broadcast' } });
  const gub = (await j<MessagesReply>(portGU, `/messages?room=${GU}`)).messages.find((m) => m.id === 'gub');
  eq(JSON.stringify(gub && gub.broadcastTo), JSON.stringify(['worker-1']), 'a broadcast fans to the workers only, never the guest');
  const guW1 = await nextForOrNull(portGU, 'worker-1', guW1Sid, 2500);
  ok(guW1 && guW1.id === 'gub', 'the worker receives the broadcast');
  await post(portGU, '/instruction-complete', { id: 'gub', for: 'worker-1', sessionId: guW1Sid });
  eq(((await j<MessagesReply>(portGU, `/messages?room=${GU}`)).messages.find((m) => m.id === 'gub') || {} as Partial<StoredMessage>).state, 'done', 'the broadcast is done once the worker completes (the guest does not hold it open)');
  await sleep(300); // > REVIVE_QUIET_MS: the guest is quiet
  ok(!(await leadPull(portGU)).some((i) => i.kind === 'revive' && i.revive === 'guest-abc'), 'a quiet guest is never revived');
  // [#64 SF3] Guests and workers never share a clientKey, by its prefix: a guest's key starts with
  // "guest-" and a worker's never does. The rule is the key itself, so it holds across a restart.
  const w1Before = (await post<Registered>(portGU, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId;
  const guOnWorker = await postFull('/session/register', { name: 'Guest session', clientKey: 'worker-1', guest: true });
  eq(guOnWorker.status, 400, "a guest registering on a key without the guest- prefix (here a live worker's) is a 400");
  eq(guOnWorker.body.error, 'a guest\'s clientKey must start with "guest-"', 'and says a guest key starts with guest-');
  eq((await post<Registered>(portGU, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId, w1Before, "the worker keeps its session");
  ok(!(await j<CanvasStatus>(portGU, '/canvas-status')).agents.find((a) => a.id === 'worker-1')!.guest, 'and is still a worker, not a guest');
  const wOnGuest = await postFull('/session/register', { name: 'Claude-2', clientKey: 'guest-abc' });
  eq(wOnGuest.status, 400, "a worker registering on a guest- key (here a live guest's) is a 400");
  eq(wOnGuest.body.error, 'only a guest\'s clientKey may start with "guest-"', 'and says only a guest key starts with guest-');
  eq(((await j<CanvasStatus>(portGU, '/canvas-status')).agents.find((a) => a.id === 'guest-abc') || {} as Partial<AgentRow>).guest, true, 'and the guest stays a guest');
  eq((await postFull('/session/register', { name: 'Guest session', clientKey: 'guest-abc', guest: true })).body.sessionId, guReg.body.sessionId, 'a guest re-registering on its own key rebinds to its session');
  const goneSid = (await post<Registered>(portGU, '/session/register', { name: 'Claude-9', clientKey: 'worker-9' })).sessionId;
  await post(portGU, '/message', { text: 'for worker-9', idempotencyKey: 'gu9', recipient: { kind: 'worker', id: 'worker-9' } });
  await post(portGU, '/session/unregister', { sessionId: goneSid });
  srvGU.kill('SIGTERM'); await sleep(1300);
  // After a restart this process remembers no worker key and no guest key; the prefix still decides.
  const srvGU2 = boot(GU, { WHITEBOARD_REVIVE_GRACE_MS: '100', WHITEBOARD_REVIVE_QUIET_MS: '200' });
  const portGU2 = await srvGU2._port;
  const postFull2 = (p: string, body: unknown): Promise<Full<RegisterReply>> => fetch(`http://127.0.0.1:${portGU2}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() as RegisterReply }));
  eq((await postFull2('/session/register', { name: 'Guest session', clientKey: 'worker-9', guest: true })).status, 400, "after a restart, a guest on a dead worker's key (its Send still queued) is a 400");
  eq((await postFull2('/session/register', { name: 'Claude-2', clientKey: 'guest-abc' })).status, 400, "and a worker on a gone guest's key is a 400");
  srvGU2.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] per-recipient lease/reclaim: a stalled worker lease re-queues on THAT worker's queue ----
  console.log('\n[v6 lease] a worker-only crash reclaims its Send on its own queue, not the lead\'s');
  const srvI = boot(I, { WHITEBOARD_STALL_MS: '400', WHITEBOARD_SWEEP_MS: '150' });
  const portI = await srvI._port;
  const stateOfI = async (id: string) => ((await j<MessagesReply>(portI, `/messages?room=${I}`)).messages.find((x) => x.id === id) || {} as Partial<StoredMessage>).state;
  // [#66] Each "session" below is a real registration on worker-4's key: one session per key at a
  // time, so a successor registers after its predecessor is unregistered (it died).
  const regI = async () => (await post<Registered>(portI, '/session/register', { name: 'Claude-4', clientKey: 'worker-4' })).sessionId;
  const w4a = await regI(); // [v7 #43] known recipient
  await post(portI, '/message', { text: 'lease w4', idempotencyKey: 'i1', recipient: { kind: 'worker', id: 'worker-4' } });
  const tookI = await nextForOrNull(portI, 'worker-4', w4a, 2500);
  ok(tookI && tookI.id === 'i1', 'worker-4 session A takes the Send');
  eq(tookI?.refetch, undefined, 'a first serve of a worker Send is not marked refetch');
  eq(await stateOfI('i1'), 'working', 'the leased worker Send is working');
  await sleep(900); // A goes silent; its lease expires and the sweep reclaims it
  eq(await stateOfI('i1'), 'stalled', 'the expired worker lease reclaims the Send to stalled');
  eq(leadSends(await leadPull(portI)).length, 0, 'the reclaimed worker Send does not leak onto the lead queue');
  await post(portI, '/session/unregister', { sessionId: w4a }); // session A died
  const w4b = await regI();
  const redoI = await nextForOrNull(portI, 'worker-4', w4b, 2500);
  ok(redoI && redoI.id === 'i1', 'a new worker-4 session is redelivered the reclaimed Send on its own queue');
  eq(redoI?.refetch, true, 'the redelivered worker Send is marked refetch: true, because session A may have drawn part of it');
  eq(await stateOfI('i1'), 'working', 'the redelivered worker Send is working again');
  await post(portI, '/instruction-complete', { id: 'i1', for: 'worker-4', sessionId: w4b });
  eq(await stateOfI('i1'), 'done', 'completing retires the worker Send');
  // A reclaimed Send handed to a worker already parked on its queue is marked the same way.
  await post(portI, '/message', { text: 'lease w4 again', idempotencyKey: 'i2', recipient: { kind: 'worker', id: 'worker-4' } });
  await post(portI, '/session/unregister', { sessionId: w4b });
  const w4c = await regI();
  const tookI2 = await nextForOrNull(portI, 'worker-4', w4c, 2500);
  eq(`${tookI2?.id} ${tookI2?.refetch}`, 'i2 undefined', 'worker-4 session C takes a new Send, not marked refetch');
  await post(portI, '/session/unregister', { sessionId: w4c }); // session C died holding the lease
  const w4d = await regI();
  const parkedI2 = await nextForOrNull(portI, 'worker-4', w4d, 3000); // parks until C's lease is reclaimed
  eq(`${parkedI2?.id} ${parkedI2?.refetch}`, 'i2 true', 'a reclaimed Send handed to a parked worker is marked refetch: true');
  await post(portI, '/instruction-complete', { id: 'i2', for: 'worker-4', sessionId: w4d });
  srvI.kill('SIGTERM'); await sleep(1300);

  // ---- [v6] an `everyone` broadcast reaches all registered recipients ----
  console.log('\n[v6 broadcast] `everyone` fans one Send to every registered worker, done only when all complete');
  const srvJ = boot(J);
  const portJ = await srvJ._port;
  const jW1 = (await post<Registered>(portJ, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId;
  const jW2 = (await post<Registered>(portJ, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' })).sessionId;
  await post(portJ, '/message', { text: 'everyone!', idempotencyKey: 'j1', recipient: { kind: 'broadcast' } });
  const jw1 = await nextForOrNull(portJ, 'worker-1', jW1, 2500);
  const jw2 = await nextForOrNull(portJ, 'worker-2', jW2, 2500);
  ok(jw1 && jw1.id === 'j1', 'the broadcast reaches worker-1');
  ok(jw2 && jw2.id === 'j1', 'the broadcast reaches worker-2 (same message id, both queues)');
  eq(leadSends(await leadPull(portJ)).length, 0, 'the broadcast does not go to the lead');
  await post(portJ, '/instruction-complete', { id: 'j1', for: 'worker-1', sessionId: jW1 });
  const jPartial = ((await j<MessagesReply>(portJ, `/messages?room=${J}`)).messages.find((x) => x.id === 'j1') || {} as Partial<StoredMessage>).state;
  ok(jPartial !== 'done', 'the broadcast is not done while worker-2 has not completed');
  await post(portJ, '/instruction-complete', { id: 'j1', for: 'worker-2', sessionId: jW2 });
  const jDone = ((await j<MessagesReply>(portJ, `/messages?room=${J}`)).messages.find((x) => x.id === 'j1') || {} as Partial<StoredMessage>).state;
  eq(jDone, 'done', 'the broadcast reads done only once every recipient completes');
  srvJ.kill('SIGTERM'); await sleep(1300);

  // ---- [v7 #43] typed AgentId: an unknown recipient id is rejected 400 at every seam ----
  console.log('\n[v7 typed-AgentId] an unknown recipient id is rejected 400 at every seam');
  const srvK = boot(K);
  const portK = await srvK._port;
  const kW1Sid = (await post<Registered>(portK, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId; // a known worker
  // negatives — an unknown id is 400 at each of the three seams
  eq(await postStatus(portK, '/message', { text: 'x', idempotencyKey: 'k-ghost', recipient: { kind: 'worker', id: 'ghost' } }),
     400, 'POST /message with an unknown worker recipient is 400');
  eq(await getStatus(portK, `/next-instruction?for=ghost&sessionId=${kW1Sid}`),
     400, 'GET /next-instruction?for=<unknown> is 400');
  eq(await getStatus(portK, `/next-instruction?for=everyone&sessionId=${kW1Sid}`),
     400, 'GET /next-instruction?for=everyone is 400 (nobody drains "everyone")');
  eq(await postStatus(portK, '/instruction-complete', { id: 'whatever', for: 'ghost', sessionId: kW1Sid }),
     400, 'POST /instruction-complete with an unknown for is 400 (before the message 404)');
  // positives — lead, a registered worker, and a broadcast are all accepted
  const kLead = await post(portK, '/message', { text: 'to lead', idempotencyKey: 'k-lead' });
  ok(kLead.ok === true, 'POST /message to the lead (no recipient) is accepted');
  const kW1 = await post(portK, '/message', { text: 'to w1', idempotencyKey: 'k-w1', recipient: { kind: 'worker', id: 'worker-1' } });
  ok(kW1.ok === true, 'POST /message to a registered worker is accepted');
  const kBcast = await post(portK, '/message', { text: 'to all', idempotencyKey: 'k-all', recipient: { kind: 'broadcast' } });
  ok(kBcast.ok === true, 'POST /message broadcast (everyone) is accepted');
  // retained across death — a registered-THEN-unregistered worker id stays a valid recipient
  const kReg2 = await post<Registered>(portK, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' });
  await post(portK, '/session/unregister', { sessionId: kReg2.sessionId });
  eq(await postStatus(portK, '/message', { text: 'held for dead w2', idempotencyKey: 'k-w2', recipient: { kind: 'worker', id: 'worker-2' } }),
     200, 'POST /message to a registered-then-dead worker is still accepted (id retained across death)');
  srvK.kill('SIGTERM'); await sleep(1300);

  // ---- [#66] the fetch and the completion carry the recipient's own registered sessionId ----
  console.log('\n[#66 session-bound] only the session registered as a recipient takes or completes its Sends; a restarted bridge is recovered by re-registering');
  const srvS1 = boot(SID);
  const portS1 = await srvS1._port;
  const getFull = (port: number, p: string): Promise<Full<Refusal>> => fetch(`http://127.0.0.1:${port}${p}`).then(async (r) => ({ status: r.status, body: await r.json() as Refusal }));
  const postFullS = (port: number, p: string, body: unknown): Promise<Full<Refusal>> => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() as Refusal }));
  const rowS = async (port: number, id: string): Promise<Partial<StoredMessage>> => (await j<MessagesReply>(port, `/messages?room=${SID}`)).messages.find((m) => m.id === id) || {};
  const sLead = (await post<Registered>(portS1, '/session/register', { name: 'Claude', clientKey: 'lead' })).sessionId;
  const sW1 = (await post<Registered>(portS1, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId;
  const sW2 = (await post<Registered>(portS1, '/session/register', { name: 'Claude-2', clientKey: 'worker-2' })).sessionId;
  await post(portS1, '/message', { text: 'for w1', idempotencyKey: 's1', recipient: { kind: 'worker', id: 'worker-1' } });
  // The fetch: missing, unregistered and another recipient's session are refused, and deliver nothing.
  eq(await getStatus(portS1, '/next-instruction?for=worker-1'), 400, 'GET /next-instruction with no sessionId is 400');
  const sUnreg = await getFull(portS1, '/next-instruction?for=worker-1&sessionId=not-a-session');
  eq(sUnreg.status, 403, 'GET /next-instruction with a sessionId that is not registered is 403');
  ok(/re-register/.test(sUnreg.body.error), 'and the 403 tells the worker to re-register');
  eq(await getStatus(portS1, `/next-instruction?for=worker-1&sessionId=${sW2}`), 403, "GET /next-instruction with another worker's sessionId is 403");
  eq(await getStatus(portS1, `/next-instruction?for=worker-1&sessionId=${sLead}`), 403, "GET /next-instruction with the lead's sessionId is 403");
  eq(await getStatus(portS1, `/next-instruction?for=ghost&sessionId=${sW1}`), 400, 'a registered session naming an unknown for is still the unknown-recipient 400');
  const sAfterRefusals = await rowS(portS1, 's1');
  eq(`${sAfterRefusals.state} ${sAfterRefusals.deliveredAt ?? null} ${sAfterRefusals.deliveredBy ?? null}`, 'queued null null', 'none of the refused fetches delivered or marked the Send');
  const sTook = await nextForOrNull(portS1, 'worker-1', sW1, 2500);
  ok(sTook && sTook.id === 's1', "worker-1's own registered session takes the Send");
  eq((await rowS(portS1, 's1')).deliveredBy, sW1, 'and the delivery names that session');
  // The completion: the same three refusals, and none of them completes the Send.
  eq(await postStatus(portS1, '/instruction-complete', { id: 's1', for: 'worker-1' }), 400, 'POST /instruction-complete with no sessionId is 400');
  eq(await postStatus(portS1, '/instruction-complete', { id: 's1', for: 'worker-1', sessionId: 'not-a-session' }), 403, 'POST /instruction-complete with an unregistered sessionId is 403');
  eq(await postStatus(portS1, '/instruction-complete', { id: 's1', for: 'worker-1', sessionId: sW2 }), 403, "POST /instruction-complete with another worker's sessionId is 403");
  eq(await postStatus(portS1, '/instruction-complete', { id: 's1', sessionId: sLead }), 403, "the lead's session cannot complete a worker's Send (for is immaterial off a broadcast)");
  eq((await rowS(portS1, 's1')).state, 'working', 'none of the refused completions completed the Send');
  await post(portS1, '/message', { text: 'everyone', idempotencyKey: 'sb', recipient: { kind: 'broadcast' } });
  const sOther = await postFullS(portS1, '/instruction-complete', { id: 'sb', for: 'worker-1', sessionId: sW2 });
  eq(sOther.status, 403, "on a broadcast, a session cannot complete another recipient's copy");
  ok(/'worker-2'/.test(sOther.body.error) && !/re-register/.test(sOther.body.error), `and that 403 names the session's own key and does not say to re-register (${sOther.body.error})`);
  eq((await rowS(portS1, 'sb')).delivery?.['worker-1']?.completedAt ?? null, null, "and worker-1's copy stays uncompleted");
  eq((await post(portS1, '/instruction-complete', { id: 'sb', for: 'worker-1', sessionId: sW1 })).ok, true, 'worker-1 completes its own broadcast copy with its sessionId');
  eq((await rowS(portS1, 'sb')).delivery?.['worker-2']?.completedAt ?? null, null, "and worker-2's copy stays open");
  eq((await post(portS1, '/instruction-complete', { id: 'sb', sessionId: sW2 })).ok, true, "worker-2 completes its own broadcast copy with no for: for defaults to the key its sessionId registered on");
  ok(typeof (await rowS(portS1, 'sb')).delivery?.['worker-2']?.completedAt === 'number', "and worker-2's copy is completed");
  const sLeadSend = await post(portS1, '/message', { text: 'for lead', idempotencyKey: 'sl' });
  ok(sLeadSend.ok, 'a lead Send is stored');
  eq(await postStatus(portS1, '/instruction-complete', { id: 'sl', sessionId: sW1 }), 403, "a worker's session cannot complete the lead's Send");
  eq((await post(portS1, '/instruction-complete', { id: 'sl', sessionId: sLead })).ok, true, 'the lead completes its own Send with its sessionId');
  eq((await post(portS1, '/instruction-complete', { id: 's1', for: 'worker-1', sessionId: sW1 })).ok, true, 'worker-1 completes its own Send with its sessionId');
  eq((await rowS(portS1, 's1')).state, 'done', 'and the Send is done');
  // A Send waits for worker-1 across a restart; the old sessionId is gone with the process.
  await post(portS1, '/message', { text: 'across the restart', idempotencyKey: 's2', recipient: { kind: 'worker', id: 'worker-1' } });
  // worker-3 registers and is never sent anything, so the Send log never names it.
  await post(portS1, '/session/register', { name: 'Claude-3', clientKey: 'worker-3' });
  srvS1.kill('SIGTERM'); await sleep(1300);
  const srvS2 = boot(SID);
  const portS2 = await srvS2._port;
  // The restart forgets every session but no recipient: a Send to a worker that has not re-registered
  // yet is accepted and waits in its queue.
  const sToW1 = await postFullS(portS2, '/message', { text: 'sent before worker-1 is back', idempotencyKey: 's3', recipient: { kind: 'worker', id: 'worker-1' } });
  eq(sToW1.status, 200, 'after a restart, a Send to a worker that has not re-registered yet is accepted');
  const sToW3 = await postFullS(portS2, '/message', { text: 'for the worker that was never sent anything', idempotencyKey: 's4', recipient: { kind: 'worker', id: 'worker-3' } });
  eq(sToW3.status, 200, 'and so is a Send to a worker that registered before the restart and was never sent anything');
  eq((await postFullS(portS2, '/message', { text: 'x', idempotencyKey: 's-ghost', recipient: { kind: 'worker', id: 'ghost' } })).status, 400, 'a key never registered on this board is still a 400');
  const sStale = await getFull(portS2, `/next-instruction?for=worker-1&sessionId=${sW1}`);
  eq(sStale.status, 403, "after a restart, the worker's old sessionId is 403");
  ok(/re-register/.test(sStale.body.error), 'and the 403 tells the worker to re-register');
  eq((await rowS(portS2, 's2')).deliveredAt ?? null, null, 'and the stale fetch delivered nothing');
  const sW1Again = (await post<Registered>(portS2, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' })).sessionId;
  ok(typeof sW1Again === 'string' && sW1Again !== sW1, 're-registering on the same clientKey returns a new sessionId');
  const sResumed = await nextForOrNull(portS2, 'worker-1', sW1Again, 2500);
  ok(sResumed && sResumed.id === 's2', 'the re-registered worker resumes its fetch loop and takes the Send that waited across the restart');
  eq(await postStatus(portS2, '/instruction-complete', { id: 's2', for: 'worker-1', sessionId: sW1 }), 403, 'completing with the pre-restart sessionId is 403');
  eq((await post(portS2, '/instruction-complete', { id: 's2', for: 'worker-1', sessionId: sW1Again })).ok, true, 'and completing with the new one succeeds');
  eq((await rowS(portS2, 's2')).state, 'done', 'so the Send that crossed the restart is done');
  const sNext = await nextForOrNull(portS2, 'worker-1', sW1Again, 2500);
  ok(sNext && sNext.id === 's3', 'the Send stored before worker-1 re-registered is served to it next');
  const sW3Again = (await post<Registered>(portS2, '/session/register', { name: 'Claude-3', clientKey: 'worker-3' })).sessionId;
  const sW3Took = await nextForOrNull(portS2, 'worker-3', sW3Again, 2500);
  ok(sW3Took && sW3Took.id === 's4', 'and worker-3, re-registered, is served the Send that waited for it');
  srvS2.kill('SIGTERM'); await sleep(1300);
  // The recipients are the board's own: a sibling board knows none of them.
  const srvS3 = boot(SID2);
  const portS3 = await srvS3._port;
  eq((await postFullS(portS3, '/message', { text: 'x', idempotencyKey: 's-other', recipient: { kind: 'worker', id: 'worker-1' } })).status, 400, "another board does not know this board's workers");
  srvS3.kill('SIGTERM'); await sleep(1300);

  // ---- [v7 #45] the revive directive's nudge is verbatim + invariant to the pending instruction ----
  console.log('\n[v7 verbatim-nudge] the revive nudge is fixed bootstrap text, never the instruction');
  const srvL = boot(L, { WHITEBOARD_REVIVE_GRACE_MS: '100', WHITEBOARD_REVIVE_QUIET_MS: '1' });
  const portL = await srvL._port;
  const lW3 = (await post<Registered>(portL, '/session/register', { name: 'Claude-3', clientKey: 'worker-3' })).sessionId;
  // first revival — a Send whose text must NOT appear in the nudge
  await post(portL, '/message', { text: 'ALPHA-SECRET-INSTRUCTION', idempotencyKey: 'l1', recipient: { kind: 'worker', id: 'worker-3' } });
  const lDir1 = (await leadPull(portL)).find((i) => i.kind === 'revive');
  ok(lDir1 && lDir1.revive === 'worker-3' && typeof lDir1.nudge === 'string' && lDir1.nudge.length > 0,
     'the revive directive carries a non-empty nudge string');
  // drain + complete l1 so worker-3's queue is empty, then let the grace window lapse
  const lDrain = await nextForOrNull(portL, 'worker-3', lW3, 2500);
  ok(lDrain && lDrain.id === 'l1', 'worker-3 drains its first Send');
  await post(portL, '/instruction-complete', { id: 'l1', for: 'worker-3', sessionId: lW3 });
  await sleep(250); // > REVIVE_GRACE_MS (100) so the next revive is not storm-suppressed
  // second revival — a DIFFERENT instruction; the nudge must be byte-identical
  await post(portL, '/message', { text: 'BRAVO-DIFFERENT-PAYLOAD', idempotencyKey: 'l2', recipient: { kind: 'worker', id: 'worker-3' } });
  const lDir2 = (await leadPull(portL)).find((i) => i.kind === 'revive');
  ok(lDir2 && lDir2.revive === 'worker-3' && typeof lDir2.nudge === 'string',
     'the second revive directive also carries a nudge');
  eq(lDir1!.nudge, lDir2!.nudge, 'the nudge is byte-identical across revivals with different pending instructions');
  ok(!lDir1!.nudge!.includes('ALPHA-SECRET-INSTRUCTION') && !lDir2!.nudge!.includes('BRAVO-DIFFERENT-PAYLOAD'),
     'the nudge contains neither instruction text (no paraphrase can ride it)');
  ok(lDir1!.nudge!.includes('worker-3'), 'the nudge names the recipient AgentId');
  ok(/A 403 that says your sessionId is not registered/.test(lDir1!.nudge!), 'the nudge sends the worker to re-register only on the 403 that says its sessionId is not registered');
  ok(lDir1!.nudge!.includes(`127.0.0.1:${portL}`), 'the nudge carries the bridge base URL');
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
  eq((JSON.parse(fs.readFileSync(mLockPath, 'utf8')) as Lock).port, portM, 'M.lock initially points at M\'s own server');

  // srvN opens M (already live on srvM). Attach, do NOT switch in-process.
  const openLive = await post<BoardOpenReply>(portN, '/board/open', { path: path.join(HOME, `${M}.tldr`) });
  eq(openLive.attach, true, '/board/open reports attach:true when the target board is already live');
  eq(openLive.port, portM, '/board/open hands back the live owner\'s port to attach to');
  eq((JSON.parse(fs.readFileSync(mLockPath, 'utf8')) as Lock).port, portM, 'M.lock still points at M\'s server (not stolen by N) — the split-brain is prevented');
  eq((await j<CanvasStatus>(portN, '/canvas-status')).activeRoom, N, 'srvN stayed on its own board N (no in-process steal)');
  // [#64] The switcher joins the room the server names, which the sync guard admits.
  eq(((await j<BoardRow[]>(portN, '/boards')).find((b) => b.name === C) || {} as Partial<BoardRow>).room, C, '/boards names each board\'s sync room as the server does');

  // [#66] Two workers registered on N: worker-8 stays live, worker-9 dies before the switch.
  await post(portN, '/session/register', { name: 'Claude-8', clientKey: 'worker-8' });
  const nW9 = (await post<Registered>(portN, '/session/register', { name: 'Claude-9', clientKey: 'worker-9' })).sessionId;
  await post(portN, '/session/unregister', { sessionId: nW9 });

  // Control: opening an UNOWNED board switches in-process (attach:false, the common single-server case).
  const openUnowned = await post<BoardOpenReply>(portN, '/board/open', { path: path.join(HOME, `${O}.tldr`) });
  eq(openUnowned.attach, false, '/board/open switches in-process (attach:false) for an unowned board');
  eq((await j<CanvasStatus>(portN, '/canvas-status')).activeRoom, O, 'srvN switched to the unowned board O in-process');
  // [#66] A board's recipients are its own: a worker live on this process is addressable on the board
  // it switched to, and a dead one registered only on the board left is not.
  eq(await postStatus(portN, '/message', { text: 'w8 on O', idempotencyKey: 'n-w8', recipient: { kind: 'worker', id: 'worker-8' } }),
     200, 'after a switch, a worker session still live on this process is a recipient on the new board');
  eq(await postStatus(portN, '/message', { text: 'w9 on O', idempotencyKey: 'n-w9', recipient: { kind: 'worker', id: 'worker-9' } }),
     400, 'and a dead worker registered only on the board left is not');

  // Stale-lock reclaim: kill M's server (its lock.pid, the spawned node itself) with SIGKILL. SIGKILL is uncatchable, so no graceful removeLock runs: M.lock
  // stays on disk pointing at a now-dead process. Opening M must reclaim it in-process
  // (attach:false), distinguishing a stale lock from a live owner (the guard confirms liveness via
  // the /canvas-status probe, which a dead server fails, so a lingering zombie pid can't fool it).
  const mLock: Lock = JSON.parse(fs.readFileSync(mLockPath, 'utf8'));
  try { process.kill(mLock.pid, 'SIGKILL'); } catch { /* already gone */ }
  await sleep(800);
  ok(fs.existsSync(mLockPath), 'the killed server left a stale M.lock behind (no graceful cleanup)');
  const openStale = await post<BoardOpenReply>(portN, '/board/open', { path: path.join(HOME, `${M}.tldr`) });
  eq(openStale.attach, false, '/board/open reclaims a stale-locked (dead-pid) board in-process, not attach');
  eq((await j<CanvasStatus>(portN, '/canvas-status')).activeRoom, M, 'srvN took over M after its owner died (stale lock reclaimed)');
  srvN.kill('SIGTERM'); await sleep(1300);

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

// Headless acceptance test for whiteboard v9.1 (SPEC §2 [v9.1] checks, §8.2/§8.5, §12 lane 4).
// Covers the two waiter-independent server seams v9.1 adds (SPEC §12 lane 2), written to the
// FIXED CONTRACTS in SPEC even though the server lane is still landing its edits — so it runs
// green at integration, not before:
//
//   1. parseRecipient guard (#43/#52, extended v9.1) — a MALFORMED recipient is rejected 400
//      rather than silently defaulted to the lead; an OMITTED recipient still defaults to the
//      lead (200); {kind:lead} / {kind:broadcast} / a registered worker are accepted (200).
//   2. Teardown seam (#53) — POST /request-teardown surfaces a teardown directive on the lead's
//      GET /pending pull (a control signal, NOT a chat Message), clears on consume, and the
//      graceful POST /done returns ok.
//
// The carried §8.5 durable-delivery / lead-status / lease checks are NOT duplicated here — they
// already pass in server/integration.test.ts (boards C durable-queue + re-drain, D lead status
// flip, E lease/visibility-timeout, F–J per-recipient routing/broadcast, K typed-AgentId 400,
// L verbatim nudge). This file adds only what v9.1 introduces, plus one durable-floor assertion
// specific to v9.1: that a teardown REQUEST does not enter the queue or displace pending work.
// The meta.createdBy authorship check (§8.6) needs the live render-canvas (the app stamps it via
// an editor side-effect), so it is not headlessly testable with WHITEBOARD_NO_CANVAS and lives in
// the manual runbook references/acceptance-v9.1.md instead.
//
//   node --import tsx acceptance-v9.1.test.ts      (run from server/)
//
// Same harness as integration.test.ts: boots the real bridge over tsx with the render-canvas
// skipped (WHITEBOARD_NO_CANVAS), ephemeral ports, temp scratch under the repo's .scratchpad. No
// Chromium, no browser, no reliance on the live :65459 board, no external network. Exit 0 = pass.

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

// Distinct board names (own prefix) so this file can run alongside integration.test.ts without
// colliding on .tldr / .lock / .messages.jsonl files or room ids.
const P = 'wbv91_p'; // [v9.1 #43] parseRecipient guard: malformed 400, omitted defaults to lead
const T = 'wbv91_t'; // [v9.1 #53] teardown seam: request → /pending teardown item → clears → /done
const boards = [P, T];

// --- tiny assertion harness (mirrors integration.test.ts) ------------------
let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// --- boot a bridge, resolve its port from stdout (identical to integration.test.ts) ----------
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

// The response shapes this file reads. Each names only the fields a check looks at.
interface OkReply { ok?: boolean }
interface Registered { sessionId: string }
interface StoredMessage { id: string; recipient?: { kind?: string; id?: string } | null }
interface MessagesReply { messages: StoredMessage[] }
interface PendingItem { kind?: string; id?: string; teardown?: boolean }
interface PendingReply { items: PendingItem[] }
interface CanvasStatus { teardownRequested?: boolean }

const j = <T>(port: number, p: string, init?: RequestInit): Promise<T> => fetch(`http://127.0.0.1:${port}${p}`, init).then((r) => r.json() as Promise<T>);
const post = <T = OkReply>(port: number, p: string, body: unknown): Promise<T> =>
  j<T>(port, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
// Raw variants that expose the HTTP status (the JSON helpers swallow it), so a seam-validation
// rejection can be asserted as a 400 rather than inferred from the body.
const postStatus = (port: number, p: string, body: unknown): Promise<number> =>
  fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status);

// [v9.11 #64] The lead's pull: GET /pending as the registered lead. Returns the items array.
async function leadPull(port: number): Promise<PendingItem[]> {
  const { sessionId } = await post<Registered>(port, '/session/register', { name: 'Claude', clientKey: 'lead' });
  return (await j<PendingReply>(port, `/pending?sessionId=${sessionId}`)).items;
}

// [v9.1 #53] Recognize a teardown directive structurally. The FIXED CONTRACT is `kind:"teardown"`
// (SPEC §2/§9); we also accept a `{ teardown:true }` flag shape so the assertion tracks the seam
// intent regardless of the exact field name the server lane picks — the report flags this so the
// integrator can pin it to the shape actually shipped.
const isTeardown = (dir: PendingItem | undefined): boolean => !!dir && (dir.kind === 'teardown' || dir.teardown === true);

function cleanupFiles() {
  for (const b of boards) for (const ext of ['tldr', 'messages.jsonl', 'recipients.json', 'lock', 'png', 'port']) {
    fs.rmSync(path.join(HOME, `${b}.${ext}`), { force: true });
  }
}

async function main() {
  cleanupFiles();

  // ============================================================================
  // [v9.1 #43] parseRecipient guard — malformed 400, omitted → lead, valid → 200
  // ============================================================================
  // Pre-v9.1 the server SILENTLY defaulted any unparseable recipient to the lead (parseRecipient
  // returned undefined for a bare string / bad kind, and the /message handler treated undefined as
  // "no recipient" → lead). v9.1 hardens the seam to distinguish ABSENT (→ default lead) from
  // PRESENT-BUT-INVALID (→ 400). These assertions are the fixed contract; the bare-string and
  // bad-kind cases require the server lane's parseRecipient delta (index.ts:1359) and will fail
  // until it lands — that is expected, per SPEC §12.
  console.log('\n[v9.1 #43 parseRecipient] a malformed recipient is 400; omitted still defaults to the lead');
  const srvP = boot(P);
  const portP = await srvP._port;
  await post(portP, '/session/register', { name: 'Claude-1', clientKey: 'worker-1' }); // a known worker recipient

  // --- malformed → 400 (present but invalid; must NOT silently default to the lead) ---
  eq(await postStatus(portP, '/message', { text: 'x', idempotencyKey: 'p-str', recipient: 'worker-1' }),
     400, 'POST /message with a bare-string recipient is 400 (not silently defaulted to the lead)');
  eq(await postStatus(portP, '/message', { text: 'x', idempotencyKey: 'p-kind', recipient: { kind: 'peer' } }),
     400, 'POST /message with a bad recipient.kind is 400');
  eq(await postStatus(portP, '/message', { text: 'x', idempotencyKey: 'p-noid', recipient: { kind: 'worker' } }),
     400, 'POST /message with {kind:worker} and no id is 400');
  eq(await postStatus(portP, '/message', { text: 'x', idempotencyKey: 'p-ghost', recipient: { kind: 'worker', id: 'ghost' } }),
     400, 'POST /message with an unknown worker id is 400');

  // --- omitted → 200, defaults to the lead (recipient absent == the lead, §8.2) ---
  const pOmit = await post(portP, '/message', { text: 'to the lead by default', idempotencyKey: 'p-omit' });
  ok(pOmit.ok === true, 'POST /message with NO recipient is accepted (200)');
  const pOmitMsg = (await j<MessagesReply>(portP, `/messages?room=${P}`)).messages.find((m) => m.id === 'p-omit');
  ok(!!pOmitMsg, 'the omitted-recipient Send is stored');
  ok(pOmitMsg && (pOmitMsg.recipient == null || pOmitMsg.recipient.kind === 'lead'),
     'the omitted-recipient Send defaults to the lead (recipient absent or kind:lead)');

  // --- explicit valid recipients → 200 ---
  ok((await post(portP, '/message', { text: 'to lead', idempotencyKey: 'p-lead', recipient: { kind: 'lead' } })).ok === true,
     'POST /message with {kind:lead} is accepted');
  ok((await post(portP, '/message', { text: 'to all', idempotencyKey: 'p-bcast', recipient: { kind: 'broadcast' } })).ok === true,
     'POST /message with {kind:broadcast} is accepted');
  ok((await post(portP, '/message', { text: 'to w1', idempotencyKey: 'p-w1', recipient: { kind: 'worker', id: 'worker-1' } })).ok === true,
     'POST /message to a registered worker is accepted');

  // The rejected (malformed) Sends must never have been stored — 400 before appendMessage.
  const pIds = new Set((await j<MessagesReply>(portP, `/messages?room=${P}`)).messages.map((m) => m.id));
  ok(!pIds.has('p-str') && !pIds.has('p-kind') && !pIds.has('p-noid') && !pIds.has('p-ghost'),
     'no malformed-recipient Send was stored (the 400 fires before the message is appended)');
  srvP.kill('SIGTERM'); await sleep(1300);

  // ============================================================================
  // [v9.1 #53] Teardown seam — request → /pending teardown item → clears on consume → /done
  // ============================================================================
  // The operator's confirm-gated close-session control posts a distinct teardown-request (a CONTROL
  // signal, not a chat Message). The bridge holds a per-room teardown-requested flag, exposes it on
  // /canvas-status, and hands it to the LEAD's GET /pending pull as a teardown item — the
  // same signal-not-act pattern as a revive directive: the bridge raises it, the lead performs the
  // graceful POST /done. This whole seam is new in v9.1 (no /request-teardown endpoint, no
  // teardownRequested field, no teardown branch exist pre-v9.1), so every assertion below depends on
  // the server lane's #53 delta and fails until it lands — expected, per SPEC §12.
  console.log('\n[v9.1 #53 teardown] /request-teardown surfaces a teardown directive that clears on consume');
  const srvT = boot(T);
  const portT = await srvT._port;

  // baseline: nothing requested, and no chat messages yet.
  const st0 = await j<CanvasStatus>(portT, '/canvas-status');
  ok(!st0.teardownRequested, '/canvas-status reports teardownRequested falsy before any request');
  const msgs0 = (await j<MessagesReply>(portT, `/messages?room=${T}`)).messages.length;

  // the operator presses the close-session control → a distinct teardown-request intake.
  eq(await postStatus(portT, '/request-teardown', { room: T }),
     200, 'POST /request-teardown returns 200');
  const st1 = await j<CanvasStatus>(portT, '/canvas-status');
  eq(st1.teardownRequested, true, '/canvas-status exposes teardownRequested:true after the request');

  // it is a control signal, NOT a chat Message — the attributed log is unchanged (§8.2 v9.1).
  const msgs1 = (await j<MessagesReply>(portT, `/messages?room=${T}`)).messages.length;
  eq(msgs1, msgs0, 'the teardown-request did not enter the chat log (it is a control signal, not a Message)');

  // the lead's pull returns the teardown item. No pending lead Send and no worker needing revive,
  // so teardown is the only item the pull can return.
  const tdir = (await leadPull(portT)).find(isTeardown);
  ok(isTeardown(tdir), 'the lead pull returns a teardown item (kind:"teardown")');

  // the flag CLEARS on consume — status flips back and a second pull does not re-issue (no storm).
  const st2 = await j<CanvasStatus>(portT, '/canvas-status');
  eq(st2.teardownRequested, false, 'teardownRequested clears once the lead pull consumes the directive');
  const tdir2 = (await leadPull(portT)).find(isTeardown);
  ok(!isTeardown(tdir2), 'the teardown directive is not re-issued after it is consumed (no re-fire storm)');

  // durable floor under teardown: a teardown REQUEST must not corrupt or displace the queue — an
  // ordinary lead Send still drains normally afterward (teardown never enters a recipient queue).
  await post(portT, '/message', { text: 'still works', idempotencyKey: 't-still' });
  const drained = (await leadPull(portT)).find((i) => i.kind === 'send');
  ok(drained && drained.id === 't-still', 'an ordinary lead Send still drains after a teardown request (queue intact)');

  // the graceful close the lead performs on a teardown directive. NOTE: POST /done shuts the process
  // down (removes the lock, exits), so "the flag clears on /done" is satisfied structurally — the
  // in-memory flag dies with the process; we assert only that /done returns ok. Keep this LAST for
  // board T; the server is gone after it.
  const done = await post(portT, '/done', {});
  ok(done.ok === true, 'POST /done (the lead\'s graceful teardown) returns ok');
  await sleep(1200);
  ok(!fs.existsSync(path.join(HOME, `${T}.lock`)), 'board T lock removed by the graceful /done');

  // any straggler + clean scratch
  for (const s of [srvP, srvT]) { try { s.kill('SIGKILL'); } catch {} }
  await sleep(200);
  cleanupFiles();

  console.log(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('\nERROR', e); process.exit(1); });

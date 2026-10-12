// [v9.7 §8.5 #60] Regression test for the lost-wakeup strand.
//
// The bug (diagnosed 2026-09-25): the lead's delivery marker is stamped on WRITE, not on
// RECEIPT. A human Send handed to a parked lead waiter whose socket is half-open (client frozen
// by a laptop sleep/wake — no FIN reaches the server, so req.on('close') never fires) is marked
// deliveredAt/deliveredBy + leased, but the bytes never reach the client. Because the lead lease
// is reclaimed only when the SESSION is confirmed dead (sweepDeadLead), and the session re-arms a
// fresh waiter (staying "alive"), the Send is stranded 'working' forever and skipped by
// nextPendingFor on every later poll — the operator must send a second message to get a response.
//
// The FIX: poll.sh acknowledges receipt (POST /instruction-received {id}) before it exits on a
// 200, so a delivered-but-un-received lead receipt is distinguishable from a handled one. When the
// SAME session re-arms a fresh lead waiter while holding an un-received receipt, the prior socket's
// delivery is proven lost — the receipt is reclaimed and re-served to the fresh poll.
//
// This test simulates the frozen client with a raw net.Socket that connects, sends the
// long-poll GET, and then NEVER READS — the connection stays ESTABLISHED (no FIN), exactly the
// half-open condition req.on('close') cannot catch. It asserts the restored invariant: a Send the
// lead never consumed must NOT read 'working' and MUST re-serve to the next lead poll.
//
//   node tests/whiteboard/lost-wakeup.test.mjs

import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { sandbox, startServer, stopAllServers } from './harness.mjs';

const SB = sandbox('lost-wakeup');


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

// --- boot a bridge in this suite's own throwaway repository -----------------
const boot = (board, extraEnv = {}) => startServer(SB, SB.board(board), extraEnv);

const j = (port, p, init) => fetch(`http://127.0.0.1:${port}${p}`, init).then((r) => r.json());
const post = (port, p, body) =>
  j(port, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function messagesState(port, id) {
  const { messages } = await j(port, '/messages');
  const row = (messages ?? []).find((m) => m.id === id);
  return row ? row.state : undefined;
}
async function messageRow(port, id) {
  const { messages } = await j(port, '/messages');
  return (messages ?? []).find((m) => m.id === id);
}

// Open a FROZEN lead long-poll: a raw socket that sends the GET and never reads the response.
// The connection stays ESTABLISHED (no FIN), so the server's req.on('close') never fires — the
// exact half-open condition the bug needs. Returns the socket so the test can hold or destroy it.
function frozenPoll(port, sessionId, { supervise = true } = {}) {
  const sock = net.connect(port, '127.0.0.1');
  sock.on('error', () => {}); // ignore RST/ECONNRESET on teardown
  const q = new URLSearchParams({ for: 'lead', sessionId });
  if (supervise) q.set('supervise', '1');
  sock.write(
    `GET /next-instruction?${q} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`,
  );
  // Deliberately attach NO 'data' handler: the socket stays in paused mode, bytes the server
  // writes accumulate unread, and the connection never closes on its own.
  return sock;
}

// A NORMAL long-poll via fetch: reads the body and resolves it (200 → payload, 204 → null),
// or null if it times out client-side (nothing delivered). Mirrors a poll.sh cycle that reads.
async function readingPoll(port, sessionId, { ms = 2500, supervise = true } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const q = new URLSearchParams({ for: 'lead', sessionId });
  if (supervise) q.set('supervise', '1');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/next-instruction?${q}`, { signal: ac.signal });
    if (r.status === 204) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function main() {
  // Grace windows kept SHORT so this test is fast, but the strand it reproduces is a
  // live-session strand (the holder re-arms and stays alive), so the outcome does not depend on
  // the death sweep firing — it is the receipt seam that must catch it.
  const server = boot('wbtest_lostwake', {
    WHITEBOARD_STALL_MS: '2000',
    WHITEBOARD_SWEEP_MS: '500',
    WHITEBOARD_LEAD_GRACE_MS: '60000', // long: the lead is NOT dead — it re-armed and stays alive
  });
  const port = await server._port;
  try {
    // Register the lead session (realistic: presence + lastSeenBySession seeded).
    const reg = await post(port, '/session/register', { name: 'Lead', clientKey: 'lead' });
    const sid = reg.sessionId;
    ok(typeof sid === 'string' && sid, 'lead session registered');

    console.log('\n[SCENARIO] frozen lead waiter loses a delivery, then re-arms');

    // 1) Park a FROZEN lead waiter (connects, sends GET, never reads).
    const s1 = frozenPoll(port, sid);
    let parked = false;
    for (let i = 0; i < 30 && !parked; i++) {
      await sleep(100);
      parked = (await j(port, '/canvas-status')).agentParked === true;
    }
    ok(parked, 'frozen lead waiter is parked (agentParked)');

    // 2) Operator sends Msg1 → delivered to the frozen waiter (bytes lost, lease committed).
    const m1 = await post(port, '/message', { text: 'Msg1 — long feedback', idempotencyKey: 'msg1' });
    ok(m1.ok === true, 'Msg1 accepted');
    await sleep(300);

    // The frozen socket is still open, so req.on('close') has NOT fired: the delivery was "made"
    // on write but never received. This is the moment the marker is stamped on write.
    eq(await messagesState(port, 'msg1'), 'working', 'Msg1 shows working after the lost delivery (the bug\'s stuck badge)');

    // 3) The frozen client's curl eventually times out and poll.sh RE-ARMS a fresh waiter with the
    //    SAME sessionId. In the bug, the fresh poll skips Msg1 (leased) and parks — Msg1 stranded.
    //    In the fix, the re-arm is proof the prior socket is gone with no receipt, so Msg1 is
    //    reclaimed and re-served to this very poll.
    s1.destroy(); // curl gives up (client-side max-time); the fresh poll is the re-arm below
    const rearm = await readingPoll(port, sid, { ms: 3000 });

    ok(rearm !== null, 'INVARIANT: the re-armed lead poll receives a Send (not a 204 strand)');
    if (rearm) eq(rearm.id, 'msg1', 'INVARIANT: the re-armed poll receives the LOST Msg1 (re-served, not skipped)');

    // 4) The operator must NOT need a second message: Msg1 itself came back. Complete it and
    //    confirm it retires cleanly.
    if (rearm && rearm.id === 'msg1') {
      const done = await post(port, '/instruction-complete', { id: 'msg1', for: 'lead' });
      ok(done.ok === true, 'Msg1 completes via /instruction-complete');
      eq(await messagesState(port, 'msg1'), 'done', 'Msg1 reads done after completion');
    }

    // ---- Normal path must not regress: a delivery that IS received must not double-serve ----
    console.log('\n[GUARD] a received Send does not busy-loop on re-arm');
    // Park a reading poll, send Msg2, the poll receives it (200) and acks receipt like poll.sh.
    const p2 = readingPoll(port, sid, { ms: 3000 });
    await sleep(200);
    await post(port, '/message', { text: 'Msg2', idempotencyKey: 'msg2' });
    const got2 = await p2;
    ok(got2 && got2.id === 'msg2', 'Msg2 delivered to the reading poll');
    // Simulate poll.sh's receipt ack (poll.sh POSTs this before exiting on a 200).
    await post(port, '/instruction-received', { id: 'msg2', for: 'lead' }).catch(() => ({}));
    // Re-arm (relaunch): a received Msg2 must NOT be re-served — the poll should long-poll empty.
    const rearm2 = await readingPoll(port, sid, { ms: 1500 });
    ok(rearm2 === null, 'a received-and-acked Msg2 is NOT re-served on re-arm (no busy-loop)');
    eq(await messagesState(port, 'msg2'), 'working', 'Msg2 stays working (received, being handled) until completed');
    await post(port, '/instruction-complete', { id: 'msg2', for: 'lead' });

    // ---- The delivery nonce: a STALE ack (for a superseded delivery) must not strand a fresh one ----
    console.log('\n[GUARD] a stale receipt ack (wrong deliveredAt nonce) does not immunize a lost delivery');
    const s3 = frozenPoll(port, sid);
    await sleep(300);
    await post(port, '/message', { text: 'Msg3', idempotencyKey: 'msg3' });
    await sleep(300);
    const d1 = (await messageRow(port, 'msg3'))?.deliveredAt;
    ok(typeof d1 === 'number', 'Msg3 delivered to the frozen waiter (has a deliveredAt nonce)');
    // A stale ack naming a DIFFERENT delivery nonce must be a no-op (staleDelivery), not a receipt.
    const stale = await post(port, '/instruction-received', { id: 'msg3', for: 'lead', deliveredAt: (d1 ?? 0) - 999 });
    ok(stale.staleDelivery === true, 'the mismatched-nonce ack is rejected as stale (not recorded as received)');
    // So the re-arm still treats Msg3 as un-received and re-serves it — the nonce closed the race.
    s3.destroy();
    const rearm3 = await readingPoll(port, sid, { ms: 3000 });
    ok(rearm3 && rearm3.id === 'msg3', 'Msg3 is still re-served after the stale ack (the delivery nonce prevented false immunity)');
  } finally {
    await stopAllServers();
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) { for (const f of failures) console.log(`  FAILED: ${f}`); process.exitCode = 1; }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await stopAllServers(); process.exit(process.exitCode ?? 0); });

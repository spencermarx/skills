// Pull delivery: the lead's long-poll on GET /pending?wait=<ms>, for a harness with no inbox to ring.
// Headless (WHITEBOARD_NO_CANVAS), no inbox socket, in a throwaway repository. Exit 0 = all pass.
//
//   1. The mode: with no inbox, /canvas-status reads doorbell.mode "pull".
//   2. A parked wait is answered at once by a Send, by the operator's close, and by a worker's revive.
//   3. A wait with nothing pending times out with {"items":[]}; wait=0 and a negative wait answer at
//      once; a wait that hangs up is no longer parked, and the Send it would have taken stays unfetched.
//   4. "Not heard": a Send stays queued while the lead has pulled within WHITEBOARD_PULL_GRACE_MS,
//      reads not-heard (reason not-listening) once it has not, and the next pull still fetches it.
//   5. ?all=1 hands back a fetched, uncompleted Send marked refetch, and answers at once.
//
//   node --import tsx tests/whiteboard/pull.test.mjs   (cwd: the skill's server/)

import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { sandbox, startServer, stopAllServers } from './harness.mjs';

const SB = sandbox('pull');
const GRACE_MS = 1500;

let passed = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failures.push(msg); console.log(`  ✗ ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function request(port, { method = 'GET', path, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body === undefined ? {} : { 'content-type': 'application/json' };
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
const get = (port, path) => request(port, { path });
const post = (port, path, body) => request(port, { method: 'POST', path, body });

// A GET /pending that reports how long it took to answer.
function timedPending(port, sid, query) {
  const t0 = Date.now();
  return get(port, `/pending?sessionId=${sid}${query}`).then((r) => ({ ...r, ms: Date.now() - t0 }));
}
// Whether a promise has settled after `ms`.
async function settledWithin(promise, ms) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await sleep(ms);
  return done;
}

async function main() {
  const server = startServer(SB, SB.board('pull'), {
    WHITEBOARD_PULL_GRACE_MS: String(GRACE_MS),
    WHITEBOARD_DOORBELL_TICK_MS: '100',
    WHITEBOARD_REVIVE_QUIET_MS: '200',
  });
  const port = await server.port;
  const { sessionId: sid } = (await post(port, '/session/register', { name: 'Lead', clientKey: 'lead' })).body;
  ok(typeof sid === 'string' && sid.length > 0, 'the lead registers');

  console.log('\n[1] the mode');
  const status = (await get(port, '/canvas-status')).body;
  eq(status.doorbell.mode, 'pull', 'no inbox: doorbell.mode is pull');
  eq(status.doorbell.inbox, false, 'and no inbox is configured');

  console.log('\n[2] a parked wait is answered at once');
  {
    const parked = timedPending(port, sid, '&wait=8000');
    ok(!(await settledWithin(parked, 300)), 'with nothing pending, the wait parks');
    eq((await get(port, '/canvas-status')).body.doorbell.leadWaiting, true, '/canvas-status shows the lead waiting');
    await post(port, '/message', { text: 'draw a box', idempotencyKey: 'pull-send-1' });
    const r = await parked;
    eq(r.status, 200, 'the wait answers 200');
    eq(r.body.items.length, 1, 'with one item');
    eq(r.body.items[0]?.kind, 'send', 'a Send');
    eq(r.body.items[0]?.instruction, 'draw a box', 'carrying the operator\'s words');
    ok(r.ms < 2500, `as soon as it was posted (${r.ms} ms, of an 8000 ms wait)`);
    await post(port, '/instruction-complete', { id: 'pull-send-1', sessionId: sid });
  }
  {
    const parked = timedPending(port, sid, '&wait=8000');
    await sleep(200);
    await post(port, '/request-teardown', {});
    const r = await parked;
    eq(r.body.items[0]?.kind, 'teardown', 'the operator\'s close answers a parked wait');
    ok(r.ms < 2500, `at once (${r.ms} ms)`);
  }
  {
    const { sessionId: wsid } = (await post(port, '/session/register', { name: 'W1', clientKey: 'worker-1' })).body;
    ok(typeof wsid === 'string', 'a worker registers');
    const parked = timedPending(port, sid, '&wait=8000');
    await sleep(100);
    eq((await post(port, '/message', { text: 'for the worker', recipient: { kind: 'worker', id: 'worker-1' }, idempotencyKey: 'pull-worker-1' })).status, 200, 'a Send to the worker is stored');
    const r = await parked;
    eq(r.body.items[0]?.kind, 'revive', 'a worker that is not polling becomes a revive on the parked wait');
    eq(r.body.items[0]?.revive, 'worker-1', 'naming the worker');
    ok(r.ms < 3000, `once the worker is quiet (${r.ms} ms)`);
    // The worker takes its Send, so nothing about it is pending for the rest of the suite.
    const taken = await get(port, `/next-instruction?for=worker-1&sessionId=${wsid}`);
    eq(taken.status, 200, 'the worker takes its Send');
    await post(port, '/instruction-complete', { id: 'pull-worker-1', for: 'worker-1', sessionId: wsid });
  }

  console.log('\n[3] timeouts and hang-ups');
  {
    const r = await timedPending(port, sid, '&wait=600');
    eq(JSON.stringify(r.body), '{"items":[]}', 'a wait with nothing pending times out with {"items":[]}');
    ok(r.ms >= 550 && r.ms < 2500, `after the wait (${r.ms} ms)`);
    const now = await timedPending(port, sid, '&wait=0');
    ok(now.ms < 500 && now.body.items.length === 0, `wait=0 answers at once (${now.ms} ms)`);
    const negative = await timedPending(port, sid, '&wait=-5000');
    ok(negative.ms < 500, `a negative wait answers at once (${negative.ms} ms)`);
  }
  {
    const req = http.get({ host: '127.0.0.1', port, path: `/pending?sessionId=${sid}&wait=8000` });
    req.on('error', () => {});
    await sleep(300);
    eq((await get(port, '/canvas-status')).body.doorbell.leadWaiting, true, 'a raw wait is parked');
    req.destroy();
    await sleep(300);
    eq((await get(port, '/canvas-status')).body.doorbell.leadWaiting, false, 'a wait that hangs up is no longer parked');
    await post(port, '/message', { text: 'after the hang-up', idempotencyKey: 'pull-send-2' });
    await sleep(300);
    const items = (await get(port, '/canvas-status')).body.doorbell.items;
    eq(items.find((i) => i.id === 'pull-send-2')?.state, 'queued', 'the Send it would have taken stays unfetched');
    const r = await get(port, `/pending?sessionId=${sid}`);
    eq(r.body.items[0]?.id, 'pull-send-2', 'and the next pull fetches it');
    await post(port, '/instruction-complete', { id: 'pull-send-2', sessionId: sid });
  }

  console.log('\n[4] not heard');
  {
    await get(port, `/pending?sessionId=${sid}`); // the lead has just pulled
    await post(port, '/message', { text: 'while it is busy', idempotencyKey: 'pull-send-3' });
    await sleep(500);
    let item = (await get(port, '/canvas-status')).body.doorbell.items.find((i) => i.id === 'pull-send-3');
    eq(item?.state, 'queued', 'a Send stays queued while the lead pulled within the grace');
    await sleep(GRACE_MS + 400);
    item = (await get(port, '/canvas-status')).body.doorbell.items.find((i) => i.id === 'pull-send-3');
    eq(item?.state, 'not-heard', 'it reads not-heard once the lead has not pulled within the grace');
    eq(item?.reason, 'not-listening', 'with the reason not-listening');
    const logged = (await get(port, '/messages')).body.messages.find((m) => m.id === 'pull-send-3');
    eq(logged?.state, 'not-heard', 'the panel\'s log shows it not heard');
    const lead = (await get(port, '/canvas-status')).body.agents.find((a) => a.id === 'lead');
    eq(lead?.lifecycle, 'not-heard', 'and the lead\'s roster row reads not-heard');
    const r = await get(port, `/pending?sessionId=${sid}`);
    eq(r.body.items[0]?.id, 'pull-send-3', 'the next pull still fetches it');
  }

  console.log('\n[5] ?all=1');
  {
    const r = await timedPending(port, sid, '&all=1&wait=8000');
    const again = r.body.items.find((i) => i.id === 'pull-send-3');
    eq(again?.refetch, true, 'a fetched, uncompleted Send comes back marked refetch');
    ok(r.ms < 500, `at once, though a wait was asked (${r.ms} ms)`);
    await post(port, '/instruction-complete', { id: 'pull-send-3', sessionId: sid });
    const after = await timedPending(port, sid, '&all=1&wait=400');
    eq(after.body.items.length, 0, 'once completed, nothing comes back');
  }
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

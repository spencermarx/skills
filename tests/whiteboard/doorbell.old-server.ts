// Test-only child for doorbell.test.ts (`fakeOldServer`, [#65]): a live process answering
// `/canvas-status` the way a board server from before #64 does. DOORBELL_OLD_ANSWER is the JSON
// body it answers there (every other path answers `{}`); the body `null` makes it accept every
// request and never answer, as a server in #63's EPIPE loop does. It prints `PORT=<port>` once
// listening on an ephemeral loopback port.
//
//   DOORBELL_OLD_ANSWER='{"activeRoom":"x"}' node --import tsx doorbell.old-server.ts      (run from the skill's server/)

import http from 'node:http';
import type { AddressInfo } from 'node:net';

const answer = process.env.DOORBELL_OLD_ANSWER;
if (answer === undefined) {
  console.error('doorbell.old-server.ts: DOORBELL_OLD_ANSWER is not set');
  process.exit(2);
}
const srv = http.createServer((req, res) => {
  if (answer === 'null') return;
  res.setHeader('content-type', 'application/json');
  res.end(req.url === '/canvas-status' ? answer : '{}');
});
srv.listen(0, '127.0.0.1', () => console.log('PORT=' + (srv.address() as AddressInfo).port));

// Test-only child for doorbell.test.ts (`staleSocket`): leaves a Unix socket file with no listener
// behind it, as a killed session does. It listens on the path given as its one argument, then
// SIGKILLs itself, so the file is never unlinked and connecting to it is ECONNREFUSED.
//
//   node --import tsx doorbell.stale-socket.ts <socket path>      (run from server/)

import net from 'node:net';

const file = process.argv[2];
if (!file) {
  console.error('usage: node --import tsx doorbell.stale-socket.ts <socket path>');
  process.exit(2);
}
net.createServer().listen(file, () => process.kill(process.pid, 'SIGKILL'));

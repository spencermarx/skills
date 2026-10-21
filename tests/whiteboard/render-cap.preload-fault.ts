// [render-cap] Test-only preload for Phases T, U and W of render-cap.test.ts. The suite loads it into
// the server's Node process through NODE_OPTIONS (`--import tsx --import <this file's URL>`); the server
// imports nothing from it.
//
// On SIGUSR2 the process throws, from its own setImmediate, a fault with the stack of Phase P's driver
// fault (an assertion in Playwright's dispatch of a Chromium message), so it reaches the server's
// uncaughtException handler as that fault does.

const pw = '/w/server/node_modules/playwright-core/lib/coreBundle.js';
const stack = [
  'Error: Assertion error',
  `    at assert (${pw}:838:11)`,
  `    at _CRSession._onMessage (${pw}:35014:11)`,
  `    at CRConnection._onMessage (${pw}:34951:20)`,
  `    at Immediate.<anonymous> (${pw}:39453:30)`,
  '    at process.processImmediate (node:internal/timers:574:21)',
].join('\n');

process.on('SIGUSR2', () => setImmediate(() => { throw Object.assign(new Error('Assertion error'), { stack }); }));

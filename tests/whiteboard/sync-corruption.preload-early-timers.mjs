// Test-only preload for Board Q0e of sync-corruption.test.ts. The suite loads it into the server's Node
// process through NODE_OPTIONS (`--import <this file's URL>`); the server imports nothing from it.
//
// Every timer longer than 5 ms wakes 5 ms early. setTimeout counts on libuv's monotonic millisecond
// clock, which floors on a different phase from Date.now(), so a timer armed for `deadline - Date.now()`
// wakes with Date.now() a millisecond short of the deadline in about 2 of 100 runs. A timer also
// overshoots its delay by about a millisecond, so waking 5 ms early makes it short every time.

const real = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => real(fn, typeof ms === 'number' && ms > 5 ? ms - 5 : ms, ...args);

// Headless browser-global shim (SPEC §7). The bridge runs N presence-only tldraw
// sync CLIENTS in this Node process to inject one agent cursor each (see presence.ts).
// tldraw's client stack (ClientWebSocketAdapter, the reactive FpsScheduler, the
// instance-record defaults) reaches for a handful of browser globals that Node lacks.
// This module installs minimal no-op stand-ins, and MUST be imported before any
// `@tldraw/sync-core` / `@tldraw/store` client code so the globals exist first.
//
// Verified necessary against installed 5.4.2 (each threw until shimmed):
//   ClientWebSocketAdapter -> window/document .addEventListener (online/offline/visibility)
//   FpsScheduler (throttle) -> requestAnimationFrame / cancelAnimationFrame
//   TLInstance default      -> window.devicePixelRatio (read once window exists)
// Node 22 already provides `navigator` (its `connection` prop is absent, so that
// branch is skipped) and a global `WebSocket` (what the adapter constructs).

const g = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
  requestAnimationFrame?: (cb: (t: number) => void) => unknown;
  cancelAnimationFrame?: (id: unknown) => void;
};

g.window ??= {
  addEventListener() {},
  removeEventListener() {},
  devicePixelRatio: 1,
};

g.document ??= {
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
  visibilityState: 'visible',
};

g.requestAnimationFrame ??= (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
g.cancelAnimationFrame ??= (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>);

export {};

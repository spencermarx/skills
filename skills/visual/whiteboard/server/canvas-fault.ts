// Which uncaught exceptions are the render-canvas's, not the server's (SPEC §5 step 2, decision #67).
//
// Playwright reads Chromium's messages on its own timer and dispatches each one from there. When a
// page crashes while the server waits on a command to it, Playwright rejects that command, and
// Chromium's late reply to it then fails an assertion in that dispatch (`CRSession._onMessage`),
// thrown from Playwright's own stack where no caller can catch it. That fault is the canvas's: the
// server keeps serving, and hands the canvas to the launcher if it does not answer
// (handleCanvasDriverFault). A fault anywhere else is the server's.
//
// A fault is the canvas's only when all of these hold, so one with server code on its stack is not:
// - it is an Error with a stack;
// - every frame of that stack is in Playwright's package (`playwright-core`) or Node's own internals
//   (`node:internal/`), so no server code, and no listener the server registered, is on it;
// - one of those frames is Playwright's dispatch of a Chromium message (`CRSession._onMessage` or
//   `CRConnection._onMessage`);
// - the stack is whole: it has fewer frames than V8 records (`Error.stackTraceLimit`), so no server
//   frame can lie beyond the cut.
const PLAYWRIGHT = /[\\/]node_modules[\\/]playwright-core[\\/]/;
const DISPATCH = /CR(?:Session|Connection)\._onMessage \(/;

const frameLocation = (frame: string): string => {
  const inParens = frame.match(/\(([^()]*)\)\s*$/);
  return inParens ? inParens[1]! : frame.replace(/^\s*at\s+(?:async\s+)?/, '');
};

export function isCanvasDriverFault(e: unknown, stackLimit: number = Error.stackTraceLimit): boolean {
  const stack = e instanceof Error && typeof e.stack === 'string' ? e.stack : '';
  const frames = stack.split('\n').filter((line) => /^\s+at\s/.test(line));
  if (frames.length === 0 || frames.length >= stackLimit) return false;
  const ours = (frame: string): boolean => {
    const where = frameLocation(frame);
    return PLAYWRIGHT.test(where) || where.startsWith('node:internal/');
  };
  return frames.every(ours) && frames.some((frame) => DISPATCH.test(frame) && PLAYWRIGHT.test(frameLocation(frame)));
}

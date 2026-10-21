// The session-inbox client (SPEC §8.5, decision #64): the one place the board server writes to the
// owning Claude Code session's inbox socket.
//
// Each post opens a fresh connection to the Unix socket at `socketPath`, writes two
// newline-terminated JSON lines, `{"type":"auth","token":…}` then
// `{"type":"user","message":{"role":"user","content":…}}`, and closes. The inbox writes nothing back
// and gives no delivery receipt, so a resolved `{ ok: true }` means only that the bytes reached the
// socket; the receipt the board relies on is the lead's own GET /pending. A connect error (ENOENT
// when the session has exited, ECONNREFUSED when it was killed and left its socket file) resolves
// `{ ok: false, code }`. This function never throws and never logs; the token is written to the
// socket and nowhere else.
import net from 'node:net';

export type InboxPostOutcome = { ok: true } | { ok: false; code: string; message: string };

const POST_TIMEOUT_MS = 3_000;
// The inbox never closes its side; release our end this long after the bytes are flushed.
const LINGER_MS = 1_000;

export function postToInbox(socketPath: string, token: string | null, content: string): Promise<InboxPostOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: InboxPostOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const sock = net.createConnection({ path: socketPath });
    const timer = setTimeout(() => {
      sock.destroy();
      settle({ ok: false, code: 'ETIMEDOUT', message: 'inbox post timed out' });
    }, POST_TIMEOUT_MS);
    sock.on('error', (e: NodeJS.ErrnoException) => {
      settle({ ok: false, code: e.code ?? 'EINBOX', message: e.message });
    });
    sock.on('connect', () => {
      const lines: string[] = [];
      if (token) lines.push(JSON.stringify({ type: 'auth', token }));
      lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content } }));
      sock.end(`${lines.join('\n')}\n`, () => {
        settle({ ok: true });
        setTimeout(() => sock.destroy(), LINGER_MS).unref();
      });
    });
  });
}

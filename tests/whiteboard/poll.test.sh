#!/usr/bin/env bash
# Hermetic self-test for the always-listening poller (poll.sh, SPEC §8.5 [v9.1]).
#
# Proves the loop logic without the real bridge: a tiny Node mock on an ephemeral
# 127.0.0.1 port answers 204, 204, then 200 with a JSON body. The test asserts
# poll.sh SWALLOWS the two 204s (re-arms), then on the 200 PRINTS the body
# verbatim to stdout and EXITS 0 — and that it took exactly three requests to get
# there (so the re-arm loop genuinely ran twice).
#
# No install, no fixed port, no external deps beyond node + curl (both already
# required by this skill). Exit 0 = pass.
#
#   bash tests/whiteboard/poll.test.sh        (from the repository root)

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
POLL="${HERE}/../../skills/_incubating/whiteboard/server/poll.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/wb-poll-test.XXXXXX")"
PORT_FILE="${WORK}/port"
COUNT_FILE="${WORK}/count"
ACK_FILE="${WORK}/ack"
OUT_FILE="${WORK}/out"
MOCK_JS="${WORK}/mock.mjs"
BODY='{"instruction":"connect these","selection":["shape:a"],"id":"msg-1","at":1,"deliveredAt":12345,"for":"lead"}'

pass=0
fail=0
check() { if [ "$1" = "$2" ]; then pass=$((pass+1)); echo "  ok: $3"; else fail=$((fail+1)); echo "  FAIL: $3 (got [$1], want [$2])"; fi; }

cat > "$MOCK_JS" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const countFile = process.env.COUNT_FILE;
const ackFile = process.env.ACK_FILE;
const body = process.env.BODY;
const immediate = process.env.IMMEDIATE === '1'; // serve 200 on the first GET (no 204 dance)
let n = 0;
const server = http.createServer((req, res) => {
  // [v9.7 #60] The receipt ack is a POST /instruction-received the poller fires after the 200,
  // before it exits. Record it (not counted as a poll GET) so the test can assert it happened.
  if (req.method === 'POST' && req.url.startsWith('/instruction-received')) {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => {
      fs.writeFileSync(ackFile, s);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    return;
  }
  // Only the poll loop's GET /next-instruction is counted (204, 204, then 200).
  n += 1;
  fs.writeFileSync(countFile, String(n));
  if (!immediate && n < 3) {
    res.statusCode = 204;
    res.end();
  } else {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(body);
  }
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('PORT=' + server.address().port + '\n');
});
EOF

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null
  [ -n "${POLL_PID:-}" ] && kill "$POLL_PID" 2>/dev/null
  [ -n "${MOCK2_PID:-}" ] && kill "$MOCK2_PID" 2>/dev/null
  [ -n "${POLL2_PID:-}" ] && kill "$POLL2_PID" 2>/dev/null
  [ -n "${MOCK3_PID:-}" ] && kill "$MOCK3_PID" 2>/dev/null
  [ -n "${POLL3_PID:-}" ] && kill "$POLL3_PID" 2>/dev/null
  [ -n "${MOCK4_PID:-}" ] && kill "$MOCK4_PID" 2>/dev/null
  [ -n "${POLL4_PID:-}" ] && kill "$POLL4_PID" 2>/dev/null
  rm -rf "$WORK"
}

# Boot a fresh IMMEDIATE mock (serves 200 on the first GET) with a given BODY; echoes its port.
# Usage: boot_mock <count_file> <ack_file> <port_file> <body>  → prints the resolved port (or empty).
boot_mock() {
  local cf="$1" af="$2" pf="$3" body="$4" pid port line
  IMMEDIATE=1 COUNT_FILE="$cf" ACK_FILE="$af" BODY="$body" node "$MOCK_JS" > "$pf" 2>/dev/null &
  pid="$!"
  disown "$pid" 2>/dev/null || true
  echo "$pid" > "${pf}.pid"
  port=""
  for _ in $(seq 1 50); do
    if [ -s "$pf" ]; then line="$(cat "$pf")"; case "$line" in PORT=*) port="${line#PORT=}"; break;; esac; fi
    sleep 0.1
  done
  echo "$port"
}

# Run poll.sh once against a port until it exits; capture stdout/stderr to files. Sets RC.
# Usage: run_poll_once <port> <out> <err> [extra_path]  → RC holds the exit code (empty if it hung).
run_poll_once() {
  local port="$1" out="$2" err="$3" extra_path="${4:-}" pid
  if [ -n "$extra_path" ]; then
    PATH="$extra_path" WHITEBOARD_POLL_BACKOFF=0.2 WHITEBOARD_POLL_MAX_TIME=10 \
      bash "$POLL" "http://127.0.0.1:${port}" "supervise=1&sessionId=lead" > "$out" 2> "$err" &
  else
    WHITEBOARD_POLL_BACKOFF=0.2 WHITEBOARD_POLL_MAX_TIME=10 \
      bash "$POLL" "http://127.0.0.1:${port}" "supervise=1&sessionId=lead" > "$out" 2> "$err" &
  fi
  pid="$!"
  RC=""
  for _ in $(seq 1 100); do
    if ! kill -0 "$pid" 2>/dev/null; then wait "$pid"; RC="$?"; break; fi
    sleep 0.1
  done
  [ -z "$RC" ] && kill "$pid" 2>/dev/null
}
trap cleanup EXIT

echo "poll.sh self-test"

# --- boot the mock, resolve its ephemeral port ------------------------------
COUNT_FILE="$COUNT_FILE" ACK_FILE="$ACK_FILE" BODY="$BODY" node "$MOCK_JS" > "$PORT_FILE" 2>/dev/null &
MOCK_PID="$!"
disown "$MOCK_PID" 2>/dev/null || true

PORT=""
for _ in $(seq 1 50); do
  if [ -s "$PORT_FILE" ]; then
    line="$(cat "$PORT_FILE")"
    case "$line" in PORT=*) PORT="${line#PORT=}"; break;; esac
  fi
  sleep 0.1
done

if [ -z "$PORT" ]; then
  echo "  FAIL: mock server never reported a port"
  exit 1
fi
echo "  mock listening on 127.0.0.1:${PORT}"

# --- run the poller against it ----------------------------------------------
# Short backoff so an unexpected status would not stall the test; max-time is
# irrelevant here (the mock answers instantly), but bounded as a guard.
WHITEBOARD_POLL_BACKOFF=0.2 WHITEBOARD_POLL_MAX_TIME=10 \
  bash "$POLL" "http://127.0.0.1:${PORT}" "supervise=1&sessionId=lead" > "$OUT_FILE" 2>/dev/null &
POLL_PID="$!"

# The poller must exit on its own (the 200 wake). Bound the wait so a hung loop
# fails loudly instead of hanging the test.
rc=""
for _ in $(seq 1 100); do
  if ! kill -0 "$POLL_PID" 2>/dev/null; then
    wait "$POLL_PID"; rc="$?"; break
  fi
  sleep 0.1
done

if [ -z "$rc" ]; then
  echo "  FAIL: poll.sh did not exit within ~10s (re-arm loop hung?)"
  kill "$POLL_PID" 2>/dev/null
  exit 1
fi

# --- assertions -------------------------------------------------------------
check "$rc" "0" "poll.sh exits 0 on the 200"
check "$(cat "$OUT_FILE")" "$BODY" "stdout is the delivered body, verbatim"
check "$(cat "$COUNT_FILE" 2>/dev/null)" "3" "took 3 poll GETs (re-armed on both 204s before the 200)"
# [v9.7 #60] The poller acked receipt of the delivered Send (id + for) before exiting.
check "$(cat "$ACK_FILE" 2>/dev/null)" '{"id":"msg-1","for":"lead","deliveredAt":12345}' "posted the receipt ack {id,for,deliveredAt nonce} on the 200, before exit"

# --- [v9.7 #60] the receipt ack still fires when `node` is unreachable (POSIX fallback) ------
# The whole busy-loop cure hinges on the ack landing; it must not silently vanish if node is not
# on the poller's PATH. Boot a fresh mock that serves 200 immediately, run poll.sh with a PATH that
# has curl/grep/sed but NO node, and assert the grep-fallback still posts the same ack.
ACK_FILE2="${WORK}/ack2"
COUNT_FILE2="${WORK}/count2"
PORT_FILE2="${WORK}/port2"
IMMEDIATE=1 COUNT_FILE="$COUNT_FILE2" ACK_FILE="$ACK_FILE2" BODY="$BODY" node "$MOCK_JS" > "$PORT_FILE2" 2>/dev/null &
MOCK2_PID="$!"
disown "$MOCK2_PID" 2>/dev/null || true
PORT2=""
for _ in $(seq 1 50); do
  if [ -s "$PORT_FILE2" ]; then
    line2="$(cat "$PORT_FILE2")"
    case "$line2" in PORT=*) PORT2="${line2#PORT=}"; break;; esac
  fi
  sleep 0.1
done
if [ -z "$PORT2" ]; then
  echo "  FAIL: fallback mock never reported a port"; fail=$((fail+1))
else
  # A PATH with the base tools (curl/grep/sed/tail/mktemp) but NOT node → forces the grep fallback.
  PATH="/usr/bin:/bin" WHITEBOARD_POLL_BACKOFF=0.2 WHITEBOARD_POLL_MAX_TIME=10 \
    bash "$POLL" "http://127.0.0.1:${PORT2}" "supervise=1&sessionId=lead" > "${WORK}/out2" 2>/dev/null &
  POLL2_PID="$!"
  rc2=""
  for _ in $(seq 1 100); do
    if ! kill -0 "$POLL2_PID" 2>/dev/null; then wait "$POLL2_PID"; rc2="$?"; break; fi
    sleep 0.1
  done
  kill "$MOCK2_PID" 2>/dev/null
  check "$rc2" "0" "poll.sh (no node on PATH) still exits 0 on the 200"
  check "$(cat "$ACK_FILE2" 2>/dev/null)" '{"id":"msg-1","for":"lead","deliveredAt":12345}' "the node-free grep fallback still posts the receipt ack {id,for,deliveredAt}"
fi

# --- [v9.7 #60] the node-free fallback tolerates an id look-alike embedded in the instruction text ---
# poll.sh claims the LAST match of "id"/"deliveredAt" is the real top-level one even when the
# instruction string embeds a look-alike, because those fields serialize AFTER `instruction`. Prove it:
# a body whose instruction text contains "id":"evil","deliveredAt":999 must still ack the REAL top-level
# {id:msg-2,deliveredAt:777}, run with node off PATH so only the grep fallback is exercised.
BODY_LOOKALIKE='{"instruction":"set id \"id\":\"evil\",\"deliveredAt\":999 here","selection":[],"id":"msg-2","at":2,"deliveredAt":777,"for":"lead"}'
PORT4="$(boot_mock "${WORK}/count4" "${WORK}/ack4" "${WORK}/port4" "$BODY_LOOKALIKE")"
MOCK4_PID="$(cat "${WORK}/port4.pid" 2>/dev/null)"
if [ -z "$PORT4" ]; then
  echo "  FAIL: look-alike mock never reported a port"; fail=$((fail+1))
else
  run_poll_once "$PORT4" "${WORK}/out4" "${WORK}/err4" "/usr/bin:/bin"
  kill "$MOCK4_PID" 2>/dev/null
  check "$RC" "0" "poll.sh (no node) exits 0 despite an id look-alike in the instruction text"
  check "$(cat "${WORK}/ack4" 2>/dev/null)" '{"id":"msg-2","for":"lead","deliveredAt":777}' "the grep fallback acks the REAL top-level {id,deliveredAt}, not the look-alike in the instruction"
fi

# --- [v9.7 #60] the loud WARN fires when NEITHER node nor the grep fallback can build an ack ---------
# This is the anti-"degrade silently" guard: a delivered Send (has "instruction") whose id cannot be
# extracted must not vanish quietly — poll.sh must WARN on stderr and still exit 0 (it prints the body;
# the bridge's re-arm reclaim is the safety net). Force it with a body that has NO id and node off PATH.
BODY_NOID='{"instruction":"connect these","selection":["shape:a"],"at":3,"for":"lead"}'
PORT3="$(boot_mock "${WORK}/count3" "${WORK}/ack3" "${WORK}/port3" "$BODY_NOID")"
MOCK3_PID="$(cat "${WORK}/port3.pid" 2>/dev/null)"
if [ -z "$PORT3" ]; then
  echo "  FAIL: WARN-case mock never reported a port"; fail=$((fail+1))
else
  run_poll_once "$PORT3" "${WORK}/out3" "${WORK}/err3" "/usr/bin:/bin"
  kill "$MOCK3_PID" 2>/dev/null
  check "$RC" "0" "poll.sh exits 0 even when it cannot build an ack (prints the body; reclaim is the net)"
  check "$(cat "${WORK}/out3" 2>/dev/null)" "$BODY_NOID" "the delivered body is still emitted verbatim on stdout"
  if grep -q 'WARN: could not build a receipt ack' "${WORK}/err3" 2>/dev/null; then
    pass=$((pass+1)); echo "  ok: the loud WARN fires on stderr when neither node nor grep can ack (not silent)"
  else
    fail=$((fail+1)); echo "  FAIL: expected the loud WARN on stderr when no ack could be built"
  fi
  check "$(cat "${WORK}/ack3" 2>/dev/null)" "" "no ack was posted when none could be built (the WARN, not a bogus ack)"
fi

echo "---"
echo "passed=${pass} failed=${fail}"
[ "$fail" -eq 0 ] || exit 1
echo "PASS"

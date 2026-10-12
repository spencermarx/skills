#!/usr/bin/env bash
# The always-listening poller (SPEC §8.5 [v9.1], decision #48 amended).
#
# One skill-owned shell script, launched by the lead ONCE as a background job
# (a background shell call), that keeps a waiter parked on the bridge continuously. It hangs on a
# long-poll GET /next-instruction; on a 204 or a client timeout it silently
# re-opens (a re-arm, never an exit); on a 200 it prints the delivered body to
# stdout and EXITS 0. That exit is the wake: the harness re-invokes the lead's
# session and hands it this script's stdout, which the session inspects — the
# body may be the lead's own Send, a revive directive, or a teardown directive;
# the poller does not distinguish (SPEC §9, §8.5).
#
# Usage:
#   poll.sh <base-url> <query>
#     <base-url>  e.g. http://127.0.0.1:54123   (no trailing slash)
#     <query>     the query string appended after `/next-instruction?`
#                 lead:   'supervise=1&sessionId=<sid>'
#                 worker: 'for=<recipient>&sessionId=<sid>'   (workers keep the
#                         in-turn blocking self-park; this script is lead-scoped,
#                         but the contract is recipient-agnostic)
#
# stdout carries ONLY the delivered Send body (the wake payload). Every
# diagnostic goes to stderr, so the woken session parses stdout verbatim.
#
# Env overrides (defaults chosen for production; the self-test lowers them):
#   WHITEBOARD_POLL_MAX_TIME   curl --max-time seconds (default 250, just over
#                              the server's LONGPOLL_MS=240s so the client rarely
#                              beats the server's own 204)
#   WHITEBOARD_POLL_BACKOFF    seconds to wait after a transient error/unexpected
#                              status before re-arming (default 2)

set -u

MAX_TIME="${WHITEBOARD_POLL_MAX_TIME:-250}"
BACKOFF="${WHITEBOARD_POLL_BACKOFF:-2}"

if [ "$#" -ne 2 ]; then
  printf '[poll] usage: poll.sh <base-url> <query>\n' >&2
  exit 2
fi

BASE_URL="$1"
QUERY="$2"
URL="${BASE_URL}/next-instruction?${QUERY}"

BODY_FILE="$(mktemp "${TMPDIR:-/tmp}/wb-poll.XXXXXX")"
cleanup() { rm -f "$BODY_FILE"; }
trap cleanup EXIT

printf '[poll] listening on %s (max-time=%ss)\n' "$URL" "$MAX_TIME" >&2

while true; do
  # Body to a file, HTTP status to stdout of curl; -sS keeps it quiet but still
  # surfaces hard errors on stderr. A server-side 204 (LONGPOLL_MS timeout) and a
  # client-side --max-time abort (curl exit 28) are the SAME event to us: re-arm.
  http_code="$(curl -sS --max-time "$MAX_TIME" -o "$BODY_FILE" -w '%{http_code}' "$URL")"
  rc="$?"

  if [ "$rc" -eq 28 ]; then
    # Client-side long-poll cap hit before the server answered — re-open at once.
    continue
  fi

  if [ "$rc" -ne 0 ]; then
    # Connection refused / DNS / reset / interrupted: never die silently, back
    # off briefly, then re-arm. A dead bridge keeps this loop trying rather than
    # exiting (which would masquerade as a wake with an empty payload).
    printf '[poll] curl error rc=%s; retrying in %ss\n' "$rc" "$BACKOFF" >&2
    sleep "$BACKOFF"
    continue
  fi

  case "$http_code" in
    200)
      # A real Send was delivered. Emit the payload and exit — THIS is the wake.
      # [v9.4] stdout stays the body verbatim (see the header invariant); the body's
      # own first field is `reArmFirst`, the in-band relaunch reminder the woken
      # session reads before acting — no banner is added here.
      #
      # [v9.7 §8.5 #60] RECEIPT ACK. Before exiting, confirm to the bridge that this
      # delivery actually reached the consumer. This is the seam that cures the
      # lost-wakeup strand: a Send handed to a half-open socket never triggers this
      # ack, so when the same session re-arms the bridge knows the prior delivery was
      # lost and re-serves it — while a genuinely received Send (this ack) is spared.
      # Lead-scoped, and load-bearing: the ack, not just best-effort, is what stops a
      # re-arm re-serving an already-consumed Send. A *transient* miss costs a bounded
      # redelivery (one, idempotent, terminated by completion — SPEC §8.5 at-least-once);
      # a *persistent* miss (never acked) would redeliver every Send, so this must not
      # rest on a single tool: prefer a `node` JSON parse (correct for any id), fall back
      # to POSIX grep/sed when node is unreachable (the poller's PATH is not the bridge's),
      # and WARN loudly if neither can build the ack rather than degrade silently. Only a
      # real Send body (both `id` and `instruction`) is acked; a revive/teardown is not.
      ack_json="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);if(o&&typeof o.id==="string"&&o.instruction!==undefined){const a={id:o.id,for:o.for||"lead"};if(typeof o.deliveredAt==="number")a.deliveredAt=o.deliveredAt;process.stdout.write(JSON.stringify(a))}}catch{}})' < "$BODY_FILE" 2>/dev/null)"
      if [ -z "$ack_json" ] && grep -q '"instruction"' "$BODY_FILE" 2>/dev/null; then
        # Node-free fallback. Fields are server-emitted scalars; `id`/`deliveredAt`/`for`
        # all follow `instruction` in the payload, so the LAST match is the real top-level
        # one even if the instruction text contains a look-alike. A wrong id here only
        # costs a (safe) redelivery, never a strand — strictly better than no ack.
        _id="$(grep -o '"id":"[^"]*"' "$BODY_FILE" | tail -1 | sed 's/^"id":"//;s/"$//')"
        _for="$(grep -o '"for":"[^"]*"' "$BODY_FILE" | tail -1 | sed 's/^"for":"//;s/"$//')"
        _dat="$(grep -o '"deliveredAt":[0-9]\{1,\}' "$BODY_FILE" | tail -1 | sed 's/^"deliveredAt"://')"
        if [ -n "$_id" ]; then
          ack_json="{\"id\":\"${_id}\",\"for\":\"${_for:-lead}\""
          [ -n "$_dat" ] && ack_json="${ack_json},\"deliveredAt\":${_dat}"
          ack_json="${ack_json}}"
        fi
      fi
      if [ -n "$ack_json" ]; then
        curl -sS --max-time 5 -X POST -H 'content-type: application/json' \
          -d "$ack_json" "${BASE_URL}/instruction-received" >/dev/null 2>&1 || true
      elif grep -q '"instruction"' "$BODY_FILE" 2>/dev/null; then
        printf '[poll] WARN: could not build a receipt ack for a delivered Send (node and grep-fallback both failed); the bridge may redeliver it on re-arm\n' >&2
      fi
      cat "$BODY_FILE"
      exit 0
      ;;
    204)
      # Long-poll timed out with no work: a re-arm, not an exit (the whole point).
      continue
      ;;
    *)
      # 4xx/5xx (e.g. a 400 unknown recipient, a 5xx blip): unexpected, but do not
      # die silently — surface it and re-arm after a backoff.
      printf '[poll] unexpected HTTP %s from %s; retrying in %ss\n' "$http_code" "$URL" "$BACKOFF" >&2
      sleep "$BACKOFF"
      continue
      ;;
  esac
done

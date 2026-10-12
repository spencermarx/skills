#!/usr/bin/env bash
#
# Find, install, or start the whiteboard's runtime: the tldraw app (built once) and the
# bridge server with its headless Chromium.
#
#   whiteboard.sh status  [--repo DIR] [--scratch DIR]   is it installed, and where
#   whiteboard.sh install [--repo DIR] [--scratch DIR]   install it (no prompt: ask first)
#   whiteboard.sh path    [--repo DIR] [--scratch DIR]   print the runtime dir, or fail
#   whiteboard.sh locate  (--board FILE | --name NAME) [--repo DIR] [--scratch DIR]
#                                                        print the board's identity and live lock
#   whiteboard.sh start   (--board FILE | --name NAME) [--detach] [--repo DIR] [--scratch DIR]
#                                                        run the board's server (--detach: in the
#                                                        background; wait until it is live)
#
# Boards: the boards folder is <repo>/<scratch>/whiteboard/. A board is its .tldr file, anywhere
# in the repository; its room id derives from the file's canonical path, and its lock, chat log,
# render and server log always live in the boards folder, named by that room id. `--name NAME`
# names the board <boards folder>/<slug of NAME>.tldr, by the same slug rule the panel's "new
# board" uses. `locate` prints {board, name, room, lock, messages, png, log, live} as JSON, where
# `live` is the lock of a running server that holds the board, else null.
#
# `start` refuses a board outside the repository and the boards folder before it creates anything,
# then creates the boards folder and appends all further output to the board's log. It refuses a
# board a live server already holds; attach to that server instead. `start --detach` starts the
# server in the background, detached from the caller, waits until it is live, and prints the
# board's `locate` JSON; on a failure it prints the end of the board's log.
#
# Runtime location, in order of preference:
#   1. this skill's own folder (app/ and server/), when it is writable;
#   2. <repo>/<scratch>/whiteboard-runtime/, a copy of app/ and server/, when it is not (a
#      plugin cache can be read-only). The scratch folder defaults to .scratchpad.
# An install counts only when both node_modules were installed from the skill's current
# lockfiles and the app was built from its current sources, so a skill update asks for a fresh
# install; `install` then redoes only the steps that are stale.
#
# Exit codes:
#   0  installed (status, path); installed (install); located (locate, live or not); the board is
#      live (start --detach, its locate JSON on stdout); the server exited cleanly (start)
#   1  a precondition failed (Node.js or npm missing or too old), the server could not load the
#      board, or a detached server did not come up (the end of its log is on stderr)
#   2  a bad argument, or a board that is not a .tldr file inside the repository or the boards
#      folder, or whose folder does not exist (refused before anything is created)
#   3  not installed (status prints what install would run; start refuses)
#   4  the board is already live (start); attach to the server its JSON names
#
# Never prompts. The skill asks the person before calling `install`: it downloads the npm
# packages and Playwright's Chromium (about 150 MB).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
readonly SKILL_DIR
readonly MIN_NODE="22.12.0"
# How long `start --detach` waits for the server to come up.
readonly DETACH_WAIT_S="${WHITEBOARD_START_WAIT_S:-60}"

usage() {
  sed -n '3,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
cmd="$1"
shift

repo=""
scratch=".scratchpad"
board=""
name=""
detach=0
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a directory}"; shift 2 ;;
    --scratch) scratch="${2:?--scratch needs a directory}"; shift 2 ;;
    --board) board="${2:?--board needs a file}"; shift 2 ;;
    --name) name="${2:?--name needs a board name}"; shift 2 ;;
    --detach) detach=1; shift ;;
    -h | --help) usage ;;
    *) echo "whiteboard.sh: unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$repo" ]; then
  repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
# Physical paths throughout: npm ci --prefix misreads the lockfile when the prefix runs
# through a symlink (macOS /tmp is one).
repo="$(cd "$repo" && pwd -P)"
case "$scratch" in
  /*) scratch_dir="$scratch" ;;
  *) scratch_dir="$repo/${scratch%/}" ;;
esac
readonly FALLBACK_DIR="$scratch_dir/whiteboard-runtime"
readonly BOARDS_DIR="$scratch_dir/whiteboard"

need_board() { # exactly one of --board (a .tldr file) and --name
  if [ -n "$board" ] && [ -n "$name" ]; then
    echo "whiteboard.sh: $cmd takes --board or --name, not both" >&2; exit 2
  fi
  [ -n "$board" ] || [ -n "$name" ] || {
    echo "whiteboard.sh: $cmd needs --board <path to the board's .tldr> or --name <board name>" >&2; exit 2
  }
  if [ -n "$board" ]; then
    case "$board" in
      *.tldr) ;;
      *) echo "whiteboard.sh: a board is a .tldr file, not $board" >&2; exit 2 ;;
    esac
  fi
}

need_node() {
  command -v node >/dev/null 2>&1 || { echo "whiteboard.sh: node is required. Install Node.js (>= $MIN_NODE), then retry." >&2; exit 1; }
}

# The board's identity as JSON (boards.mjs). Exit 0, 4 when a live server holds it, or 2 when it
# is not a board inside the repository or the boards folder. Creates nothing.
locate_board() {
  if [ -n "$board" ]; then
    node "$SKILL_DIR/server/boards.mjs" --board "$board" --home "$BOARDS_DIR" --repo "$repo"
  else
    node "$SKILL_DIR/server/boards.mjs" --name "$name" --home "$BOARDS_DIR" --repo "$repo"
  fi
}

json_field() { # json_field <json> <field>
  node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]] ?? ""))' "$1" "$2"
}

sources_hash() { # one hash over a runtime's app/ and server/ sources, build output and deps excluded
  (cd "$1" && find app server -type f -not -path '*/node_modules/*' -not -path 'app/dist/*' -print0 \
    | LC_ALL=C sort -z | xargs -0 shasum | shasum | awk '{print $1}')
}

deps_in() { # a part's node_modules was installed from the skill's current lockfile
  cmp -s "$1/node_modules/.whiteboard-installed-lock" "$SKILL_DIR/$(basename "$1")/package-lock.json"
}

installed_in() {
  local dir="$1" part
  for part in app server; do deps_in "$dir/$part" || return 1; done
  [ -x "$dir/server/node_modules/.bin/tsx" ] || return 1
  [ -f "$dir/app/dist/index.html" ] || return 1
  [ "$(cat "$dir/app/dist/.sources-hash" 2>/dev/null)" = "$(sources_hash "$SKILL_DIR")" ] || return 1
  chromium_in "$dir"
}

chromium_in() { # Playwright's Chromium, as the server's own playwright resolves it
  (cd "$1/server" && node --input-type=module -e '
    const { chromium } = await import("playwright");
    const { existsSync } = await import("node:fs");
    process.exit(existsSync(chromium.executablePath()) ? 0 : 1);' 2>/dev/null)
}

writable() {
  local probe="$1/.whiteboard-write-probe.$$"
  ( : > "$probe" ) 2>/dev/null && rm -f "$probe"
}

current_install() {
  if installed_in "$SKILL_DIR"; then echo "$SKILL_DIR"; return 0; fi
  if installed_in "$FALLBACK_DIR"; then echo "$FALLBACK_DIR"; return 0; fi
  return 1
}

target_dir() {
  if writable "$SKILL_DIR/app" && writable "$SKILL_DIR/server"; then echo "$SKILL_DIR"; else echo "$FALLBACK_DIR"; fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "whiteboard.sh: node and npm are required (node >= $MIN_NODE). Install Node.js, then retry." >&2
    return 1
  fi
  local have
  have="$(node -p 'process.versions.node')"
  if ! node -e '
    const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1); }
  ' "$have" "$MIN_NODE"; then
    echo "whiteboard.sh: node $have is too old; the app's build needs node >= $MIN_NODE." >&2
    return 1
  fi
}

install_commands() {
  printf '  npm ci --prefix "%s/server" --no-audit --no-fund\n' "$1"
  printf '  npm ci --prefix "%s/app" --no-audit --no-fund\n' "$1"
  printf '  (cd "%s/server" && npx playwright install chromium)    # downloads Chromium, about 150 MB\n' "$1"
  printf '  npm --prefix "%s/app" run build\n' "$1"
}

run_step() {
  echo "running: $*"
  if ! "$@"; then
    echo "whiteboard.sh: this step failed. Run it yourself to see the full error:" >&2
    echo "  $*" >&2
    exit 1
  fi
}

readonly NOT_INSTALLED="whiteboard.sh: the whiteboard runtime is not installed. Run: whiteboard.sh status"

case "$cmd" in
  status)
    check_node || exit 1
    if dir="$(current_install)"; then
      echo "installed: $dir"
      exit 0
    fi
    target="$(target_dir)"
    echo "not installed."
    if [ "$target" = "$FALLBACK_DIR" ]; then
      echo "This skill's folder is read-only, so the install goes to $FALLBACK_DIR"
      echo "(app/ and server/ are copied there first)."
    fi
    echo "install would run:"
    install_commands "$target"
    exit 3
    ;;
  path)
    current_install || {
      echo "$NOT_INSTALLED" >&2
      exit 3
    }
    ;;
  install)
    check_node
    if dir="$(current_install)"; then
      echo "already installed: $dir"
      exit 0
    fi
    target="$(target_dir)"
    if [ "$target" = "$FALLBACK_DIR" ]; then
      echo "this skill's folder is read-only; installing into $FALLBACK_DIR instead."
      mkdir -p "$FALLBACK_DIR"
      rm -rf "$FALLBACK_DIR/app/src" "$FALLBACK_DIR/server"/*.ts
      (cd "$SKILL_DIR" && find app server -type f -not -path '*/node_modules/*' -not -path 'app/dist/*' -print0 \
        | while IFS= read -r -d '' f; do mkdir -p "$FALLBACK_DIR/$(dirname "$f")"; cp "$f" "$FALLBACK_DIR/$f"; done)
      printf '*\n' > "$FALLBACK_DIR/.gitignore"
    fi
    # Each step runs only when what it produces is missing or stale, so a source-only update
    # costs a rebuild, not a fresh download.
    for part in server app; do
      if deps_in "$target/$part"; then
        echo "$part dependencies: up to date"
      else
        run_step npm ci --prefix "$target/$part" --no-audit --no-fund
        cp "$SKILL_DIR/$part/package-lock.json" "$target/$part/node_modules/.whiteboard-installed-lock"
      fi
    done
    if chromium_in "$target"; then echo "chromium: present"
    else (cd "$target/server" && run_step npx --no-install playwright install chromium); fi
    run_step npm --prefix "$target/app" run build
    sources_hash "$SKILL_DIR" > "$target/app/dist/.sources-hash"
    echo "installed: $target"
    ;;
  locate)
    need_board
    need_node
    locate_board || { rc=$?; [ "$rc" -eq 4 ] || exit "$rc"; }
    ;;
  start)
    need_board
    need_node
    # 1. Refuse a board outside the repository (exit 2) or one already live (exit 4), creating nothing.
    where="$(locate_board)" && rc=0 || rc=$?
    if [ "$rc" -eq 4 ]; then
      echo "whiteboard.sh: this board is already live; attach to it instead of starting another server:" >&2
      echo "$where" >&2
      exit 4
    fi
    [ "$rc" -eq 0 ] || exit "$rc"
    board="$(json_field "$where" board)"
    log="$(json_field "$where" log)"
    # 2. Create the boards folder, so the board's log has somewhere to go.
    mkdir -p "$BOARDS_DIR"
    if [ "$detach" -eq 1 ]; then
      # 3. The runtime check, said in the log and to the caller.
      current_install >/dev/null || { echo "$NOT_INSTALLED" | tee -a "$log" >&2; exit 3; }
      # 4. The server, in the background with every stream away from the caller's, so it outlives
      #    the caller and the caller's own command returns. It appends to the board's log itself.
      nohup bash "$SCRIPT_DIR/whiteboard.sh" start --board "$board" --repo "$repo" --scratch "$scratch" \
        </dev/null >/dev/null 2>&1 &
      child=$!
      # 5. Wait until the board is live, then print its locate JSON.
      deadline=$((SECONDS + DETACH_WAIT_S))
      while [ "$SECONDS" -lt "$deadline" ]; do
        where="$(locate_board)" && rc=0 || rc=$?
        if [ "$rc" -eq 4 ]; then echo "$where"; exit 0; fi
        if [ -n "$child" ] && ! kill -0 "$child" 2>/dev/null; then
          code=0; wait "$child" || code=$?
          child=""
          # Exit 4: another server took the board first. Wait for it to come up and attach.
          if [ "$code" -ne 4 ]; then
            echo "whiteboard.sh: the server exited (code $code) before it was live. The end of $log:" >&2
            tail -n 20 "$log" >&2 || true
            [ "$code" -ne 0 ] && exit "$code"
            exit 1
          fi
        fi
        sleep 0.5
      done
      echo "whiteboard.sh: the server was not live after ${DETACH_WAIT_S}s. The end of $log:" >&2
      tail -n 20 "$log" >&2 || true
      exit 1
    fi
    # 3. From here every line goes to the board's log; a refusal is also said to the caller.
    exec 3>&2
    exec >>"$log" 2>&1
    echo "--- whiteboard.sh start, $(date -u +%Y-%m-%dT%H:%M:%SZ): $board"
    dir="$(current_install)" || { echo "$NOT_INSTALLED"; echo "$NOT_INSTALLED" >&3; exit 3; }
    exec 3>&-
    cd "$dir/server"
    # The server claims the board's lock exclusively before it listens, so of two starts racing
    # on one board exactly one serves it; the other exits 4.
    PORT="${PORT:-0}" WHITEBOARD_REPO="$repo" WHITEBOARD_HOME="$BOARDS_DIR" WHITEBOARD_BOARD="$board" \
      exec "$dir/server/node_modules/.bin/tsx" index.ts
    ;;
  *)
    usage
    ;;
esac

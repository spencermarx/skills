#!/usr/bin/env bash
#
# Find, install, or start the whiteboard's runtime: the tldraw app (built once) and the
# bridge server with its headless Chromium.
#
#   whiteboard.sh status  [--repo DIR] [--scratch DIR]   is it installed, and where
#   whiteboard.sh install [--repo DIR] [--scratch DIR]   install it (no prompt: ask first)
#   whiteboard.sh path    [--repo DIR] [--scratch DIR]   print the runtime dir, or fail
#   whiteboard.sh start   --board FILE [--repo DIR] [--scratch DIR]
#                                                        run the board's server in the foreground
#
# Runtime location, in order of preference:
#   1. this skill's own folder (app/ and server/), when it is writable;
#   2. <repo>/<scratch>/whiteboard-runtime/, a copy of app/ and server/, when it is not (a
#      plugin cache can be read-only). The scratch folder defaults to .scratchpad.
# An install counts only when both node_modules were installed from the skill's current
# lockfiles and the app was built from its current sources, so a skill update asks for a fresh
# install; `install` then redoes only the steps that are stale.
#
# Exit codes: 0 installed (status/path), install succeeded, or the server exited cleanly;
# 3 not installed (status prints what install would run); 1 a precondition failed, on stderr.
#
# Never prompts. The skill asks the person before calling `install`: it downloads the npm
# packages and Playwright's Chromium (about 150 MB).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
readonly SKILL_DIR
readonly MIN_NODE="22.12.0"

usage() {
  sed -n '3,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
cmd="$1"
shift

repo=""
scratch=".scratchpad"
board=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a directory}"; shift 2 ;;
    --scratch) scratch="${2:?--scratch needs a directory}"; shift 2 ;;
    --board) board="${2:?--board needs a file}"; shift 2 ;;
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

case "$cmd" in
  status)
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
    check_node || true
    exit 3
    ;;
  path)
    current_install || {
      echo "whiteboard.sh: the whiteboard runtime is not installed. Run: whiteboard.sh status" >&2
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
  start)
    [ -n "$board" ] || { echo "whiteboard.sh: start needs --board <path to the board's .tldr>" >&2; exit 2; }
    dir="$(current_install)" || {
      echo "whiteboard.sh: the whiteboard runtime is not installed. Run: whiteboard.sh status" >&2
      exit 3
    }
    mkdir -p "$(dirname "$board")"
    board="$(cd "$(dirname "$board")" && pwd -P)/$(basename "$board")"
    cd "$dir/server"
    PORT="${PORT:-0}" WHITEBOARD_REPO="$repo" WHITEBOARD_HOME="$(dirname "$board")" WHITEBOARD_BOARD="$board" \
      exec "$dir/server/node_modules/.bin/tsx" index.ts
    ;;
  *)
    usage
    ;;
esac

#!/usr/bin/env bash
#
# Find, or install, the Node dependencies a routing run needs (promptfoo and the
# Claude Agent SDK, pinned by engine/package-lock.json).
#
#   engine.sh status  [--repo DIR] [--scratch DIR]   is it installed, and where
#   engine.sh install [--repo DIR] [--scratch DIR]   install it (no prompt: ask first)
#   engine.sh path    [--repo DIR] [--scratch DIR]   print the install dir, or fail
#
# Install location, in order of preference:
#   1. this skill's own engine/ folder, when it is writable;
#   2. <repo>/<scratch>/harness-eval-engine/, when it is not (a plugin cache can
#      be read-only). The scratch folder defaults to .scratchpad.
# An install in either place is used if its lockfile matches engine/'s, so a
# skill update that changes the pins asks for a fresh install.
#
# Exit codes: 0 installed (status/path) or install succeeded; 3 not installed
# (status prints the exact command install would run); 1 a precondition failed,
# explained on stderr.
#
# Never prompts. The skill asks the person before calling `install`, because it
# downloads packages and every routing run afterwards costs money.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
ENGINE_DIR="$(cd "$SCRIPT_DIR/../engine" && pwd -P)"
readonly ENGINE_DIR
readonly MIN_NODE="22.22.0"

usage() {
  sed -n '3,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

[ $# -ge 1 ] || usage
cmd="$1"
shift

repo=""
scratch=".scratchpad"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a directory}"; shift 2 ;;
    --scratch) scratch="${2:?--scratch needs a directory}"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "engine.sh: unknown argument: $1" >&2; usage ;;
  esac
done

if [ -z "$repo" ]; then
  repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
repo="$(cd "$repo" && pwd -P)"
# Physical paths throughout: npm ci --prefix misreads the lockfile when the
# prefix runs through a symlink (macOS /tmp is one).
case "$scratch" in
  /*) scratch_dir="$scratch" ;;
  *) scratch_dir="$repo/${scratch%/}" ;;
esac
readonly FALLBACK_DIR="$scratch_dir/harness-eval-engine"

installed_in() {
  # An install counts when node_modules exists and its lockfile is engine/'s.
  local dir="$1"
  [ -d "$dir/node_modules" ] && [ -x "$dir/node_modules/.bin/promptfoo" ] \
    && cmp -s "$dir/package-lock.json" "$ENGINE_DIR/package-lock.json"
}

writable() {
  local probe="$1/.harness-eval-write-probe.$$"
  ( : > "$probe" ) 2>/dev/null && rm -f "$probe"
}

current_install() {
  if installed_in "$ENGINE_DIR"; then echo "$ENGINE_DIR"; return 0; fi
  if installed_in "$FALLBACK_DIR"; then echo "$FALLBACK_DIR"; return 0; fi
  return 1
}

target_dir() {
  if writable "$ENGINE_DIR"; then echo "$ENGINE_DIR"; else echo "$FALLBACK_DIR"; fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "engine.sh: node and npm are required (node >= $MIN_NODE). Install Node.js, then retry." >&2
    return 1
  fi
  local have
  have="$(node -p 'process.versions.node')"
  if ! node -e '
    const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1); }
  ' "$have" "$MIN_NODE"; then
    echo "engine.sh: node $have is too old; promptfoo needs node >= $MIN_NODE." >&2
    return 1
  fi
}

install_command() {
  printf 'npm ci --prefix "%s" --no-audit --no-fund\n' "$1"
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
      echo "This skill's engine/ folder is read-only, so the install goes to $FALLBACK_DIR"
      echo "(package.json and package-lock.json are copied there first)."
    fi
    echo "install would run: $(install_command "$target")"
    check_node || true
    exit 3
    ;;
  path)
    current_install || {
      echo "engine.sh: the routing engine is not installed. Run: engine.sh status" >&2
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
      mkdir -p "$FALLBACK_DIR"
      cp "$ENGINE_DIR/package.json" "$ENGINE_DIR/package-lock.json" "$FALLBACK_DIR/"
      printf 'node_modules/\nruns/\n' > "$FALLBACK_DIR/.gitignore"
      echo "engine/ is read-only; installing into $FALLBACK_DIR instead."
    fi
    command_line="$(install_command "$target")"
    echo "running: $command_line"
    if ! npm ci --prefix "$target" --no-audit --no-fund; then
      echo "engine.sh: the install failed. Run it yourself to see the full error:" >&2
      echo "  $command_line" >&2
      exit 1
    fi
    echo "installed: $target"
    ;;
  *)
    usage
    ;;
esac

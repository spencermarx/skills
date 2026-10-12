#!/usr/bin/env bash
# Export an HTML slide deck to PDF: one 16:9 screenshot per slide, assembled into a
# multi-page PDF by headless Chromium through Playwright.
#
#   export-pdf.sh check                 is the Playwright runtime ready (exit 0), or what
#                                       installing it would run (exit 3)
#   export-pdf.sh install               install it: the npm package, then Chromium
#   export-pdf.sh --input DECK.html [--output DECK.pdf] [--width 1920] [--height 1080]
#
# Never prompts and never installs on its own: an export with no runtime exits 3 and
# prints the commands. The skill shows them to the person and runs `install` only after
# they agree, because it downloads Playwright and a Chromium build (about 150 MB).
#
# The runtime lives in $CREATE_HTML_SLIDES_RUNTIME, default
# ${XDG_CACHE_HOME:-$HOME/.cache}/create-html-slides, outside any repository.
# Chromium itself goes to Playwright's per-user browser cache.
#
# Exit codes: 0 done or ready; 1 bad arguments or a failed precondition, on stderr;
# 3 the runtime is not installed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="${CREATE_HTML_SLIDES_RUNTIME:-${XDG_CACHE_HOME:-$HOME/.cache}/create-html-slides}"
# The same minor version the whiteboard skill locks, so a user with both shares one
# Chromium build in Playwright's cache.
PLAYWRIGHT_SPEC="playwright@~1.63.0"

die() { echo "export-pdf.sh: $*" >&2; exit 1; }

usage() {
  sed -n '5,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 1
}

need_node() {
  command -v node >/dev/null 2>&1 || die "Node.js 18 or newer is required and was not found on PATH."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$major" -ge 18 ]] || die "Node.js 18 or newer is required; found $(node -v)."
}

# Prints which parts are missing: "module", "browser", or nothing when ready.
missing_parts() {
  if [[ ! -f "$RUNTIME/node_modules/playwright/package.json" ]]; then
    echo module
    return
  fi
  PW_RUNTIME="$RUNTIME" node -e '
    const { createRequire } = require("module");
    const { existsSync } = require("fs");
    const req = createRequire(process.env.PW_RUNTIME + "/");
    let ok = false;
    try { ok = existsSync(req("playwright").chromium.executablePath()); } catch {}
    if (!ok) console.log("browser");
  '
}

install_commands() {
  local parts="$1"
  if [[ "$parts" == *module* ]]; then
    printf '  npm install --prefix "%s" %s\n' "$RUNTIME" "$PLAYWRIGHT_SPEC"
  fi
  printf '  "%s/node_modules/.bin/playwright" install chromium    # downloads Chromium, about 150 MB\n' "$RUNTIME"
}

not_installed() {
  echo "not installed: the PDF export needs Playwright with Chromium in $RUNTIME"
  echo "install would run:"
  install_commands "$1"
  echo "Run: export-pdf.sh install   (after the user agrees)"
  exit 3
}

cmd="${1:-}"
case "$cmd" in
  check)
    need_node
    parts="$(missing_parts)"
    [[ -z "$parts" ]] || not_installed "$parts"
    echo "ready: $RUNTIME"
    exit 0
    ;;
  install)
    need_node
    command -v npm >/dev/null 2>&1 || die "npm is required to install Playwright and was not found on PATH."
    parts="$(missing_parts)"
    if [[ -z "$parts" ]]; then echo "already installed: $RUNTIME"; exit 0; fi
    mkdir -p "$RUNTIME"
    if [[ "$parts" == *module* ]]; then
      npm install --prefix "$RUNTIME" "$PLAYWRIGHT_SPEC" >&2 || {
        echo "export-pdf.sh: the npm install failed. Run it yourself:" >&2
        install_commands "$parts" >&2
        exit 1
      }
    fi
    "$RUNTIME/node_modules/.bin/playwright" install chromium >&2 || {
      echo "export-pdf.sh: the Chromium download failed. Run it yourself:" >&2
      install_commands browser >&2
      exit 1
    }
    echo "installed: $RUNTIME"
    exit 0
    ;;
  "" | -h | --help)
    usage
    ;;
esac

INPUT=""
OUTPUT=""
WIDTH=1920
HEIGHT=1080
while [[ $# -gt 0 ]]; do
  case "$1" in
    --input | --output | --width | --height)
      [[ $# -ge 2 ]] || die "$1 needs a value."
      case "$1" in
        --input) INPUT="$2" ;;
        --output) OUTPUT="$2" ;;
        --width) WIDTH="$2" ;;
        --height) HEIGHT="$2" ;;
      esac
      shift 2
      ;;
    *) die "unknown option: $1 (run with --help)" ;;
  esac
done

[[ -n "$INPUT" ]] || die "--input is required."
[[ -f "$INPUT" ]] || die "input file not found: $INPUT"
[[ "$WIDTH" =~ ^[1-9][0-9]*$ ]] || die "--width must be a positive whole number of pixels, got: $WIDTH"
[[ "$HEIGHT" =~ ^[1-9][0-9]*$ ]] || die "--height must be a positive whole number of pixels, got: $HEIGHT"

INPUT_ABS="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="${INPUT_ABS%.html}.pdf"
fi
OUT_DIR="$(dirname "$OUTPUT")"
[[ -d "$OUT_DIR" ]] || die "output folder does not exist: $OUT_DIR"
OUTPUT_ABS="$(cd "$OUT_DIR" && pwd)/$(basename "$OUTPUT")"

need_node
parts="$(missing_parts)"
[[ -z "$parts" ]] || not_installed "$parts"

echo "Exporting $INPUT_ABS to $OUTPUT_ABS at ${WIDTH}x${HEIGHT}" >&2
PW_RUNTIME="$RUNTIME" node "$HERE/capture.mjs" "file://$INPUT_ABS" "$OUTPUT_ABS" "$WIDTH" "$HEIGHT"
echo "PDF exported to: $OUTPUT_ABS"

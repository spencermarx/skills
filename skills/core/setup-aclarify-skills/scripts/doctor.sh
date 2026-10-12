#!/usr/bin/env bash
# Reports, and on request installs, the tools the Aclarify skills use.
#
#   doctor.sh                  check everything; print one line per tool
#   doctor.sh install <tool>   install one tool (run only after the user agreed)
#   doctor.sh init-ocr <ids>   run `ocr init` for the given comma-separated tool ids
#
# Output lines are `<status> <tool> <detail>` with status ok | missing | outdated | absent,
# followed by `  install: <command>` when there is something to install. Exit status is 0
# unless the script itself was misused, so a missing tool never reads as a crash.
# Run from the repository being set up: the OCR checks look at the working directory.

set -u

OCR_PKG="@open-code-review/cli"
NODE_MIN="22.5.0"

have() { command -v "$1" >/dev/null 2>&1; }

version_ge() { # version_ge 22.11.0 22.5.0 -> true when $1 >= $2
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n1)" = "$2" ]
}

report() { # report <status> <tool> <detail> [install-command]
  printf '%-8s %-10s %s\n' "$1" "$2" "$3"
  [ -n "${4:-}" ] && printf '         install: %s\n' "$4"
  return 0
}

check_node() {
  if ! have node; then report missing node "Node.js >= $NODE_MIN is needed by ocr and the eval engine" "https://nodejs.org (or your version manager)"; return; fi
  local v; v="$(node -v | sed 's/^v//')"
  if version_ge "$v" "$NODE_MIN"; then report ok node "v$v"
  else report outdated node "v$v; ocr needs >= $NODE_MIN" "upgrade Node.js (nvm install 22, fnm install 22, or https://nodejs.org)"; fi
}

check_git() {
  if have git; then report ok git "$(git --version | awk '{print $3}')"
  else report missing git "needed by most skills" "https://git-scm.com/downloads"; fi
}

check_gh() {
  if ! have gh; then report missing gh "needed for a GitHub issue tracker, watch-ci and posting reviews" "https://cli.github.com (brew install gh)"; return; fi
  if gh auth status >/dev/null 2>&1; then report ok gh "$(gh --version | head -n1 | awk '{print $3}'), authenticated"
  else report ok gh "installed, not authenticated: the user runs \`gh auth login\`"; fi
}

check_glab() {
  if have glab; then report ok glab "$(glab --version 2>/dev/null | head -n1 | awk '{print $3}')"
  else report absent glab "only needed for a GitLab issue tracker" "https://gitlab.com/gitlab-org/cli (brew install glab)"; fi
}

check_ocr() {
  if have ocr; then report ok ocr "$(ocr --version 2>/dev/null)"
  else report missing ocr "the Open Code Review CLI, needed by ocr-review-loop" "npm install -g $OCR_PKG"; fi
  if [ -d .ocr ]; then report ok ocr-init ".ocr/ present in this repository"
  else report missing ocr-init "OCR not initialised in this repository" "ocr init --tools <ids>  (ids: claude codex cursor gemini github-copilot opencode windsurf cline kilo-code roo-code continue augment amazon-q qoder)"; fi
}

install_tool() {
  case "$1" in
    ocr)
      have npm || { echo "npm is not available; install Node.js first, then run: npm install -g $OCR_PKG" >&2; exit 1; }
      npm install -g "$OCR_PKG" || { echo "Install failed. Run it yourself: npm install -g $OCR_PKG (prefix with sudo only if your npm global prefix needs it)" >&2; exit 1; }
      ocr --version ;;
    *)
      echo "No scripted install for '$1'. Use the install line from \`doctor.sh\` output." >&2; exit 2 ;;
  esac
}

case "${1:-check}" in
  check)
    check_git; check_node; check_gh; check_glab; check_ocr ;;
  install)
    [ -n "${2:-}" ] || { echo "usage: doctor.sh install <tool>" >&2; exit 2; }
    install_tool "$2" ;;
  init-ocr)
    [ -n "${2:-}" ] || { echo "usage: doctor.sh init-ocr <comma-separated tool ids>" >&2; exit 2; }
    have ocr || { echo "ocr is not installed; run: doctor.sh install ocr" >&2; exit 1; }
    ocr init --tools "$2" ;;
  -h|--help)
    sed -n '2,12p' "$0" ;;
  *)
    echo "unknown command: $1 (try --help)" >&2; exit 2 ;;
esac

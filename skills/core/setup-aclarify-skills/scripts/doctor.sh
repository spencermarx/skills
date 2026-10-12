#!/usr/bin/env bash
# Reports, and on request installs, the tools the Aclarify skills use.
#
#   doctor.sh                  check everything; print one line per tool
#   doctor.sh install <tool>   install one tool (run only after the user agreed)
#   doctor.sh init-ocr <ids>   run `ocr init` for the given comma-separated tool ids
#   doctor.sh set-ocr-team [--force]
#                              set OCR's default review team to principal 1 + architect 1;
#                              exits 3 without changing anything when the team was customised,
#                              unless --force (run only after the user agreed to replace it)
#
# Output lines are `<status> <tool> <detail>` with status ok | missing | outdated | absent | custom,
# followed by `  install: <command>` when there is something to install. Exit status is 0
# unless the script itself was misused or a change failed, so a missing tool never reads
# as a crash.
# Run from the repository being set up: the OCR checks look at the working directory.

set -u

OCR_PKG="@open-code-review/cli"
NODE_MIN="22.5.0"
OCR_CONFIG=".ocr/config.yaml"
OCR_TEAM="architect:1 principal:1"         # the catalog default, as ocr_team prints it
OCR_STOCK_TEAM="principal:2 quality:2"     # what `ocr init` writes
OCR_TEAM_MARK="SWAP it in rather than adding a third"  # a phrase of the comment write_ocr_team writes

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
  if have ocr && [ -f "$OCR_CONFIG" ]; then
    local team; team="$(ocr_team)"
    if [ "$team" = "$OCR_TEAM" ] && grep -q "$OCR_TEAM_MARK" "$OCR_CONFIG"; then
      report ok ocr-team "principal 1 + architect 1, at most two reviewers"
    elif [ "$team" = "$OCR_TEAM" ] || [ "$team" = "$OCR_STOCK_TEAM" ]; then
      report outdated ocr-team "default team is ${team:-unreadable}; the catalog default is principal 1 + architect 1, capped at two" "scripts/doctor.sh set-ocr-team"
    else
      report custom ocr-team "default team customised (${team:-unreadable}); left as is" "scripts/doctor.sh set-ocr-team --force  (only if the user wants it replaced)"
    fi
  fi
}

ocr_team() { # the resolved default team as sorted persona:count pairs, e.g. "architect:1 principal:1"
  ocr team resolve --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try { const c = {}; for (const r of JSON.parse(s)) c[r.persona] = (c[r.persona] || 0) + 1;
            console.log(Object.keys(c).sort().map(k => `${k}:${c[k]}`).join(" ")); } catch { console.log(""); }
    });'
}

write_ocr_team() { # rewrite the default_team block of $OCR_CONFIG, keeping its other comments
  awk '
    function emit() {
      print "  # TWO reviewers, always: one principal and one architect. This outranks the"
      print "  # auto-detection table in /ocr:review Phase 3 that says to ADD reviewers for"
      print "  # auth, API, data or logic-heavy changes. If a lens fits a change better than"
      print "  # one of these, SWAP it in rather than adding a third, and fold any concern"
      print "  # only the dropped lens would catch into the remaining brief. A --team"
      print "  # override replaces this pair for that one review."
      print "  principal: 1    # Holistic review: does the change hold together"
      print "  architect: 1    # Boundaries, contracts, coupling: does the design still evolve"
      done = 1
    }
    /^default_team:/ { print; inblock = 1; pending = 1; next }
    inblock && /^[^[:space:]]/ { if (!done) emit(); inblock = 0 }
    inblock {
      if (dropping && /^  #/) next                                # the rest of an earlier copy of this comment
      dropping = 0
      if (/# TWO reviewers, always/) { dropping = 1; next }
      if (/^  [A-Za-z0-9_-]+:/ || /^    [^#[:space:]]/) next     # an active entry, or a Form 3 instance line
      if (pending) { pending = 0; if (/# Form 1/) { print; emit(); next } emit() }
    }
    { print }
    END { if (inblock && !done) emit() }
  ' "$OCR_CONFIG"
}

set_ocr_team() {
  have ocr || { echo "ocr is not installed; run: doctor.sh install ocr" >&2; exit 1; }
  [ -f "$OCR_CONFIG" ] || { echo "no $OCR_CONFIG here; run doctor.sh init-ocr <ids> first, from the repository root" >&2; exit 1; }
  grep -q '^default_team:' "$OCR_CONFIG" || { echo "$OCR_CONFIG has no default_team block; add one, or re-run ocr init" >&2; exit 1; }
  [ -f .ocr/skills/references/reviewers/architect.md ] || { echo "OCR's architect reviewer is missing; run: ocr update" >&2; exit 1; }
  local team; team="$(ocr_team)"
  if [ "$team" = "$OCR_TEAM" ] && grep -q "$OCR_TEAM_MARK" "$OCR_CONFIG"; then
    echo "ocr-team already principal 1 + architect 1"; return 0
  fi
  if [ "$team" != "$OCR_TEAM" ] && [ "$team" != "$OCR_STOCK_TEAM" ] && [ "${1:-}" != "--force" ]; then
    echo "ocr-team is customised (${team:-unreadable}); nothing changed. Re-run with --force only if the user wants it replaced." >&2
    exit 3
  fi
  local backup; backup="$(mktemp)"; cp "$OCR_CONFIG" "$backup"
  write_ocr_team > "$backup.new" && mv "$backup.new" "$OCR_CONFIG"
  team="$(ocr_team)"
  if [ "$team" != "$OCR_TEAM" ]; then
    cp "$backup" "$OCR_CONFIG"; rm -f "$backup"
    echo "the edit resolved to '${team:-nothing}', not principal 1 + architect 1; $OCR_CONFIG restored. Set default_team by hand." >&2
    exit 1
  fi
  rm -f "$backup"
  ocr reviewers sync >/dev/null || echo "default_team set, but \`ocr reviewers sync\` failed; run it yourself" >&2
  echo "ocr-team set to principal 1 + architect 1 in $OCR_CONFIG"
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
  set-ocr-team)
    set_ocr_team "${2:-}" ;;
  -h|--help)
    sed -n '2,16p' "$0" ;;
  *)
    echo "unknown command: $1 (try --help)" >&2; exit 2 ;;
esac

#!/usr/bin/env bash
# Reports, and on request installs, the tools the Aclarify skills use.
#
#   doctor.sh                  check everything; print one line per tool
#   doctor.sh install <tool>   install one tool (run only after the user agreed)
#   doctor.sh init-ocr <ids>   run `ocr init` for the given comma-separated tool ids
#   doctor.sh set-ocr-team [--force]
#                              set OCR's default review team to principal 1 + architect 1, capped
#                              at two reviewers (run only after the user agreed to the cap);
#                              exits 3 without changing anything when the team is custom,
#                              unless --force (run only after the user agreed to replace it)
#
# Output lines are `<status> <tool> <detail>`, followed by `  install: <command>` when there
# is something to install. Status is one of:
#   ok        present and usable; for ocr-team, the catalog default (principal 1 + architect 1)
#   missing   needed and not there
#   outdated  present but older than a skill needs
#   absent    not there, and only needed for an option this repository may not use
#   default   ocr-team only: OCR's own stock team, as `ocr init` writes it; replacing it with
#             the two-reviewer cap is a policy choice the user makes, not an upgrade
#   custom    ocr-team only: a team this repository chose (other personas or counts, a pinned
#             model, a custom name, or its own comment); left as is unless the user asks
# Exit status is 0 unless the script itself was misused or a change failed, so a missing tool
# never reads as a crash.
# Run it from anywhere inside the repository being set up: it works at the git root, or in the
# working directory when there is no git repository.

set -u

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)" || exit 1

OCR_PKG="@open-code-review/cli"
NODE_MIN="22.5.0"
OCR_CONFIG=".ocr/config.yaml"
# Teams as ocr_team prints them: one sorted persona:name[@model] token per reviewer.
OCR_TEAM="architect:architect-1 principal:principal-1"   # the catalog default
OCR_STOCK_TEAM="principal:principal-1 principal:principal-2 quality:quality-1 quality:quality-2"  # what `ocr init` writes
OCR_TEAM_MARK="SWAP it in rather than adding a third"  # a phrase of the comment write_ocr_team writes
OCR_CAP_OVERRIDES="The cap overrides OCR's auto-added security and testing reviewers: a review gets two reviewers even on auth, API, data or logic-heavy changes."
BACKUP=""; NEW=""   # set_ocr_team's temp files, beside the config
trap '[ -z "$NEW" ] || rm -f "$NEW" "$BACKUP"' EXIT

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
    load_team
    case "$TEAM_KIND" in
      ok) report ok ocr-team "principal 1 + architect 1, at most two reviewers" ;;
      default) report default ocr-team "OCR's stock team ($TEAM_LABEL); the catalog default is principal 1 + architect 1, at most two reviewers. $OCR_CAP_OVERRIDES" "scripts/doctor.sh set-ocr-team  (only if the user agrees to the cap)" ;;
      *) report custom ocr-team "default team customised (${TEAM_LABEL}); left as is" "scripts/doctor.sh set-ocr-team --force  (only if the user wants it replaced)" ;;
    esac
  fi
}

load_team() { # sets TEAM (the resolved default team as sorted persona:name[@model] tokens), TEAM_LABEL and TEAM_KIND
  local out
  out="$(ocr team resolve --json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const team = JSON.parse(s), counts = {};
        let overrides = false;
        const tokens = team.map(r => {
          counts[r.persona] = (counts[r.persona] || 0) + 1;
          if (r.model != null || r.name !== `${r.persona}-${r.instance_index}`) overrides = true;
          return `${r.persona}:${r.name}` + (r.model == null ? "" : `@${r.model}`);
        });
        const label = Object.keys(counts).map(k => `${k} ${counts[k]}`).join(" + ") || "empty";
        console.log(tokens.sort().join(" "));
        console.log(label + (overrides ? ", with pinned models or custom names" : ""));
      } catch { console.log(""); console.log("unreadable"); }
    });')"
  TEAM="$(printf '%s\n' "$out" | sed -n 1p)"
  TEAM_LABEL="$(printf '%s\n' "$out" | sed -n 2p)"
  [ -n "$TEAM_LABEL" ] || TEAM_LABEL="unreadable"
  classify_team
}

classify_team() { # sets TEAM_KIND to ok | default | custom, from TEAM and the config's comment
  if [ "$TEAM" = "$OCR_TEAM" ]; then
    if grep -q "$OCR_TEAM_MARK" "$OCR_CONFIG"; then TEAM_KIND=ok
    else TEAM_KIND=custom; TEAM_LABEL="$TEAM_LABEL, under the repository's own comment"; fi
  elif [ "$TEAM" = "$OCR_STOCK_TEAM" ]; then TEAM_KIND=default
  else TEAM_KIND=custom; fi
}

write_ocr_team() { # print $OCR_CONFIG with its default_team entries replaced, keeping every other line
  # Two passes over the file. The first finds the block (from `default_team:` to the next
  # top-level key) and whether it has entries; the second prints. The new comment and entries
  # go where the first entry was, so comments above it stay above; an inline value, or a block
  # with no entries, gets them right below `default_team:`. Entry lines and their continuations
  # (Form 2 objects, Form 3 lists at either indentation) are dropped, as is an earlier copy of
  # the comment this writes.
  awk '
    BEGIN {
      c[1] = "# TWO reviewers, always: one principal and one architect. This outranks the"
      c[2] = "# auto-detection table in /ocr:review Phase 3 that says to ADD reviewers for"
      c[3] = "# auth, API, data or logic-heavy changes. If a lens fits a change better than"
      c[4] = "# one of these, SWAP it in rather than adding a third, and fold any concern"
      c[5] = "# only the dropped lens would catch into the remaining brief. A --team"
      c[6] = "# override replaces this pair for that one review."
      for (i = 1; i <= 6; i++) ours[c[i]] = 1
    }
    function indent(s) { match(s, /^ */); return RLENGTH }
    function trimmed(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
    function emit(ind,   pad, i) {
      pad = sprintf("%" ind "s", "")
      for (i = 1; i <= 6; i++) print pad c[i]
      print pad "principal: 1    # Holistic review: does the change hold together"
      print pad "architect: 1    # Boundaries, contracts, coupling: does the design still evolve"
      done = 1
    }
    # Shared by both passes: track the block and classify each of its lines.
    function classify(line) {
      if (line ~ /^default_team:/) {
        inblock = 1; ind = 0
        inline = (line ~ /^default_team:[ \t]*[^ \t#]/)
        return "header"
      }
      if (inblock && line ~ /^[^ \t#]/) inblock = 0
      if (!inblock) return "outside"
      if (line ~ /^[ \t]*$/) return "blank"
      if (line ~ /^[ \t]*#/) return (trimmed(line) in ours) ? "ours" : "comment"
      if (inline) return "continuation"
      if (!ind) ind = indent(line)
      if (indent(line) == ind && line ~ /^ *[A-Za-z0-9_-]+[ \t]*:/) return "entry"
      if (indent(line) > ind || line ~ /^ *- /) return "continuation"
      return "other"
    }
    FNR == 1 { inblock = 0; ind = 0; inline = 0 }
    NR == FNR {
      k = classify($0)
      if (k == "entry" && !first_ind) first_ind = ind
      if (k == "header" && inline) has_inline = 1
      next
    }
    {
      k = classify($0)
      if (k == "header") {
        if (has_inline) { print "default_team:"; emit(2) }
        else { print; if (!first_ind) emit(2) }
        next
      }
      if (k == "ours" || k == "continuation") next
      if (k == "entry") { if (!done) emit(ind); next }
      print
    }
  ' "$OCR_CONFIG" "$OCR_CONFIG"
}

config_target() { # the file $OCR_CONFIG names, following symlinks, so an edit writes through them
  local t="$OCR_CONFIG" link
  while [ -L "$t" ]; do
    link="$(readlink "$t")"
    case "$link" in /*) t="$link" ;; *) t="$(dirname "$t")/$link" ;; esac
  done
  printf '%s\n' "$t"
}

set_ocr_team() {
  have ocr || { echo "ocr is not installed; run: doctor.sh install ocr" >&2; exit 1; }
  [ -f "$OCR_CONFIG" ] || { echo "no $OCR_CONFIG in $(pwd); run doctor.sh init-ocr <ids> first" >&2; exit 1; }
  grep -q '^default_team:' "$OCR_CONFIG" || { echo "$OCR_CONFIG has no default_team block; add one, or re-run ocr init" >&2; exit 1; }
  [ -f .ocr/skills/references/reviewers/architect.md ] || { echo "OCR's architect reviewer is missing; run: ocr update" >&2; exit 1; }
  load_team
  case "$TEAM_KIND" in
    ok) echo "ocr-team already principal 1 + architect 1"; return 0 ;;
    custom)
      if [ "${1:-}" != "--force" ]; then
        echo "ocr-team is customised ($TEAM_LABEL); nothing changed. Re-run with --force only if the user wants it replaced." >&2
        exit 3
      fi ;;
  esac
  local target
  target="$(config_target)"
  BACKUP="$target.bak.$$"; NEW="$target.tmp.$$"
  cp -p "$target" "$BACKUP" && cp -p "$target" "$NEW" || { echo "could not write beside $target; nothing changed" >&2; exit 1; }
  if ! { write_ocr_team > "$NEW" && mv "$NEW" "$target"; }; then
    echo "could not rewrite $OCR_CONFIG; nothing changed. Set default_team by hand." >&2
    exit 1
  fi
  load_team
  if [ "$TEAM" != "$OCR_TEAM" ]; then
    mv "$BACKUP" "$target"
    echo "the edit resolved to '${TEAM_LABEL}', not principal 1 + architect 1; $OCR_CONFIG restored. Set default_team by hand." >&2
    exit 1
  fi
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
    sed -n '2,/^$/p' "$SELF" ;;
  *)
    echo "unknown command: $1 (try --help)" >&2; exit 2 ;;
esac

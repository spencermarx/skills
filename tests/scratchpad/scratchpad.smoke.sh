#!/usr/bin/env bash
#
# Smoke test for the scratchpad skill's script — a create → list → clean roundtrip
# on a disposable domain, plus the worktree-rooting guarantees and the configurable
# scratch folder. Self-cleaning; exits non-zero if any assertion failed. Every
# check runs inside throwaway repositories, never the checkout running the suite.
# Run through `node --test tests/` (tests/scratchpad.test.mjs), or directly:
#   bash tests/scratchpad/scratchpad.smoke.sh

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sp="$here/../../skills/core/scratchpad/scripts/scratchpad.sh"
[ -f "$sp" ] || { echo "smoke: scratchpad.sh not found at $sp" >&2; exit 1; }
# Per-process, so two suites running at once never sweep each other's entries —
# the clean checks below delete the whole domain with --force.
domain="smoke-test-$$"
fails=0

# Resolved with `pwd -P`: on macOS mktemp hands back a /var symlink while git
# reports the /private/var target, and the assertions below compare paths.
tmp="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$tmp"' EXIT
git_q() { git -c user.email=smoke@example.invalid -c user.name=smoke "$@"; }

# The first section runs from inside a disposable repository, so the suite never
# writes into the checkout that runs it.
home="$tmp/home"
mkdir -p "$home"
git_q -C "$home" init -q
printf 'x\n' >"$home/README.md"
git_q -C "$home" add -A
git_q -C "$home" commit -qm init
cd "$home"

check() { # check <description> <command…> — the command's exit status is the verdict
  local desc="$1"
  shift
  if "$@"; then
    printf 'ok   — %s\n' "$desc"
  else
    printf 'FAIL — %s\n' "$desc"
    fails=$((fails + 1))
  fi
}

# Predicates, so every assertion is a single command `check` can run and report on.
contains() { # contains <text> <substring…> — every substring must appear
  local text="$1" needle
  shift
  # Refuse the two shapes that would assert nothing and still report `ok`: no
  # needles at all (the loop never runs), and an empty needle (`grep -qF ''`
  # matches any input). Both are one shell-quoting slip away in a future caller.
  [ "$#" -gt 0 ] || return 1
  for needle in "$@"; do
    [ -n "$needle" ] || return 1
    printf '%s\n' "$text" | grep -qF "$needle" || return 1
  done
}
starts_with() { case "$1" in "$2"*) ;; *) return 1 ;; esac; }
ends_with() { case "$1" in *"$2") ;; *) return 1 ;; esac; }

# Every refusal is judged on an EXACT exit status and a substring of the message,
# never on "non-zero". Two ways a laxer test reports ok while proving nothing:
# any-non-zero accepts an argument error (2) for a check aimed at a guard that
# returns 1, so a typo'd invocation never reaches the guard and still passes; and
# status 1 is shared by every guard in `place`, so only the message says which
# one fired. Both shapes have already shipped here.
refuses_in() { # refuses_in <dir> <status> <message-substring> <verb…>
  local dir="$1" want="$2" needle="$3"
  shift 3
  # The whole judgement runs inside the subshell, so a failed `cd` fails the
  # check rather than inverting into a pass.
  (
    cd "$dir" || exit 1
    local got=0 err
    # Captures stderr and discards stdout: the redirections are in this order
    # because `2>&1` must bind fd2 to the substitution's pipe before fd1 leaves.
    err="$("$sp" "$@" 2>&1 >/dev/null)" || got=$?
    [ "$got" -eq "$want" ] || exit 1
    [ -n "$needle" ] || exit 1 # an empty needle would match any message
    printf '%s\n' "$err" | grep -qF "$needle"
  )
}
refuses() { # refuses <status> <message-substring> <verb…> — in the current cwd
  refuses_in "$PWD" "$@"
}

# new: creates a directory, prints its path, slugifies the description.
d1="$("$sp" new "$domain" 'Hello, World!')"
check "new creates the directory" test -d "$d1"
check "new slugifies the description" ends_with "$(basename "$d1")" '-hello-world'

# new again: never collides.
d2="$("$sp" new "$domain" 'another one')"
check "new never returns a duplicate path" test "$d1" != "$d2"

# new under concurrency: N racing same-slug callers must each get a distinct dir.
# The sequential checks above pass even with a TOCTOU race; this is the real guard.
race_n=25
race_out="$(mktemp -d)"
for i in $(seq 1 "$race_n"); do ("$sp" new "$domain" 'race' >"$race_out/w$i" 2>/dev/null) & done
wait
race_distinct="$(sort -u "$race_out"/w* 2>/dev/null | grep -c . || true)"
check "new is collision-free under $race_n concurrent same-slug callers" \
  test "$race_distinct" -eq "$race_n"
rm -rf "$race_out"

# place: the route a caller must take when it may not write into the entry
# itself — an isolated background session cannot Edit/Write the main checkout,
# and every entry lives there by design. Authored outside, then moved in.
stage="$(mktemp -d)"
fresh_src() { # fresh_src [<body>] — a NEW staging file per call, printed. Sharing
  # one would let a check whose refusal wrongly succeeded consume the source a
  # later check needs, turning "source missing" into a refusal that reports ok and
  # proves nothing. The body is a parameter because every refusal below is paired
  # with an equality check on the destination, and identical bytes on both sides
  # would make an overwrite indistinguishable from a guard that held.
  local f body="${1:-replacement body}"
  f="$(mktemp "$stage/src-XXXXXX")"
  printf '%s\n' "$body" >"$f"
  printf '%s' "$f"
}

src="$(fresh_src 'placed body')"
placed="$("$sp" place "$d1" 'PLACED.md' "$src")"
check "place prints the final path inside the entry" test "$placed" = "$d1/PLACED.md"
check "place lands the file in the entry" test -f "$d1/PLACED.md"
check "place preserves the content verbatim" test "$(cat "$d1/PLACED.md")" = 'placed body'
check "place moves rather than copies" test ! -e "$src"

# The refusals. Each shape either strands a file outside the entry the caller
# named, or destroys one already there — so each is paired with a check on the
# CONSEQUENCE, since a refusal that reports correctly but still moves the file
# would otherwise read as green.
check "place refuses to overwrite an existing file" \
  refuses 1 'refusing to overwrite' place "$d1" 'PLACED.md' "$(fresh_src)"
check "place leaves the original intact after refusing" \
  test "$(cat "$d1/PLACED.md")" = 'placed body'

# Both filename shapes below have an EXISTING destination parent. One whose
# parent is missing would be refused by mv(1) alone, so the check would still
# pass with the guard deleted and prove nothing. Stale debris is cleared first,
# or the no-clobber guard masks the filename guard on the next run.
escaped="$(dirname "$d1")/escaped.md"
rm -f "$escaped"
check "place refuses a parent-relative filename that escapes the entry" \
  refuses 2 'must be a bare filename' place "$d1" '../escaped.md' "$(fresh_src)"
check "place did not strand the file beside the entry" test ! -e "$escaped"
rm -f "$escaped"

mkdir -p "$d1/nested"
check "place refuses a filename containing a slash" \
  refuses 2 'must be a bare filename' place "$d1" 'nested/PLACED.md' "$(fresh_src)"
check "place did not bury the file in a subdirectory" test ! -e "$d1/nested/PLACED.md"
rm -rf "$d1/nested"

# `.` and `..` also reach the no-clobber guard, which would refuse them — but as
# "refusing to overwrite <entry>/..", a diagnosis that is not true of what was
# asked. Demanding status 2 and the filename message is what tells the two guards
# apart; any-non-zero could not, which is why this arm went untested for so long.
check "place refuses '.' as a filename" \
  refuses 2 'must be a bare filename' place "$d1" '.' "$(fresh_src)"
check "place refuses '..' as a filename" \
  refuses 2 'must be a bare filename' place "$d1" '..' "$(fresh_src)"

check "place refuses an entry outside the scratchpad root" \
  refuses 1 'outside the scratchpad root' place "$stage" 'PLACED.md' "$(fresh_src)"
check "place did not write outside the scratchpad root" test ! -e "$stage/PLACED.md"

# The root and a bare domain directory are real directories INSIDE the root, so
# containment alone admits both — and `list` and `clean` match `-type d` at entry
# depth only, so a file at either is invisible to one and unreclaimable by the
# other. Unreclaimable litter is the one thing this primitive must never create.
#
# Both targets are cleared first, and again after. These two land in the REAL
# scratchpad root rather than a disposable fixture, and nothing else sweeps them:
# `clean` only ever removes directories, so a stray file here would survive every
# later run and hold its check red forever — a suite that cannot heal itself.
sp_root="$(dirname "$(dirname "$d1")")"
sp_domain="$(dirname "$d1")"
rm -f "$sp_root/ROOT.md" "$sp_domain/DOMAIN.md"
check "place refuses the scratchpad root itself" \
  refuses 1 'must be an entry' place "$sp_root" 'ROOT.md' "$(fresh_src)"
check "place did not litter the scratchpad root" test ! -e "$sp_root/ROOT.md"
check "place refuses a bare domain directory" \
  refuses 1 'must be an entry' place "$sp_domain" 'DOMAIN.md' "$(fresh_src)"
check "place did not litter the domain directory" test ! -e "$sp_domain/DOMAIN.md"
rm -f "$sp_root/ROOT.md" "$sp_domain/DOMAIN.md"

# Without the -d guard the later `cd "$entry"` fails and `set -e` aborts with
# status 1 — the same status the containment guard returns, so only the exact
# status and the message can tell the guarded build from the unguarded one.
check "place refuses an entry that does not exist" \
  refuses 2 'is not a directory' place "$stage/no-such-entry" 'X.md' "$(fresh_src)"
check "place refuses an entry that is a regular file" \
  refuses 2 'is not a directory' place "$(fresh_src)" 'X.md' "$(fresh_src)"

check "place refuses a source that does not exist" \
  refuses 2 'is not a regular file' place "$d1" 'MISSING.md' "$stage/no-such-file.md"
check "place refuses a source that is a directory" \
  refuses 2 'is not a regular file' place "$d1" 'DIR.md' "$stage"

# A symlink passes -f, so without its own guard `mv` relocates the LINK and the
# entry ends up pointing into the caller's staging directory — dangling as soon
# as that is swept, which is exactly the stranded handoff `place` exists to end.
symsrc="$stage/linked-src.md"
ln -s "$(fresh_src 'symlink target body')" "$symsrc"
check "place refuses a symlinked source" \
  refuses 2 'is a symlink' place "$d1" 'SYM.md' "$symsrc"
check "place did not move the symlink into the entry" test ! -e "$d1/SYM.md"
check "place left the symlinked source where it was" test -L "$symsrc"
rm -f "$symsrc"

# A DANGLING symlink at the destination is not -e, so an -e-only clobber guard
# reads the slot as empty and `mv` replaces or writes through the link. Asserting
# the link SURVIVES is the portable consequence: which of the two happens depends
# on whether source and destination share a filesystem.
dangle_src="$(fresh_src)"
ln -s "$stage/nowhere.md" "$d1/DANGLE.md"
check "place refuses a dangling symlink at the destination" \
  refuses 1 'refusing to overwrite' place "$d1" 'DANGLE.md' "$dangle_src"
check "place left the dangling destination as it found it" test -L "$d1/DANGLE.md"
check "place left the source beside the dangling destination untouched" \
  test -f "$dangle_src"
rm -f "$d1/DANGLE.md"
rm -rf "$stage"

# list: both entries appear.
listing="$("$sp" list "$domain")"
check "list shows both entries" contains "$listing" "$d1" "$d2"

# clean dry-run: reports, does not delete.
dry="$("$sp" clean "$domain" --older-than 0d)"
check "clean dry-run reports what it would remove" contains "$dry" 'would remove'
check "clean dry-run deletes nothing" test -d "$d1"

# clean --force: actually deletes.
"$sp" clean "$domain" --older-than 0d --force >/dev/null
check "clean --force removes the first entry" test ! -d "$d1"
check "clean --force removes the second entry" test ! -d "$d2"

# ignore guarantee.
root="$("$sp" root)"
root="${root%/.scratchpad}"
check ".scratchpad is git-ignored" git -C "$root" check-ignore -q .scratchpad

# tidy: drop the now-empty smoke-test domain dir if present.
rmdir "$root/.scratchpad/$domain" 2>/dev/null || true
cd "$tmp"

# ---------------------------------------------------------------------------
# Worktree rooting. Every check above runs in the main tree and stays green even
# if the verbs root at the caller's own worktree — which is exactly the bug this
# section exists to catch. The fixtures are disposable repos, so the assertions
# hold no matter how the developer's own checkout happens to be arranged.
# ---------------------------------------------------------------------------

fixture="$tmp/main"
mkdir -p "$fixture"
git_q -C "$fixture" init -q
printf 'node_modules/\n' >"$fixture/.gitignore" # deliberately WITHOUT .scratchpad/
printf 'x\n' >"$fixture/README.md"
git_q -C "$fixture" add -A
git_q -C "$fixture" commit -qm init
wt="$fixture/.claude/worktrees/wt"
git_q -C "$fixture" worktree add -q --detach "$wt" HEAD

from_main="$(cd "$fixture" && "$sp" new "$domain" 'written from main')"
from_wt="$(cd "$wt" && "$sp" new "$domain" 'written from the worktree')"
check "new from a linked worktree writes to the MAIN root" \
  starts_with "$from_wt" "$fixture/.scratchpad/"

# The payoff: one shared root means either side can find the other's work.
check "list from a worktree sees an entry written from main" \
  contains "$(cd "$wt" && "$sp" list "$domain")" "$from_main"
check "list from main sees an entry written from a worktree" \
  contains "$(cd "$fixture" && "$sp" list "$domain")" "$from_wt"

# place's containment guard must match on a path BOUNDARY, not a bare prefix: a
# sibling whose name merely starts with the root's must still be refused. Run
# from inside the fixture so the sibling is a true sibling of the ACTIVE root,
# which also means the fixture's own .scratchpad exists — otherwise the no-root
# guard would fire first and this would prove nothing about the boundary.
mkdir -p "$fixture/.scratchpad-evil/entry"
printf 'x\n' >"$tmp/boundary-src.md"
check "place refuses a sibling whose name only prefixes the scratchpad root" \
  refuses_in "$fixture" 1 'outside the scratchpad root' \
  place "$fixture/.scratchpad-evil/entry" 'X.md' "$tmp/boundary-src.md"
check "place leaves the source untouched after refusing" test -f "$tmp/boundary-src.md"

# No .scratchpad root at all — a repository where `new` has never run. The guard
# is what stands between that and disaster: let the resolution fail softly and
# the root is the empty string, so the containment pattern degrades from
# `<root>/.scratchpad/*/*/` to `/*/*/`, which matches every absolute path on the
# machine. `place` would then move the file wherever it was pointed.
nosp="$tmp/no-scratchpad"
mkdir -p "$nosp/handoffs/entry"
git_q -C "$nosp" init -q
printf 'x\n' >"$tmp/no-root-src.md"
check "place refuses a repository with no .scratchpad root" \
  refuses_in "$nosp" 1 'no .scratchpad root' \
  place "$nosp/handoffs/entry" 'X.md' "$tmp/no-root-src.md"
check "place leaves the source untouched when there is no scratchpad root" \
  test -f "$tmp/no-root-src.md"

# A subdirectory is the common case for an agent mid-task; rooting must not move.
mkdir -p "$wt/apps/www"
check "root resolves identically from a nested subdirectory" \
  test "$(cd "$wt/apps/www" && "$sp" root)" = "$fixture/.scratchpad"

# The ignore safety net must never dirty .gitignore — it is a TRACKED file, and
# a dirty one is a commit away from leaking scratch into git.
check "the ignore safety net leaves the tracked .gitignore clean" \
  test -z "$(git -C "$fixture" status --porcelain -- .gitignore)"

# Defense in depth: nothing writes scratch into a worktree any more, but a legacy
# pile left in one must still be unstageable. The directory has to exist for this
# check — `.scratchpad/` is a trailing-slash pattern, so it matches only a path
# git can see IS a directory.
mkdir -p "$wt/.scratchpad"
check "the safety net ignores .scratchpad in every worktree" \
  git -C "$wt" check-ignore -q .scratchpad
rmdir "$wt/.scratchpad"

# Fallback shapes: git names something that is NOT a working tree as the "main
# worktree", and the resolver must notice rather than put scratch outside the
# repo. A bare main repo has no main working tree at all; --separate-git-dir
# makes git report the git dir. Both must fall back to the caller's own tree.
git clone -q --bare "$fixture" "$tmp/bare.git"
git_q -C "$tmp/bare.git" worktree add -q --detach "$tmp/bare-wt" HEAD
check "a bare repo's worktree falls back to its own tree" \
  test "$(cd "$tmp/bare-wt" && "$sp" root)" = "$tmp/bare-wt/.scratchpad"

git_q init -q --separate-git-dir "$tmp/sep-gitdir" "$tmp/sep"
check "--separate-git-dir falls back to the working tree" \
  test "$(cd "$tmp/sep" && "$sp" root)" = "$tmp/sep/.scratchpad"

# No git tree at all. Every verb must REFUSE — the one answer that is never right
# here is a plausible-looking path with a zero exit status, which is how a caller
# ends up creating `/.scratchpad`. `root` failed exactly this way when its
# resolver call sat in argument position, where the guard's `exit` is discarded.
outside="$tmp/not-a-repo"
mkdir -p "$outside"
no_repo='not inside a git repository'
check "root refuses outside a git repository" \
  refuses_in "$outside" 1 "$no_repo" root
check "new refuses outside a git repository" \
  refuses_in "$outside" 1 "$no_repo" new "$domain" 'nope'
check "list refuses outside a git repository" \
  refuses_in "$outside" 1 "$no_repo" list
check "clean refuses outside a git repository" \
  refuses_in "$outside" 1 "$no_repo" clean "$domain" --older-than 14d
# Given wholly valid arguments, so the refusal can only come from the repo guard
# rather than from argument validation short-circuiting ahead of it.
mkdir -p "$outside/handoffs/entry"
printf 'x\n' >"$outside/src.md"
check "place refuses outside a git repository" \
  refuses_in "$outside" 1 "$no_repo" place "$outside/handoffs/entry" 'X.md' "$outside/src.md"

# The safety net is meant to be dormant wherever the committed .gitignore already
# does the job. The fixture above deliberately OMITS the entry, so it only ever
# exercised the firing path; this one carries it, and must come out untouched.
lacks_line() { # lacks_line <file> <exact-line>
  # The file must EXIST to be judged: `git init` always seeds info/exclude, so an
  # absent one means the path is wrong and the assertion read nothing.
  [ -f "$1" ] && ! grep -qxF "$2" "$1"
}
covered="$tmp/covered"
mkdir -p "$covered"
git_q -C "$covered" init -q
printf '.scratchpad/\n' >"$covered/.gitignore"
printf 'x\n' >"$covered/README.md"
git_q -C "$covered" add -A
git_q -C "$covered" commit -qm init
(cd "$covered" && "$sp" new "$domain" 'first entry in a fresh clone' >/dev/null)
check "the safety net stays dormant when .gitignore already covers .scratchpad" \
  lacks_line "$covered/.git/info/exclude" '.scratchpad/'

# ---------------------------------------------------------------------------
# A configured scratch folder. A repository that keeps scratch somewhere other
# than .scratchpad names it with --dir or SCRATCHPAD_DIR, and every verb must
# honour it — including the ignore net and place's containment guard.
# ---------------------------------------------------------------------------

custom="$tmp/custom"
mkdir -p "$custom"
git_q -C "$custom" init -q
printf 'x\n' >"$custom/README.md"
git_q -C "$custom" add -A
git_q -C "$custom" commit -qm init

check "--dir names the root" \
  test "$(cd "$custom" && "$sp" --dir 'work/scratch/' root)" = "$custom/work/scratch"
check "SCRATCHPAD_DIR names the root" \
  test "$(cd "$custom" && SCRATCHPAD_DIR=.scratch "$sp" root)" = "$custom/.scratch"
check "--dir wins over SCRATCHPAD_DIR" \
  test "$(cd "$custom" && SCRATCHPAD_DIR=.scratch "$sp" --dir ./work/scratch root)" = "$custom/work/scratch"

c1="$(cd "$custom" && "$sp" --dir work/scratch new "$domain" 'configured folder')"
check "new under --dir lands in the configured folder" \
  starts_with "$c1" "$custom/work/scratch/$domain/"
check "the configured folder is git-ignored" \
  git -C "$custom" check-ignore -q work/scratch/
check "the default folder was not created" test ! -e "$custom/.scratchpad"
check "list under --dir sees the entry" \
  contains "$(cd "$custom" && "$sp" --dir work/scratch list "$domain")" "$c1"
check "list without --dir does not see it" \
  test -z "$(cd "$custom" && "$sp" list "$domain")"
printf 'x\n' >"$tmp/custom-src.md"
check "place under --dir accepts an entry in the configured folder" \
  test "$(cd "$custom" && "$sp" --dir work/scratch place "$c1" 'X.md' "$tmp/custom-src.md")" = "$c1/X.md"
mkdir -p "$custom/.scratchpad/$domain/stray"
printf 'x\n' >"$tmp/custom-src2.md"
check "place under --dir refuses an entry in the default folder" \
  refuses_in "$custom" 1 'outside the scratchpad root' \
  --dir work/scratch place "$custom/.scratchpad/$domain/stray" 'X.md' "$tmp/custom-src2.md"
rm -rf "$custom/.scratchpad"

check "--dir refuses an absolute path" \
  refuses_in "$custom" 2 'must be a relative path' --dir /tmp/elsewhere root
check "--dir refuses a path that climbs out of the repository" \
  refuses_in "$custom" 2 'must be a relative path' --dir ../outside root
env_refuses() { # env_refuses <SCRATCHPAD_DIR value> <refuses_in args…>
  local value="$1"
  shift
  (
    export SCRATCHPAD_DIR="$value"
    refuses_in "$@"
  )
}
check "SCRATCHPAD_DIR refuses a path that climbs out of the repository" \
  env_refuses a/../../b "$custom" 2 'must be a relative path' root

echo
if [ "$fails" -eq 0 ]; then
  echo "all checks passed"
else
  echo "$fails check(s) failed"
  exit 1
fi

#!/usr/bin/env bash
#
# scratchpad — a domain-opaque home for ephemeral, git-ignored working artifacts.
#
# It owns WHERE such artifacts live, HOW they are named, and WHEN they are
# reclaimed — and nothing about what they MEAN. `<domain>` is an opaque label
# (e.g. `handoffs`, `arch-board`); the primitive never learns what one is. Every
# entry is a DIRECTORY the caller then writes its own file(s) into — the script
# never AUTHORS a document, so it can never drift as document formats do. `place`
# relocates bytes the caller already wrote, which keeps that property: it moves a
# file it never looks inside.
#
# `place` exists because a caller cannot always write into the entry directly.
# Some harnesses isolate background sessions: Claude Code's `worktree.bgIsolation`
# (default `worktree`), for one, blocks its file-editing tools against the main
# checkout until the session enters a worktree — and this primitive roots at the
# MAIN checkout by design, so the entry is exactly what those tools may not touch.
# The guard resolves symlinks, so no aliasing escapes it, and it has no per-path
# exemption. Its scope is the file-editing tools only, so a plain shell
# invocation like this one is the sanctioned route rather than a loophole. The
# caller therefore authors its file somewhere it IS allowed to write (outside the
# repository) and hands it here.
#
# The scratch folder defaults to `.scratchpad`, relative to the main worktree's
# top. A repository that keeps scratch elsewhere names it with `--dir <folder>`
# ahead of the verb, or with the SCRATCHPAD_DIR environment variable; the flag
# wins. Below, ".scratchpad" means whichever folder that resolves to.
#
# Verbs:
#   root                                        print the .scratchpad root
#   new   <domain> <slug>                       create + print an entry directory
#   place <entry-dir> <filename> <source-file>  move a written file into an entry
#   list  [<domain>]                            list entries, newest-first
#   clean [<domain>] --older-than <age> [--force]  reclaim old entries
#
# Layout it creates:  <main-worktree>/.scratchpad/<domain>/<UTC-YYYYMMDD-HHMMSS>-<slug>/
#
# Every verb roots at the MAIN worktree — the root checkout — never the linked
# worktree a caller happens to stand in; see main_worktree_root().
#
# Portable across BSD (macOS) and GNU (CI) userlands: no `date -d`, no
# `find -printf`. Entry names are slug-safe (no spaces/newlines), so newline-
# delimited pipelines are safe even when the repo path contains spaces.

set -euo pipefail

usage() {
  cat >&2 <<'EOF'
scratchpad — ephemeral git-ignored working artifacts

Usage:
  scratchpad.sh [--dir <folder>] <verb> [args]

  --dir <folder>
      The scratch folder, relative to the repository's top (default
      `.scratchpad`, or $SCRATCHPAD_DIR when set). Give it on every call when the
      repository keeps scratch somewhere else.

  scratchpad.sh root
      Print the .scratchpad root (always the main worktree's, even when called
      from a linked worktree). Use it instead of assuming `.scratchpad` is
      relative to the cwd.

  scratchpad.sh new   <domain> <slug>
      Create an entry directory and print its absolute path. The caller owns
      whatever files it writes inside.

  scratchpad.sh place <entry-dir> <filename> <source-file>
      Move an already-written <source-file> into <entry-dir> under <filename>,
      and print the final absolute path. <entry-dir> must be an entry `new`
      printed, not the root and not a bare domain. Use it when a write into the
      entry is refused — an isolated background session cannot Edit/Write the
      main checkout. Author the file outside the repository, then place it.

  scratchpad.sh list  [<domain>]
      Print existing entry directories, newest-first (one absolute path per
      line). Omit <domain> to list across all domains.

  scratchpad.sh clean [<domain>] --older-than <age> [--force]
      Reclaim entries older than <age> (e.g. 14d, 12h, 30m; 0d = all). Prints
      what it WOULD remove; pass --force to actually delete. Never automatic.

<domain> is an opaque label (e.g. handoffs, arch-board): [a-z0-9][a-z0-9-]*
EOF
  exit 2
}

# The scratch folder, relative to the main worktree's top. Set by --dir or
# SCRATCHPAD_DIR; validated once in main() so every verb sees the same answer.
SP_DIR=".scratchpad"

# Normalise and validate a folder name: relative, inside the repository, no `..`
# segment. Absolute or escaping paths are refused because `list` and `clean
# --force` operate on whatever this names, and a typo must never aim `rm -rf`
# outside the tree.
set_sp_dir() {
  local d="$1"
  while [ "${d#./}" != "$d" ]; do d="${d#./}"; done
  while [ "${d%/}" != "$d" ]; do d="${d%/}"; done
  case "$d" in
    "" | . | /* | -* | .. | ../* | */.. | */../*)
      echo "scratchpad: the scratch folder must be a relative path inside the repository (got '$1')" >&2
      exit 2
      ;;
  esac
  SP_DIR="$d"
}

# Absolute path to the MAIN worktree's top — the root checkout — no matter which
# linked worktree the caller is standing in. Scratch is deliberately SHARED
# across worktrees rather than living with each one: a worktree is disposable
# (`git worktree remove` deletes it despite ignored files, so worktree-local
# scratch dies with the branch it was helping), and per-worktree roots partition
# `list`, which is the one thing that lets a later agent find prior work.
main_worktree_root() {
  local here main
  here="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "scratchpad: not inside a git repository" >&2
    exit 1
  }
  # `git worktree list` prints the main worktree first — that is its defining
  # property — with an absolute path, so this holds whether linked worktrees sit
  # under `.claude/worktrees/` or in a sibling directory.
  main="$(git worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
  # Trust that only once it is confirmed to BE a working tree. Two shapes make
  # git name something that is not one — a bare main repo (there is no main
  # working tree) and `--separate-git-dir` (git reports the git dir) — and for
  # both, the only sane home for scratch is the tree the caller is standing in.
  if [ -n "$main" ] && [ -d "$main" ] &&
    [ "$(git -C "$main" rev-parse --show-toplevel 2>/dev/null)" = "$main" ]; then
    printf '%s' "$main"
  else
    printf '%s' "$here"
  fi
}

# Guarantee .scratchpad/ is ignored. The committed .gitignore entry is the real
# guarantee; this is an idempotent safety net for a checkout predating it. It
# writes the repository's own info/exclude — shared by every worktree and never
# committable — rather than .gitignore, which is a TRACKED file: appending there
# leaves the tree dirty and the line one `git add -A` from being committed.
ensure_ignored() {
  local root="$1" common exclude
  # The trailing slash is load-bearing: `.scratchpad/` is a directory-only
  # pattern, which git matches only against a path it can see IS a directory —
  # and this runs before the directory exists. Asking about `.scratchpad` would
  # answer "not ignored" on every fresh clone, firing the net where the committed
  # entry already holds. The append below is an unguarded read-modify-write, so
  # concurrent first uses in a checkout that genuinely lacks the entry can write
  # the line more than once — harmless (git ignores duplicates), but it is why
  # this guard must stay accurate rather than merely usually-right.
  if git -C "$root" check-ignore -q "$SP_DIR/" 2>/dev/null; then
    return 0
  fi
  common="$(git -C "$root" rev-parse --git-common-dir 2>/dev/null)" || return 0
  # Resolved with cwd=$root, so a relative answer (the usual `.git`) is relative
  # to the tree top. Avoids `--path-format=absolute`, which predates git 2.31.
  case "$common" in
    /*) ;;
    *) common="$root/$common" ;;
  esac
  exclude="$common/info/exclude"
  if [ -f "$exclude" ] && grep -qxF "$SP_DIR/" "$exclude"; then
    return 0
  fi
  mkdir -p "$common/info"
  # Guarantee the file ends in a newline so the entry can't concatenate onto a
  # last line lacking one (which would yield e.g. `google_api_key.scratchpad/`).
  if [ -s "$exclude" ] && [ -n "$(tail -c1 "$exclude")" ]; then
    printf '\n' >>"$exclude"
  fi
  printf '%s\n' "$SP_DIR/" >>"$exclude"
}

# Reduce an arbitrary description to a filesystem-safe slug: lowercase, non
# [a-z0-9] runs collapsed to a single dash, trimmed, capped at 50 chars.
slugify() {
  local s
  s="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  s="${s:0:50}"
  s="$(printf '%s' "$s" | sed -E 's/-+$//')"
  printf '%s' "$s"
}

# Translate a human age (14d / 12h / 30m) into minutes for find -mmin.
parse_age_minutes() {
  local a="$1" num unit
  if ! printf '%s' "$a" | grep -qE '^[0-9]+[dhm]$'; then
    echo "scratchpad: --older-than must look like 14d, 12h, or 30m" >&2
    exit 2
  fi
  num="${a%[dhm]}"
  unit="${a##*[0-9]}"
  case "$unit" in
    d) echo "$((num * 1440))" ;;
    h) echo "$((num * 60))" ;;
    m) echo "$num" ;;
  esac
}

# Answers "where does scratch actually live from here?" so a caller never has to
# guess, and never treats `.scratchpad` as relative to its own cwd.
cmd_root() {
  # Assignment, not argument position: a substitution inside `printf`'s arguments
  # discards its exit status, so main_worktree_root()'s `exit 1` would die in the
  # subshell and leave `root` printing a bare `/.scratchpad` with status 0 — the
  # silent wrong-place answer this whole primitive exists to prevent.
  local root
  root="$(main_worktree_root)"
  printf '%s\n' "$root/$SP_DIR"
}

cmd_new() {
  local domain="${1:-}" slug_raw="${2:-}"
  [ -n "$domain" ] || usage
  if ! printf '%s' "$domain" | grep -qE '^[a-z0-9][a-z0-9-]*$'; then
    echo "scratchpad: <domain> must be [a-z0-9][a-z0-9-]* (got '$domain')" >&2
    exit 2
  fi
  local slug
  slug="$(slugify "$slug_raw")"
  [ -n "$slug" ] || slug="entry"

  local root ts base dir n
  root="$(main_worktree_root)"
  ensure_ignored "$root"
  ts="$(date -u +%Y%m%d-%H%M%S)"
  base="$root/$SP_DIR/$domain"
  mkdir -p "$base"
  # The mkdir(2) create-or-fail syscall IS the lock: success means we alone
  # created (and therefore own) this leaf; EEXIST means a racing caller won the
  # name, so try the next suffix. There is no check-then-act window, so
  # concurrent same-timestamp/same-slug callers never share a directory. First
  # name is unsuffixed, then -2, -3, …; bounded so a persistent non-EEXIST fault
  # (a permission or disk error) cannot spin forever.
  n=1
  dir="$base/$ts-$slug"
  until mkdir "$dir" 2>/dev/null; do
    n=$((n + 1))
    if [ "$n" -gt 999 ]; then
      echo "scratchpad: could not create an entry under $base/$ts-$slug" >&2
      mkdir "$base/$ts-$slug-$n" # unredirected: surface the real errno, then die
      exit 1
    fi
    dir="$base/$ts-$slug-$n"
  done
  printf '%s\n' "$dir"
}

# Move a file the caller already wrote into an entry. The bytes are never read,
# so this stays as format-blind as the rest of the primitive.
cmd_place() {
  local entry="${1:-}" name="${2:-}" src="${3:-}"
  [ -n "$entry" ] && [ -n "$name" ] && [ -n "$src" ] || usage

  [ -d "$entry" ] || {
    echo "scratchpad: <entry-dir> is not a directory: $entry" >&2
    exit 2
  }
  # Ahead of the -f test, which follows the link and would call a symlink to a
  # regular file regular. `mv` would then relocate the LINK, so the entry ends up
  # holding a pointer into the caller's staging directory — dangling the moment
  # that directory is swept, which is the one failure mode `place` exists to end.
  [ ! -L "$src" ] || {
    echo "scratchpad: <source-file> is a symlink, and place moves the link rather than its bytes: $src" >&2
    exit 2
  }
  [ -f "$src" ] || {
    echo "scratchpad: <source-file> is not a regular file: $src" >&2
    exit 2
  }
  # A bare filename only: a slash would land the file somewhere other than the
  # entry the caller named, which is precisely the stranded-write this primitive
  # exists to prevent. `.` and `..` name a directory instead, and the no-clobber
  # guard below would catch them anyway — but only to report "refusing to
  # overwrite <entry>/..", which describes neither what was asked nor what is
  # wrong with it. They are named here so the diagnosis is the true one.
  case "$name" in
    */* | . | ..)
      echo "scratchpad: <filename> must be a bare filename (got '$name')" >&2
      exit 2
      ;;
  esac

  # Containment. Resolved with `pwd -P` rather than realpath(1), whose flags and
  # availability differ across BSD and GNU; symlinked temp dirs (macOS /var) also
  # resolve here, so the prefix comparison is against real paths on both sides.
  local root sp entry_abs
  root="$(main_worktree_root)"
  sp="$(cd "$root/$SP_DIR" 2>/dev/null && pwd -P)" || {
    echo "scratchpad: no $SP_DIR root under $root" >&2
    exit 1
  }
  entry_abs="$(cd "$entry" && pwd -P)"
  # Two levels below the root, because that is the only depth `list` and `clean`
  # can see: both match `-type d` at exactly <domain>/<entry>, so a file dropped
  # at the root or in a bare domain directory is invisible to one and
  # unreclaimable by the other — litter this primitive could never sweep up.
  # Anything deeper is fine; `clean` removes the entry above it wholesale.
  #
  # Trailing slash on every arm so a match can only land on a path boundary:
  # `/a/scratchpad-evil` must not read as living inside `/a/scratchpad`.
  case "$entry_abs/" in
    "$sp"/*/*/) ;;
    "$sp"/*)
      echo "scratchpad: <entry-dir> must be an entry, not the scratchpad root or a bare domain: $entry_abs" >&2
      exit 1
      ;;
    *)
      echo "scratchpad: <entry-dir> is outside the scratchpad root $sp: $entry_abs" >&2
      exit 1
      ;;
  esac

  local dest="$entry_abs/$name"
  # Refuse rather than clobber: a silent overwrite of a prior handoff is
  # unrecoverable, and the caller can always place under a different name. The -L
  # arm covers a dangling symlink, which -e calls absent: `mv` across filesystems
  # copies THROUGH such a link, landing the bytes wherever it points.
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    echo "scratchpad: refusing to overwrite $dest" >&2
    exit 1
  fi
  mv "$src" "$dest"
  printf '%s\n' "$dest"
}

cmd_list() {
  local domain="${1:-}" root sp search md
  root="$(main_worktree_root)"
  sp="$root/$SP_DIR"
  [ -d "$sp" ] || return 0
  if [ -n "$domain" ]; then
    search="$sp/$domain"
    md=1
  else
    search="$sp"
    md=2
  fi
  [ -d "$search" ] || return 0
  # Sort by basename (the timestamp prefix ⇒ chronological) descending.
  find "$search" -mindepth "$md" -maxdepth "$md" -type d 2>/dev/null |
    while IFS= read -r d; do printf '%s\t%s\n' "$(basename "$d")" "$d"; done |
    sort -r |
    cut -f2-
}

cmd_clean() {
  local domain="" age="" force=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --older-than)
        age="${2:-}"
        shift 2
        ;;
      --force)
        force=1
        shift
        ;;
      -*)
        echo "scratchpad: unknown flag $1" >&2
        exit 2
        ;;
      *)
        domain="$1"
        shift
        ;;
    esac
  done
  [ -n "$age" ] || {
    echo "scratchpad: clean requires --older-than <age> (e.g. 14d)" >&2
    exit 2
  }

  local root sp threshold search md
  root="$(main_worktree_root)"
  sp="$root/$SP_DIR"
  [ -d "$sp" ] || {
    echo "nothing to clean (no $SP_DIR)"
    return 0
  }
  threshold="$(parse_age_minutes "$age")"
  if [ -n "$domain" ]; then
    search="$sp/$domain"
    md=1
  else
    search="$sp"
    md=2
  fi
  [ -d "$search" ] || {
    echo "nothing to clean"
    return 0
  }

  local findargs any=0 d
  findargs=(-mindepth "$md" -maxdepth "$md" -type d)
  if [ "$threshold" -gt 0 ]; then
    findargs+=(-mmin "+$threshold")
  fi
  while IFS= read -r d; do
    any=1
    if [ "$force" -eq 1 ]; then
      rm -rf "$d"
      printf 'removed %s\n' "$d"
    else
      printf 'would remove %s\n' "$d"
    fi
  done < <(find "$search" "${findargs[@]}" 2>/dev/null | sort)
  if [ "$any" -eq 0 ]; then
    echo "nothing matched"
  elif [ "$force" -eq 0 ]; then
    echo "(dry run — re-run with --force to delete)"
  fi
}

main() {
  set_sp_dir "${SCRATCHPAD_DIR:-.scratchpad}"
  if [ "${1:-}" = "--dir" ]; then
    [ $# -ge 2 ] || usage
    set_sp_dir "$2"
    shift 2
  fi
  local cmd="${1:-}"
  [ -n "$cmd" ] || usage
  shift
  case "$cmd" in
    root) cmd_root "$@" ;;
    new) cmd_new "$@" ;;
    place) cmd_place "$@" ;;
    list) cmd_list "$@" ;;
    clean) cmd_clean "$@" ;;
    -h | --help | help) usage ;;
    *)
      echo "scratchpad: unknown command '$cmd'" >&2
      usage
      ;;
  esac
}

main "$@"

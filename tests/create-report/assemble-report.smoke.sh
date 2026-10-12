#!/usr/bin/env bash
#
# Smoke test for assemble-report.sh — the guarantees a report author relies on without
# checking: both targets carry the same content, the publish source stays free of the
# local-only mermaid loader, a title survives either route without double-escaping, and
# a whole document is refused with an explanation rather than nested silently.
# Self-cleaning; exits non-zero if any assertion failed. Run through `node --test tests/`
# (tests/create-report.test.mjs), or directly:
#   bash tests/create-report/assemble-report.smoke.sh

set -euo pipefail

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../skills/core/create-report" && pwd)"
assemble="$skill/scripts/assemble-report.sh"
work="$(mktemp -d)"
fails=0

trap 'rm -rf "$work"' EXIT

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

# The guards below exist because a grep result alone cannot separate a real verdict from a
# broken check: `file_lacks` would pass on a file that was never written, and `file_has`
# would pass on an empty substring.
file_has() { # file_has <path> <substring> — the file exists and contains the substring
  [ -n "${2:-}" ] || return 1
  [ -f "$1" ] || return 1
  grep -qF -- "$2" "$1"
}

file_lacks() { # file_lacks <path> <substring> — the file exists and does not contain it
  [ -n "${2:-}" ] || return 1
  [ -f "$1" ] || return 1
  ! grep -qF -- "$2" "$1"
}

cat >"$work/content.html" <<'CONTENT'
<div class="r-page">
  <header class="r-header"><h1 class="r-header__title">Sample &amp; <em>study</em></h1></header>
  <main class="r-stack">
    <figure class="r-figure">
      <div class="r-figure__frame r-figure__frame--mermaid">
        <pre class="mermaid">flowchart LR
  A --> B</pre>
      </div>
    </figure>
  </main>
</div>
CONTENT

printf '<div class="r-page"><p>No heading in this one.</p></div>\n' >"$work/plain.html"
printf '<!doctype html>\n<html>\n<body><p>whole document</p></body>\n</html>\n' >"$work/whole.html"

# --- both targets, from one authored file ------------------------------------------

"$assemble" "$work/content.html" "$work/out" >"$work/out.log" 2>&1

check 'local document is written' [ -f "$work/out/report.html" ]
check 'publish source is written' [ -f "$work/out/report.page.html" ]
check 'both paths are reported to the caller' \
  grep -q 'Publish source' "$work/out.log"

check 'local document is a whole document' file_has "$work/out/report.html" '<!doctype html>'
check 'publish source carries no document wrapper' \
  file_lacks "$work/out/report.page.html" '<!doctype html>'

check 'local document carries the content' file_has "$work/out/report.html" 'r-figure__frame--mermaid'
check 'publish source carries the same content' \
  file_has "$work/out/report.page.html" 'r-figure__frame--mermaid'

check 'local document inlines the foundation stylesheet' \
  file_has "$work/out/report.html" '--r-ink'
check 'publish source inlines the foundation stylesheet' \
  file_has "$work/out/report.page.html" '--r-ink'

# The loader exists so a local file renders mermaid; the published page renders mermaid
# natively and reaches no other host, so a loader there would point at a blocked origin.
check 'local document loads mermaid for viewing' file_has "$work/out/report.html" 'mermaid.esm.min.mjs'
check 'publish source stays free of the loader' \
  file_lacks "$work/out/report.page.html" 'mermaid.esm.min.mjs'

# --- titles ------------------------------------------------------------------------

check 'title comes from the first h1, with its markup stripped' \
  file_has "$work/out/report.page.html" '<title>Sample &amp; study</title>'
check 'an h1 entity is not escaped a second time' \
  file_lacks "$work/out/report.page.html" '&amp;amp;'

"$assemble" "$work/plain.html" "$work/plain-out" --title 'Explicit <Title> & Co' >/dev/null 2>&1
check 'an explicit title overrides, escaped as the plain text it is' \
  file_has "$work/plain-out/report.page.html" '<title>Explicit &lt;Title&gt; &amp; Co</title>'
check 'content without a mermaid block gets no loader' \
  file_lacks "$work/plain-out/report.html" 'mermaid.esm.min.mjs'

# --- titles that must not reach the publish step ------------------------------------

# The title becomes the artifact's public name, so every shape that is not a heading has to
# land on the fallback rather than ship. Each of these published the whole page text, or a
# fragment of an attribute, before the extraction required a well-formed heading.
printf '<div class="r-page"><H1>Upper Title</H1><p>body prose after it</p></div>\n' >"$work/upper.html"
"$assemble" "$work/upper.html" "$work/upper-out" >/dev/null 2>&1
check 'an uppercase H1 is still recognised as the heading' \
  file_has "$work/upper-out/report.page.html" '<title>Upper Title</title>'
check 'an uppercase H1 does not swallow the body' \
  file_lacks "$work/upper-out/report.page.html" 'body prose after it</title>'

printf '<div class="r-page"><h1>Unclosed<p>body prose that is not a title</p></div>\n' >"$work/unclosed.html"
"$assemble" "$work/unclosed.html" "$work/unclosed-out" >/dev/null 2>&1
check 'a heading with no closing tag falls back rather than taking the document' \
  file_has "$work/unclosed-out/report.page.html" '<title>Report</title>'

printf '<div class="r-page"><h1 data-x="a>b">Real Title</h1></div>\n' >"$work/attr.html"
"$assemble" "$work/attr.html" "$work/attr-out" >/dev/null 2>&1
check 'an angle bracket inside an attribute falls back rather than leaking into the title' \
  file_has "$work/attr-out/report.page.html" '<title>Report</title>'

# The gate that decides a heading exists is line-oriented, while the extraction under it reads a
# flattened copy. A formatter puts a multi-attribute tag's attributes on their own lines — the
# shape this skill's own references teach — so the two must agree about that shape or a correct
# heading silently publishes as the fallback.
cat >"$work/wrapped.html" <<'WRAPPED'
<div class="r-page">
  <h1
    class="r-header__title"
    id="report-title"
  >
    A title whose tag a formatter wrapped
  </h1>
</div>
WRAPPED
"$assemble" "$work/wrapped.html" "$work/wrapped-out" >/dev/null 2>&1
check 'a heading whose tag was wrapped across lines still yields its title' \
  file_has "$work/wrapped-out/report.page.html" '<title>A title whose tag a formatter wrapped</title>'

# --- external references the CSS forms hide -----------------------------------------

# A consumer's own styles arrive as a <style> block in the page content, so the likeliest
# external reference on the page is a hosted font — a form the markup-only guard could not see.
cat >"$work/remote-css.html" <<'REMOTE'
<div class="r-page">
  <style>
    @import url("https://fonts.googleapis.invalid/css2?family=X");
    .x { background-image: url(https://cdn.example.invalid/bg.png); }
  </style>
  <img src='https://single.invalid/a.png' alt="one" />
  <img src="//protocol.invalid/b.png" alt="two" />
  <p><a href="https://example.invalid/page">A link in prose fetches nothing.</a></p>
</div>
REMOTE
"$assemble" "$work/remote-css.html" "$work/remote-css-out" >"$work/remote-css.log" 2>&1
for host in fonts.googleapis.invalid cdn.example.invalid single.invalid protocol.invalid; do
  check "a subresource on $host is reported" grep -q "$host" "$work/remote-css.log"
done
check 'a link in prose is not reported, since it fetches nothing' \
  file_lacks "$work/remote-css.log" 'example.invalid/page'

printf "<div class=\"r-page\"><pre class='mermaid'>flowchart LR\n  A --> B</pre></div>\n" \
  >"$work/mermaid-sq.html"
"$assemble" "$work/mermaid-sq.html" "$work/mermaid-sq-out" >/dev/null 2>&1
check 'a single-quoted mermaid block still gets the local loader' \
  file_has "$work/mermaid-sq-out/report.html" 'mermaid.esm.min.mjs'

# --- a report the size of a real one -------------------------------------------------

# Every fixture above fits in a pipe buffer, which is exactly where a premature reader
# hides: the writer finishes before the pipe ever closes. A real report is far larger, so
# one oversized case stands in for the reports this script actually gets handed.
{
  printf '<div class="r-page">\n<h1>Large report &amp; its title</h1>\n'
  i=0
  while [ "$i" -lt 900 ]; do
    printf '<article class="r-entry"><h3 class="r-entry__title">Entry %d</h3><p>%s</p></article>\n' \
      "$i" 'Body text repeated so the content exceeds a pipe buffer by a wide margin.'
    i=$((i + 1))
  done
  printf '</div>\n'
} >"$work/large.html"

check 'the fixture is genuinely larger than a pipe buffer' \
  [ "$(wc -c <"$work/large.html")" -gt 131072 ]

if "$assemble" "$work/large.html" "$work/large-out" >"$work/large.log" 2>&1; then
  check 'a large report still derives its title from the h1' \
    file_has "$work/large-out/report.page.html" '<title>Large report &amp; its title</title>'
  check 'a large report produces its local document' [ -f "$work/large-out/report.html" ]
else
  printf 'FAIL — a large report assembles (exit %d)\n' "$?"
  fails=$((fails + 1))
fi

# --- refusals and warnings ----------------------------------------------------------

if "$assemble" "$work/whole.html" "$work/whole-out" >"$work/whole.log" 2>&1; then
  printf 'FAIL — a whole document is refused\n'
  fails=$((fails + 1))
else
  check 'a whole document is refused with the fix in the message' \
    grep -q 'page content only' "$work/whole.log"
fi

# A document whose tag attributes were wrapped reaches the same guard by a different shape, and a
# line-anchored pattern would let it through into a wrapper it must not be nested in.
# No doctype, and both tags wrapped: the shapes the pattern's character class has to reach on its
# own, since `<!doctype` would otherwise catch this document before either tag is examined.
cat >"$work/whole-wrapped.html" <<'WHOLEWRAP'
<html
  lang="en"
>
  <body
    class="report"
  >
    <p>whole document, attributes wrapped</p>
  </body>
</html>
WHOLEWRAP
if "$assemble" "$work/whole-wrapped.html" "$work/whole-wrapped-out" >"$work/whole-wrapped.log" 2>&1; then
  printf 'FAIL — a whole document with wrapped tag attributes is refused\n'
  fails=$((fails + 1))
else
  check 'a whole document with wrapped tag attributes is refused' \
    grep -q 'page content only' "$work/whole-wrapped.log"
fi

# The reasons a report cannot render at its destination are worth pinning, since each was added in
# response to a real failure and nothing else in the suite would notice their removal.
"$assemble" "$work/attr.html" "$work/attr-stderr-out" 2>"$work/attr.stderr" >/dev/null
check 'a refused title says so and names the way through' \
  grep -q -- '--title' "$work/attr.stderr"

printf '<div class="r-page"><img srcset="https://srcset.invalid/a.png 2x" alt="remote" /></div>\n' \
  >"$work/srcset.html"
"$assemble" "$work/srcset.html" "$work/srcset-out" >"$work/srcset.log" 2>&1
check 'a srcset on another host is reported, since it fetches like src does' \
  grep -q 'srcset.invalid' "$work/srcset.log"

long_heading="$(printf 'A very long heading %.0s' 1 2 3 4 5 6 7 8 9 10 11 12)"
printf '<div class="r-page"><h1>%s</h1></div>\n' "$long_heading" >"$work/longtitle.html"
check 'the long-heading fixture is genuinely past the ceiling' \
  [ "${#long_heading}" -gt 200 ]
"$assemble" "$work/longtitle.html" "$work/longtitle-out" >/dev/null 2>&1
check 'a title past the ceiling falls back rather than becoming the artifact name' \
  file_has "$work/longtitle-out/report.page.html" '<title>Report</title>'

printf '<div class="r-page"><img src="https://example.invalid/x.png" alt="remote" /></div>\n' \
  >"$work/remote.html"
"$assemble" "$work/remote.html" "$work/remote-out" >"$work/remote.log" 2>&1
check 'a subresource on another host is named, since a published page cannot reach it' \
  grep -q 'example.invalid' "$work/remote.log"
check 'the warning leaves the report assembled' [ -f "$work/remote-out/report.html" ]

# --- the foundation itself ----------------------------------------------------------

# The mermaid frame locks itself to light by restating token values, which is a second
# copy of the light palette and therefore drifts silently when the palette is re-skinned.
# Every value it restates has to be one the light theme actually defines.
# Takes the stylesheet as an argument so the guard itself can be exercised against a fixture:
# a check that only ever reads the real file cannot show that it would catch a bad one.
frame_palette_matches_light() {
  local css="${1:-$skill/assets/report-base.css}" hex found
  local light frame
  light="$(awk '/^:root \{/ { inside = 1 } inside && /^\}/ { exit } inside' "$css")"
  frame="$(awk '/^\.r-figure__frame--mermaid \{/ { inside = 1 } inside && /^\}/ { exit } inside' "$css")"
  [ -n "$light" ] && [ -n "$frame" ] || return 1
  # Membership is tested by bash rather than by piping into `grep -q`. A matching grep exits
  # immediately, the writer upstream takes EPIPE, and under pipefail the whole pipeline reports
  # failure — so the guard would fail at random on a tree where nothing is wrong, and say so
  # about a value sitting three lines above it. That is the hazard assemble-report.sh documents
  # at its title extraction, reproduced here in the suite that tests it.
  #
  # The values are wrapped in delimiters first, because a bare substring test would accept `#fff`
  # against a palette holding `#ffffff` — passing a value the palette never defines.
  light=" $(printf '%s\n' "$light" | grep -oiE '#[0-9a-f]{6}' | tr 'A-F' 'a-f' | tr '\n' ' ') "
  # Both sides sweep the same shapes as the literal guard below, and case-fold. A value this
  # pattern cannot match is never extracted, so it is never examined — the guard would report ok
  # while the frame carried a colour the palette does not define, which fails open. A hand-edited
  # value is exactly where a shorthand or a stray capital comes from.
  found=0
  for hex in $(printf '%s\n' "$frame" | grep -oiE '#[0-9a-f]{3}([0-9a-f]{3})?\b' | tr 'A-F' 'a-f'); do
    found=$((found + 1))
    case "$light" in
      *" $hex "*) ;;
      *)
        printf '   %s is not a light-theme value\n' "$hex" >&2
        return 1
        ;;
    esac
  done
  # A frame that restates no value at all would satisfy the loop by never entering it. The block
  # exists to restate the light palette, so finding nothing means the guard stopped watching.
  [ "$found" -gt 0 ] || {
    printf '   the light-locked frame restates no palette value — nothing was compared\n' >&2
    return 1
  }
}

check 'the light-locked diagram frame restates only light-theme values' \
  frame_palette_matches_light

# The guard above reads the shipped stylesheet, so nothing it reports proves it would catch a bad
# one. These fixtures do. Each carries one value the palette defines alongside the offender, which
# keeps the vacuity floor satisfied either way: with only the offender present, a guard whose
# widening was reverted would extract nothing, trip the floor, and pass the fixture for a reason
# that has nothing to do with what the fixture claims to check.
cat >"$work/frame-bad.css" <<'FRAMEBAD'
:root {
  --r-ink: #0f172a;
  --r-surface: #ffffff;
}

.r-figure__frame--mermaid {
  --r-ink: #0f172a;
  --r-surface: #f00;
}
FRAMEBAD
if frame_palette_matches_light "$work/frame-bad.css" 2>/dev/null; then
  printf 'FAIL — the frame guard catches a shorthand the palette never defines\n'
  fails=$((fails + 1))
else
  printf 'ok   — the frame guard catches a shorthand the palette never defines\n'
fi

cat >"$work/frame-good.css" <<'FRAMEGOOD'
:root {
  --r-ink: #0f172a;
  --r-surface: #ffffff;
}

.r-figure__frame--mermaid {
  --r-ink: #0f172a;
}
FRAMEGOOD
check 'the frame guard stays green on a frame the palette does define' \
  frame_palette_matches_light "$work/frame-good.css"

cat >"$work/frame-empty.css" <<'FRAMEEMPTY'
:root {
  --r-ink: #0f172a;
}

.r-figure__frame--mermaid {
  --r-ink: var(--x);
}
FRAMEEMPTY
if frame_palette_matches_light "$work/frame-empty.css" 2>/dev/null; then
  printf 'FAIL — the frame guard notices when it has nothing to compare\n'
  fails=$((fails + 1))
else
  printf 'ok   — the frame guard notices when it has nothing to compare\n'
fi

cat >"$work/frame-upper.css" <<'FRAMEUPPER'
:root {
  --r-ink: #0f172a;
}

.r-figure__frame--mermaid {
  --r-ink: #0f172a;
  --r-surface: #CC1111;
}
FRAMEUPPER
if frame_palette_matches_light "$work/frame-upper.css" 2>/dev/null; then
  printf 'FAIL — the frame guard compares an uppercase hex rather than skipping it\n'
  fails=$((fails + 1))
else
  printf 'ok   — the frame guard compares an uppercase hex rather than skipping it\n'
fi

# Mermaid draws with its own palette, so the references and the sample name colors literally
# where no token can reach — a third copy, and the one a report author actually reads. A
# re-skin that updates the stylesheet and leaves these behind keeps the check above green
# while teaching the next author the old palette.
literal_colors_are_defined() {
  local css="$skill/assets/report-base.css" hex file found guarded
  local -a scanned=("$@")
  local palette
  palette="$(awk '/^:root \{/ { inside = 1 } inside && /^\}/ { exit } inside' "$css")
$(awk '/^\.r-figure__frame--mermaid \{/ { inside = 1 } inside && /^\}/ { exit } inside' "$css")"
  [ -n "$palette" ] || return 1
  # Reduced to a delimited list of its own values, lowercased, so membership below is exact and
  # needs no pipe: a bare substring test would accept `#fff` against a palette holding `#ffffff`.
  palette=" $(printf '%s\n' "$palette" | grep -oiE '#[0-9a-f]{6}' | tr 'A-F' 'a-f' | tr '\n' ' ') "
  guarded=0
  # Three-digit hexes are swept too. None can match a palette that spells every value in six, so
  # one shortens into a failure rather than slipping past the pattern unexamined.
  # With no argument this scans the shipped files and anchors its floor to the one whose mermaid
  # guidance the check exists to protect. Given files explicitly, the caller chose them, so the
  # floor is simply that something was examined.
  local anchor='*report-format.md'
  if [ "${#scanned[@]}" -eq 0 ]; then
    scanned=(
      "$skill/references/report-format.md"
      "$skill/references/components.md"
      "$skill/assets/sample/content.html"
    )
  else
    anchor='*'
  fi
  for file in "${scanned[@]}"; do
    [ -f "$file" ] || return 1
    found=0
    for hex in $(
      {
        grep -oiE '#[0-9a-f]{6}\b' "$file" || true
        # Three hex characters are also `#549` and `#add`, so a shorthand counts only where it
        # stands as a value — after a colon or a comma, or inside a code span. An opening paren
        # is deliberately not a value position: it is how a markdown link introduces its anchor.
        grep -oiE '[:,`][[:space:]]*#[0-9a-f]{3}\b' "$file" | grep -oiE '#[0-9a-f]{3}\b' || true
      } | tr 'A-F' 'a-f' | sort -u
    ); do
      found=$((found + 1))
      case "$palette" in
        *" $hex "*) ;;
        *)
          printf '   %s in %s is not a value the palette defines\n' "$hex" "${file##*/}" >&2
          return 1
          ;;
      esac
    done
    case "$file" in $anchor) guarded=$((guarded + found)) ;; esac
  done
  # A sweep that examined nothing would pass without checking anything. The mermaid guidance in
  # report-format.md is the copy this check exists for, so its literals are what must be present —
  # a total across all three files would let one literal elsewhere carry the floor.
  [ "$guarded" -gt 0 ]
}

check 'color literals in the references and sample are values the palette defines' \
  literal_colors_are_defined

# Like the frame guard, this one reads the shipped references, so nothing it reports shows what it
# would do with a file that is wrong. The fixture carries the two shapes that decide the sweep: a
# shorthand standing as a value, which must be caught, and the same three characters as a markdown
# anchor and a ticket number, which must not — `#` plus three hex characters cannot tell a colour
# from either, so only the position does.
cat >"$work/anchor.md" <<'ANCHORMD'
Mermaid draws with its own palette, so name the colour literally: `classDef marked stroke:#dc2626`.
ANCHORMD
check 'the literal sweep accepts a reference whose literals the palette defines' \
  literal_colors_are_defined "$work/anchor.md"

cat >"$work/anchor-prose.md" <<'ANCHORPROSE'
Mermaid draws with its own palette: `classDef marked stroke:#dc2626`.

See [the closing section](#add) for the wrap-up, and ticket #549 for the history.
ANCHORPROSE
check 'a markdown anchor and a ticket number are not read as colours' \
  literal_colors_are_defined "$work/anchor-prose.md"

cat >"$work/anchor-bad.md" <<'ANCHORBAD'
Mermaid draws with its own palette: `classDef marked stroke:#dc2626`.

A shorthand standing as a value: `classDef other stroke:#f0a`.
ANCHORBAD
if literal_colors_are_defined "$work/anchor-bad.md" 2>/dev/null; then
  printf 'FAIL — a shorthand standing as a value is still caught\n'
  fails=$((fails + 1))
else
  printf 'ok   — a shorthand standing as a value is still caught\n'
fi

check 'the stylesheet reaches no external host' \
  file_lacks "$skill/assets/report-base.css" 'http'
check 'the stylesheet imports nothing' \
  file_lacks "$skill/assets/report-base.css" '@import'

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf 'assemble-report smoke: all checks passed\n'
else
  printf 'assemble-report smoke: %d check(s) failed\n' "$fails"
  exit 1
fi

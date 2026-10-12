#!/usr/bin/env bash
#
# Assemble a report page into the two shapes its two destinations want.
#
# The author writes page content only. This script emits:
#   report.page.html — title, the inlined foundation stylesheet, then the content. This is what
#                      gets published: a hosted surface such as Claude's artifacts supplies the wrapper.
#   report.html      — the same, wrapped as a standalone document for opening locally, plus a
#                      mermaid loader when the content has a mermaid block. The loader is local-only
#                      because a hosted surface renders mermaid natively and reaches no CDN.
#
# Keeping both shapes derived from one authored file is what lets a revision regenerate the page
# and republish it without the two copies drifting apart.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly BASE_CSS="${SCRIPT_DIR}/../assets/report-base.css"

usage() {
  cat <<'USAGE'
Usage: assemble-report.sh <content.html> <output-dir> [--title "Report title"]

  <content.html>  page content — the elements that live inside <body>, typically one
                  <div class="r-page"> wrapper. Not a whole HTML document.
  <output-dir>    where report.page.html and report.html are written. Created if missing.
  --title         overrides the title, which otherwise comes from the first <h1>.
USAGE
}

fail() {
  printf 'assemble-report: %s\n\n' "$1" >&2
  usage >&2
  exit 1
}

content=""
outdir=""
title=""

while [ $# -gt 0 ]; do
  case "$1" in
    --title)
      [ $# -ge 2 ] || fail "--title needs a value"
      title="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      if [ -z "$content" ]; then
        content="$1"
      elif [ -z "$outdir" ]; then
        outdir="$1"
      else
        fail "unexpected argument: $1"
      fi
      shift
      ;;
  esac
done

[ -n "$content" ] && [ -n "$outdir" ] || fail "content file and output directory are both required"
[ -f "$content" ] || fail "content file not found: $content"
[ -f "$BASE_CSS" ] || fail "foundation stylesheet not found: $BASE_CSS"

# A whole document here means the two shapes got confused: a hosted surface would nest this
# inside its own wrapper.
# The tag shapes accept a line ending for the same reason the title gate does: a formatter puts a
# multi-attribute tag's attributes on their own lines, and a line-anchored pattern would wave that
# document straight through into the wrapper it must not be nested in.
if grep -qiE '<!doctype|<html([[:space:]>]|$)|<body([[:space:]>]|$)' "$content"; then
  fail "$content looks like a whole HTML document. Pass page content only — the elements inside
<body> — and this script will produce both the local document and the publish source."
fi

# A title given on the command line is plain text and needs escaping; one lifted out of the <h1> is
# already markup-safe, and escaping it again turns its entities into visible &amp;amp;.
title_html=""
if [ -n "$title" ]; then
  title_html="$(printf '%s' "$title" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
else
  # Both the opening tag and the closing separator match either case, because a mismatch
  # between them silently turns "find the heading" into "take the rest of the document".
  # The opening tag may also end its line: a formatter puts a multi-attribute tag's
  # attributes on their own lines, and the extraction below flattens newlines anyway, so a
  # line-anchored gate would refuse a heading the extraction can read perfectly well.
  if grep -qiE '<h1([[:space:]>]|$)' "$content" && grep -qi '</h1>' "$content"; then
    # awk reads to the end rather than exiting at the first record on purpose: quitting
    # early closes the pipe under `tr`, which then dies of SIGPIPE and, with pipefail,
    # takes the whole script down. Only content larger than a pipe buffer reaches that
    # race, so it hides from every small fixture and appears on the first real report.
    title_html="$(
      tr '\n' ' ' <"$content" |
        awk 'BEGIN { RS = "</[hH]1>" } NR == 1 {
          sub(/.*<[hH]1[^>]*>/, "")
          gsub(/<[^>]*>/, "")
          gsub(/^[ \t]+|[ \t]+$/, "")
          gsub(/[ \t]+/, " ")
          print
        }'
    )"
  fi

  # Whatever survives has to look like a heading rather than a document. A stray angle
  # bracket means the opening tag carried one inside a quoted attribute and the extraction
  # cut in the wrong place; excessive length means it ran past a heading it never found the
  # end of. Both publish as the artifact's name, so both fall back rather than ship.
  case "$title_html" in *'<'* | *'>'*) title_html="" ;; esac
  [ "${#title_html}" -le 200 ] || title_html=""
  if [ -z "$title_html" ]; then
    title_html="Report"
    # A heading carrying an angle bracket of its own — "Intake > Router" — lands here beside the
    # malformed shapes, and the fallback would become the artifact's public name in silence.
    printf 'assemble-report: could not read a title from the first <h1>, using "Report".\n' >&2
    printf 'Pass --title "…" to set it.\n\n' >&2
  fi
fi

mkdir -p "$outdir"
page="${outdir}/report.page.html"
local_doc="${outdir}/report.html"

{
  printf '<title>%s</title>\n<style>\n' "$title_html"
  cat "$BASE_CSS"
  printf '</style>\n\n'
  cat "$content"
} >"$page"

{
  printf '<!doctype html>\n<html lang="en">\n  <head>\n'
  printf '    <meta charset="utf-8" />\n'
  printf '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
  printf '    <title>%s</title>\n    <style>\n' "$title_html"
  cat "$BASE_CSS"
  printf '    </style>\n'
  # Either quote, because missing the block would leave the local file showing diagram source as
  # text while the published page renders it — the one divergence between the two shapes.
  if grep -qE "class=[\"']?mermaid" "$content"; then
    cat <<'MERMAID'
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: true, theme: 'neutral', securityLevel: 'loose' });
    </script>
MERMAID
  fi
  printf '  </head>\n  <body>\n'
  cat "$content"
  printf '\n  </body>\n</html>\n'
} >"$local_doc"

# Subresources are the only external references that break: a published page reaches no other host,
# so a remote stylesheet, script, image, or font silently goes missing there while looking fine
# locally. Links in prose fetch nothing and are not reported.
#
# The CSS forms matter as much as the markup ones, because a consumer's own styles arrive as a
# <style> block in the page content, and a hosted font is the likeliest thing an author reaches for
# there. Quoting varies and a protocol-relative `//host` inherits the page's scheme, so all three
# patterns accept either quote, or none, and treat a bare `//` as external.
readonly Q="'"
remote_subresources="$(
  {
    grep -oiE "<(img|script|link|source|iframe|video|audio|embed)[^>]+(src|srcset|href)[[:space:]]*=[[:space:]]*[\"$Q]?(https?:)?//[^\"$Q >]+" "$content" || true
    grep -oiE "@import[^;]{0,200}[\"$Q(](https?:)?//[^\"$Q)]+" "$content" || true
    grep -oiE "url\([[:space:]]*[\"$Q]?(https?:)?//[^\"$Q)]+" "$content" || true
  } | sort -u
)"
if [ -n "$remote_subresources" ]; then
  printf 'assemble-report: these subresources load from another host and will be missing on a published page:\n' >&2
  printf '%s\n' "$remote_subresources" | sed 's/^/  /' >&2
  printf 'Inline them (or embed as a data: URI) to have the page render the same at both destinations.\n\n' >&2
fi

printf 'Local document : %s\n' "$local_doc"
printf 'Publish source : %s\n' "$page"

#!/usr/bin/env python3
"""Cadence and tell profiler for the `humanize` skill.

Reports the observable properties that make prose read as machine-written:
sentence-length distribution and its variance, paragraph rhythm, how often
sentences open the same way, contraction rate, and every hit from the tell
corpus in tells.json. The model reads this and decides what to rewrite.

Deliberately emits no "percent human" score. Nothing here was calibrated
against a labelled corpus, so a single number would be invented, and an
invented number is believed. Absolute cadence figures mean little on their
own; pass --baseline with the author's own real writing and read the deltas,
which is the only comparison this script can make honestly.

Stdlib only, no venv.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import unicodedata
from collections import Counter
from pathlib import Path

# Splitting on [.!?] alone breaks on these, inflating the short-sentence share
# and understating mean length. Protected by substitution before the split.
ABBREVIATIONS = [
    "Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "St.",
    "e.g.", "i.e.", "etc.", "vs.", "cf.", "approx.", "est.",
    "Inc.", "Ltd.", "Co.", "Corp.", "LLC.", "No.",
    "a.m.", "p.m.", "U.S.", "U.K.", "E.U.", "Ph.D.",
]

SENTENCE_BREAK = re.compile(r'(?<=[.!?])["\')\]]*[ \t]+(?=["\'(\[]*[A-Z0-9])')
CONTRACTION = re.compile(r"\b\w+['’](d|ll|m|re|s|t|ve)\b", re.IGNORECASE)
WORD = re.compile(r"[A-Za-z][A-Za-z'’-]*")

# Handling order, strictest first. A tell's tier decides what happens to it,
# not how confidently it fires: see references/tiers.md.
TIER_ORDER = ["house", "forensic", "strict", "aesthetic"]

STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can",
    "do", "for", "from", "had", "has", "have", "he", "her", "his", "i", "if",
    "in", "is", "it", "its", "me", "my", "no", "not", "of", "on", "or", "our",
    "she", "so", "than", "that", "the", "their", "them", "then", "there",
    "they", "this", "to", "up", "was", "we", "were", "what", "when", "which",
    "who", "will", "with", "would", "you", "your",
}


FRONTMATTER = re.compile(r"\A---\n.*?\n---\n", re.DOTALL)
FENCED_CODE = re.compile(r"```.*?```", re.DOTALL)
LIST_ITEM = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+")
# `* * *` and `- - -` are thematic breaks. They look like a list item opening a
# list, and reading them as one keeps the mask out of a block that follows.
THEMATIC_BREAK = re.compile(r"^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$")
INLINE_CODE = re.compile(r"`[^`\n]+`")
LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
URL = re.compile(r"https?://\S+")
HEADING = re.compile(r"(?m)^\s*#{1,6}\s.*$")
TABLE_OR_CALLOUT = re.compile(r"(?m)^\s*[|>].*$")


def blank(span: str) -> str:
    """Same-length filler keeping every newline, so offsets survive the mask."""
    return "".join("\n" if ch == "\n" else " " for ch in span)


def keep_head(head: str, span: str) -> str:
    """`head`, padded or truncated to the length of what it replaces."""
    head = head[: len(span)]
    return head + blank(span[len(head):])


def blank_indented_code(text: str) -> str:
    """Blank indented code blocks, the way Markdown decides what one is.

    A four-space indent is code only where it opens a block: after a blank line,
    with no list open. Inside a list the same indent is a nested item or a
    continuation line, which is prose a rewrite must still see. Matching the
    indent alone masks those lines too, and a barred character on one of them
    then passes the step-3 gate unseen.
    """
    out = []
    in_list = False
    in_code = False
    prev_blank = True
    for line in text.split("\n"):
        if not line.strip():
            out.append(line)
            prev_blank = True
            continue
        # Tabs count as indentation in Markdown, so measure the expanded line.
        expanded = line.expandtabs(4)
        indent = len(expanded) - len(expanded.lstrip(" "))
        # A thematic break is excluded from the list test rather than handled
        # first: handling it first closed a list it was sitting inside, and the
        # next indented line then opened a code block over real prose. A
        # top-level break still ends the list by falling through to `indent == 0`.
        if LIST_ITEM.match(line) and not THEMATIC_BREAK.match(line):
            in_list, in_code = True, False
        elif indent == 0:
            in_list, in_code = False, False
        if in_code:
            in_code = indent >= 4
        elif not in_list and indent >= 4 and prev_blank:
            in_code = True
        out.append(blank(line) if in_code else line)
        prev_blank = False
    return same_length(text, "\n".join(out))


def same_length(before: str, after: str) -> str:
    # Line numbers are read off the masked text and reported against the raw
    # file, which is only sound while masking is length-preserving.
    if len(before) != len(after):
        raise SystemExit("cadence.py: internal error: masking changed the text length")
    return after


def mask_non_prose(text: str, keep_code: bool) -> str:
    """Blank what a rewrite must never touch: frontmatter, code, and URLs.

    Headings and tables survive here on purpose. A `house` or `forensic` tell is
    a defect wherever it sits, and a barred character in a heading is still
    barred.
    """
    out = FRONTMATTER.sub(lambda m: blank(m.group(0)), text)
    if not keep_code:
        out = FENCED_CODE.sub(lambda m: blank(m.group(0)), out)
        out = blank_indented_code(out)
    # Blanked rather than replaced with a stand-in word. A placeholder becomes
    # the most repeated content word in any document that uses inline code, and
    # that row is one the procedure acts on.
    out = INLINE_CODE.sub(lambda m: blank(m.group(0)), out)
    out = LINK.sub(lambda m: keep_head(m.group(1), m.group(0)), out)  # keep the label
    out = URL.sub(lambda m: blank(m.group(0)), out)
    return same_length(text, out)


def mask_to_prose(masked: str) -> str:
    """Drop what is not a sentence, so the rhythm figures measure prose alone."""
    out = HEADING.sub(lambda m: blank(m.group(0)), masked)
    out = TABLE_OR_CALLOUT.sub(lambda m: blank(m.group(0)), out)
    return same_length(masked, out)


def suppress(masked: str, preserve: list[str]) -> str:
    """Blank the project's own precise words before any tell is matched."""
    out = masked
    for term in preserve:
        out = re.sub(rf"\b{re.escape(term)}\b", lambda m: blank(m.group(0)), out,
                     flags=re.IGNORECASE)
    return same_length(masked, out)


def paragraphs_of(text: str) -> list[str]:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def sentences_of(block: str) -> list[str]:
    guarded = block
    for i, abbr in enumerate(ABBREVIATIONS):
        guarded = guarded.replace(abbr, f"\x00{i}\x00")
    guarded = re.sub(r"\s*\n\s*", " ", guarded)
    parts = SENTENCE_BREAK.split(guarded)
    out = []
    for part in parts:
        for i, abbr in enumerate(ABBREVIATIONS):
            part = part.replace(f"\x00{i}\x00", abbr)
        part = re.sub(r"^\s*[-*+]\s+", "", part).strip()
        if part:
            out.append(part)
    return out


def words_of(s: str) -> list[str]:
    return WORD.findall(s)


def describe(values: list[int]) -> dict:
    """Location, spread, and the two tails. Spread is the burstiness signal."""
    if not values:
        return {"n": 0}
    ordered = sorted(values)
    mean = statistics.fmean(values)
    stdev = statistics.pstdev(values) if len(values) > 1 else 0.0

    def pct(p: float) -> int:
        idx = min(len(ordered) - 1, max(0, round(p * (len(ordered) - 1))))
        return ordered[idx]

    return {
        "n": len(values),
        "mean": round(mean, 2),
        "median": round(statistics.median(values), 2),
        "stdev": round(stdev, 2),
        # Coefficient of variation: spread normalised by length, so texts of
        # different average sentence length stay comparable.
        "cv": round(stdev / mean, 3) if mean else 0.0,
        "min": ordered[0],
        "p10": pct(0.10),
        "p90": pct(0.90),
        "max": ordered[-1],
    }


def profile(text: str, tells: list[dict], keep_code: bool,
            preserve: list[str] | None = None, label: str = "draft") -> dict:
    # Two masks over one text. `prose` is what the rhythm figures measure;
    # `scannable` is what the tells are matched against. Both are the same
    # length as `text`, so every reported line number is a line in the file.
    masked = mask_non_prose(text, keep_code)
    prose = mask_to_prose(masked)
    scannable = suppress(masked, preserve or [])

    paras = paragraphs_of(prose)
    per_para = [sentences_of(p) for p in paras]
    sentences = [s for group in per_para for s in group]
    if not sentences:
        raise SystemExit(
            f"cadence.py: {label}: no prose found after stripping code, headings and tables")

    lengths = [len(words_of(s)) for s in sentences]
    lengths = [n for n in lengths if n > 0]
    if not lengths:
        raise SystemExit(f"cadence.py: {label}: no alphabetic words found in the prose")
    para_lengths = [sum(len(words_of(s)) for s in g) for g in per_para if g]
    all_words = words_of(prose)
    lower = [w.lower() for w in all_words]

    first_words = Counter(words_of(s)[0].lower() for s in sentences if words_of(s))
    first_bigrams = Counter(
        " ".join(w.lower() for w in words_of(s)[:2]) for s in sentences if len(words_of(s)) >= 2
    )
    repeated_openers = sum(c for w, c in first_words.items() if c > 1)

    # split("\n"), not splitlines(): splitlines also breaks on \v, \f and \x85,
    # which line_of does not count, and the two then disagree about which line a
    # hit sits on. The number stays right and the quote beside it does not.
    lines = text.split("\n")

    def line_of(offset: int) -> int:
        return text.count("\n", 0, offset) + 1

    hits = []
    for tell in tells:
        found = list(tell["_rx"].finditer(scannable))
        if not found:
            continue
        samples = []
        for m in found[:3]:
            ln = line_of(m.start())
            # Quoted from the raw file at the match's own offsets, which the
            # length-preserving mask guarantees are the same. Quoting the masked
            # text would show filler where a hit ran through inline code.
            samples.append({"line": ln, "match": text[m.start():m.end()][:60],
                            "context": lines[ln - 1].strip()[:120] if ln <= len(lines) else ""})
        hits.append({
            "id": tell["id"], "tier": tell["tier"], "category": tell["category"],
            "note": tell["note"], "swap": tell.get("swap"),
            "count": len(found), "samples": samples,
        })
    hits.sort(key=lambda h: (TIER_ORDER.index(h["tier"]), -h["count"], h["id"]))

    content = [w for w in lower if w not in STOPWORDS and len(w) > 3]
    word_total = max(1, len(all_words))

    return {
        "words": len(all_words),
        "sentences": describe(lengths),
        "short_sentence_share": round(sum(1 for n in lengths if n <= 7) / len(lengths), 3),
        "long_sentence_share": round(sum(1 for n in lengths if n >= 30) / len(lengths), 3),
        "paragraphs": describe(para_lengths),
        "single_sentence_paragraph_share": (
            round(sum(1 for g in per_para if len(g) == 1) / len(per_para), 3) if per_para else 0.0
        ),
        "openers": {
            "distinct_first_words": len(first_words),
            "repeated_opener_share": round(repeated_openers / len(sentences), 3),
            "top_first_words": first_words.most_common(6),
            "top_first_bigrams": [b for b in first_bigrams.most_common(5) if b[1] > 1],
        },
        "punctuation_per_100_words": {
            # Counted over `prose`, the same text the word total came from. Over
            # the raw file a colon-heavy code block reads as a punctuation habit.
            "contractions": round(100 * len(CONTRACTION.findall(prose)) / word_total, 2),
            "questions": round(100 * prose.count("?") / word_total, 2),
            "semicolons": round(100 * prose.count(";") / word_total, 2),
            "colons": round(100 * prose.count(":") / word_total, 2),
            "parentheticals": round(100 * prose.count("(") / word_total, 2),
            "exclamations": round(100 * prose.count("!") / word_total, 2),
        },
        "type_token_ratio": round(len(set(lower)) / word_total, 3),
        "top_repeated_content_words": [p for p in Counter(content).most_common(8) if p[1] > 2],
        "tells": hits,
        "tell_totals": {t: sum(h["count"] for h in hits if h["tier"] == t) for t in TIER_ORDER},
    }


# The flag marks a measure that moves with sample size on its own, so a draft
# and a baseline of different lengths differ on it even when the writing is
# identical. Extremes grow as more sentences are drawn, repeated openers
# accumulate, and vocabulary saturates. Read those rows only when the two texts
# are close in length.
COMPARED = [
    ("sentences.mean", "mean sentence length", False),
    ("sentences.cv", "sentence-length variation", False),
    ("sentences.min", "shortest sentence", True),
    ("sentences.max", "longest sentence", True),
    ("short_sentence_share", "share under 8 words", False),
    ("long_sentence_share", "share over 29 words", False),
    ("paragraphs.cv", "paragraph-length variation", False),
    ("openers.repeated_opener_share", "repeated sentence openers", True),
    ("punctuation_per_100_words.contractions", "contractions per 100 words", False),
    ("type_token_ratio", "type-token ratio", True),
]


def dig(d: dict, path: str):
    for key in path.split("."):
        d = d.get(key, {}) if isinstance(d, dict) else {}
    return d if isinstance(d, (int, float)) else None


def compare(draft: dict, baseline: dict) -> list[dict]:
    ratio = draft["words"] / max(1, baseline["words"])
    comparable = 0.5 <= ratio <= 2.0
    rows = []
    for path, label, length_sensitive in COMPARED:
        a, b = dig(draft, path), dig(baseline, path)
        if a is None or b is None:
            continue
        rows.append({
            "metric": label, "draft": a, "baseline": b,
            "delta": round(a - b, 3),
            "ratio": round(a / b, 2) if b else None,
            "unreliable_here": length_sensitive and not comparable,
        })
    return rows


def cell(quoted: str) -> str:
    """Make a quoted match safe for the table cell it lands in.

    The quote comes from the raw file, so it can carry a newline or a pipe, and
    either one ends the row early: the reader then sees a broken table rather
    than the hit. Escaped at render, not at capture, so `--format json` keeps
    the match exactly as it appeared.
    """
    return quoted.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")


def render(prof: dict, comparison: list[dict] | None, tier_notes: dict) -> str:
    s, p, o = prof["sentences"], prof["paragraphs"], prof["openers"]
    out = [
        f"# Cadence profile ({prof['words']} words, {s['n']} sentences)",
        "",
        "## Rhythm",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Sentence length: mean / median | {s['mean']} / {s['median']} |",
        f"| Sentence length: min / p10 / p90 / max | {s['min']} / {s['p10']} / {s['p90']} / {s['max']} |",
        f"| Sentence-length variation (CV) | {s['cv']} |",
        f"| Share under 8 words | {prof['short_sentence_share']} |",
        f"| Share over 29 words | {prof['long_sentence_share']} |",
        f"| Paragraph length: mean, CV | {p.get('mean')}, {p.get('cv')} |",
        f"| Single-sentence paragraphs | {prof['single_sentence_paragraph_share']} |",
        f"| Sentences opening with a repeated word | {o['repeated_opener_share']} |",
        f"| Most-used openers | {', '.join(f'{w} x{c}' for w, c in o['top_first_words'])} |",
        f"| Contractions per 100 words | {prof['punctuation_per_100_words']['contractions']} |",
        f"| Type-token ratio | {prof['type_token_ratio']} |",
        "",
    ]
    if o["top_first_bigrams"]:
        out += [f"Repeated two-word openers: {', '.join(f'{b} x{c}' for b, c in o['top_first_bigrams'])}", ""]
    if prof["top_repeated_content_words"]:
        out += [f"Repeated content words: {', '.join(f'{w} x{c}' for w, c in prof['top_repeated_content_words'])}", ""]

    out += ["## Tells", "",
            "Counts by tier: " + ", ".join(f"{t} {n}" for t, n in prof["tell_totals"].items()), ""]
    if not prof["tells"]:
        out += ["None matched.", ""]
    for tier in TIER_ORDER:
        group = [h for h in prof["tells"] if h["tier"] == tier]
        if not group:
            continue
        out += [f"### {tier}", "", tier_notes.get(tier, ""), "",
                "| Tell | n | First hit | Note | Try |", "|---|---|---|---|---|"]
        for h in group:
            first = h["samples"][0]
            # Every cell here comes from a contributor-editable file, so every
            # one is escaped, not just the quote from the draft.
            out.append(
                f"| `{cell(h['id'])}` | {h['count']} | L{first['line']}: {cell(first['match'])} "
                f"| {cell(h['note'])} | {cell(h['swap'] or '')} |"
            )
        out.append("")

    if comparison:
        out += ["## Against the baseline", "",
                "| Measure | Draft | Author | Delta | Ratio |", "|---|---|---|---|---|"]
        for r in comparison:
            flag = " [*]" if r["unreliable_here"] else ""
            out.append(f"| {r['metric']}{flag} | {r['draft']} | {r['baseline']} | {r['delta']:+} | {r['ratio']} |")
        out.append("")
        if any(r["unreliable_here"] for r in comparison):
            out += ["[*] Draft and baseline differ in length by more than 2x, and this "
                    "measure moves with length on its own. Ignore the row, or cut the "
                    "baseline down to roughly the draft's length and re-run.", ""]
    else:
        out += ["## Against the baseline", "",
                "No baseline given. These figures describe the draft only; they do not",
                "say whether it reads as human. Re-run with --baseline over the author's",
                "own writing to get a comparison this script can defend.", ""]
    return "\n".join(out)


def read_source(spec: str) -> str:
    if spec == "-":
        return sys.stdin.read()
    path = Path(spec)
    if not path.is_file():
        raise SystemExit(f"cadence.py: not a file: {spec}")
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise SystemExit(f"cadence.py: not UTF-8 text: {spec} ({exc.reason})")


def read_json_object(path: Path, what: str) -> dict:
    if not path.is_file():
        raise SystemExit(f"cadence.py: {what} not found: {path}")
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as exc:
        raise SystemExit(f"cadence.py: {what} is not UTF-8: {path} ({exc.reason})")
    except json.JSONDecodeError as exc:
        raise SystemExit(f"cadence.py: {what} is not valid JSON: {path} line {exc.lineno}: {exc.msg}")
    if not isinstance(loaded, dict):
        raise SystemExit(f"cadence.py: {what} must be a JSON object: {path}")
    return loaded


def read_preserve(loaded: dict, path: Path) -> list[str]:
    preserve = loaded.get("preserve", [])
    if not isinstance(preserve, list) or any(not isinstance(w, str) for w in preserve):
        raise SystemExit(f"cadence.py: preserve must be a list of words: {path}")
    return preserve


def check_tell(tell, i: int, path: Path) -> dict:
    """Validate one tell and compile its pattern, naming the file it came from."""
    if not isinstance(tell, dict):
        raise SystemExit(f"cadence.py: tell {i} is not an object: {path}")
    named = tell.get("id", f"at index {i}")
    required = ("id", "tier", "category", "pattern", "note")
    missing = [k for k in required if k not in tell]
    if missing:
        raise SystemExit(f"cadence.py: tell {named} is missing {', '.join(missing)}: {path}")
    wrong = [k for k in required if not isinstance(tell[k], str)]
    if wrong:
        raise SystemExit(f"cadence.py: tell {named} must have text in {', '.join(wrong)}: {path}")
    if tell["tier"] not in TIER_ORDER:
        raise SystemExit(
            f"cadence.py: tell {named} uses a tier this script does not rank "
            f"({tell['tier']}; known: {', '.join(TIER_ORDER)}): {path}")
    # Compiled here, where the file is in hand, so a bad pattern names the file
    # the contributor edited rather than this script.
    try:
        tell["_rx"] = re.compile(tell["pattern"], re.IGNORECASE)
    except re.error as exc:
        raise SystemExit(f"cadence.py: tell {named} has an unusable pattern: {exc}: {path}")
    return tell


def load_corpus(tells_path: Path, overlays: list[Path] | None = None
                ) -> tuple[list[dict], dict, list[str]]:
    """Read tells.json and any overlays, failing by name rather than by traceback.

    An overlay is a repository's own house rules: a JSON object with an optional
    `tells` list and an optional `preserve` list. A tell whose `id` matches one
    already loaded replaces it, which is how a house rule promotes a shipped
    tell (`em-dash` to `house`, say); any other tell is added. `preserve` words
    are appended. Later overlays win over earlier ones.
    """
    loaded = read_json_object(tells_path, "tell corpus")
    for key in ("tells", "tiers"):
        if key not in loaded:
            raise SystemExit(f"cadence.py: tell corpus has no `{key}` block: {tells_path}")
    corpus, tier_notes = loaded["tells"], loaded["tiers"]
    if not isinstance(corpus, list) or not isinstance(tier_notes, dict):
        raise SystemExit(f"cadence.py: `tells` must be a list and `tiers` an object: {tells_path}")
    for tier, note in tier_notes.items():
        if not isinstance(note, str):
            raise SystemExit(f"cadence.py: the `{tier}` tier note must be text: {tells_path}")

    merged: dict[str, dict] = {}
    for i, tell in enumerate(corpus):
        tell = check_tell(tell, i, tells_path)
        merged[tell["id"]] = tell
    preserve = list(read_preserve(loaded, tells_path))

    for path in overlays or []:
        extra = read_json_object(path, "overlay")
        tells = extra.get("tells", [])
        if not isinstance(tells, list):
            raise SystemExit(f"cadence.py: overlay `tells` must be a list: {path}")
        for i, tell in enumerate(tells):
            tell = check_tell(tell, i, path)
            merged[tell["id"]] = tell
        preserve += read_preserve(extra, path)

    return list(merged.values()), tier_notes, preserve


def main() -> None:
    ap = argparse.ArgumentParser(description="Profile prose cadence and scan for machine-writing tells.")
    ap.add_argument("draft", help="file to profile, or - for stdin")
    ap.add_argument("--baseline", action="append", default=[],
                    help="the author's own real writing; repeatable, concatenated")
    ap.add_argument("--tells", default=str(Path(__file__).with_name("tells.json")),
                    help="the tell corpus; defaults to the tells.json beside this script")
    ap.add_argument("--overlay", action="append", default=[],
                    help="a repository's house tells and preserve words (JSON); repeatable, later wins")
    ap.add_argument("--format", choices=["json", "report"], default="report")
    ap.add_argument("--keep-code", action="store_true",
                    help="treat fenced and indented code as prose, for both the rhythm figures and the tell scan")
    args = ap.parse_args()

    text = unicodedata.normalize("NFC", read_source(args.draft))
    if not text.strip():
        raise SystemExit(f"cadence.py: draft is empty: {args.draft}")

    corpus, tier_notes, preserve = load_corpus(Path(args.tells), [Path(o) for o in args.overlay])

    prof = profile(text, corpus, args.keep_code, preserve, label=args.draft)

    comparison = None
    if args.baseline:
        parts = []
        for spec in args.baseline:
            part = read_source(spec)
            if not part.strip():
                raise SystemExit(f"cadence.py: baseline is empty: {spec}")
            parts.append(part)
        joined = "\n\n".join(parts)
        base_label = f"baseline {', '.join(args.baseline)}"
        comparison = compare(
            prof, profile(joined, corpus, args.keep_code, preserve, label=base_label))

    if args.format == "json":
        print(json.dumps({"draft": prof, "comparison": comparison}, indent=2))
    else:
        print(render(prof, comparison, tier_notes))


if __name__ == "__main__":
    main()

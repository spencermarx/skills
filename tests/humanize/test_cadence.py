#!/usr/bin/env python3
"""Prove humanize's cadence.py counts what it claims and fails by name.

Covers `skills/writing/humanize/scripts/cadence.py` and its `tells.json`.

Usage: python3 tests/humanize/test_cadence.py

Each case writes a small draft to a temporary folder, runs the script as a user
would, and asserts on its JSON or its exit. The cases guard the behaviour the
skill's procedure leans on: the mask sees prose and only prose, every line
number points at the file passed in, an overlay can promote a tell to `house`
and protect a word, and bad input exits non-zero with the offending file named
rather than a traceback.

Stdlib only. No third-party dependencies, no venv.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "skills" / "writing" / "humanize" / "scripts" / "cadence.py"
CORPUS = SCRIPT.with_name("tells.json")

failures = []
passed = 0


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
    else:
        failures.append(f"{name}: {detail}")


def run(*args, stdin=None):
    return subprocess.run([sys.executable, str(SCRIPT), *args], input=stdin,
                          capture_output=True, text=True)


def profile(tmp, text, *args):
    draft = Path(tmp) / "draft.md"
    draft.write_text(text, encoding="utf-8")
    out = run(str(draft), "--format", "json", *args)
    if out.returncode != 0:
        raise AssertionError(f"exit {out.returncode}: {out.stderr}")
    return json.loads(out.stdout)


def hits(prof, tell_id):
    for h in prof["draft"]["tells"]:
        if h["id"] == tell_id:
            return h
    return None


def write(tmp, name, obj):
    p = Path(tmp) / name
    p.write_text(obj if isinstance(obj, str) else json.dumps(obj), encoding="utf-8")
    return p


EM = "—"


def case_mask(tmp):
    """Code is blanked; a list continuation is prose; line numbers survive."""
    text = "\n".join([
        "---",
        f"title: frontmatter {EM} never scanned",
        "---",
        "",
        "Plain prose opens the file.",
        "",
        "```",
        f"fenced {EM} code",
        "```",
        "",
        f"    indented {EM} code block",
        "",
        "1. A numbered item.",
        f"    continuation line {EM} inside the list",
        "",
        f"Inline `code {EM} span` stays blank.",
        "",
    ])
    prof = profile(tmp, text)
    em = hits(prof, "em-dash")
    check("mask: list continuation is scanned", em is not None and em["count"] == 1,
          f"expected exactly one em-dash hit, got {em and em['count']}")
    check("mask: hit reports the raw file's line", em is not None and em["samples"][0]["line"] == 14,
          f"expected line 14, got {em and em['samples'][0]['line']}")
    check("mask: quote comes from the raw file", em is not None and em["samples"][0]["match"] == EM,
          f"got {em and em['samples'][0]['match']!r}")

    kept = profile(tmp, text, "--keep-code")
    em = hits(kept, "em-dash")
    check("mask: --keep-code scans fenced and indented code", em is not None and em["count"] == 3,
          f"expected 3 hits with --keep-code, got {em and em['count']}")


def case_thematic_break(tmp):
    """A `* * *` inside a list does not close it and open a code block."""
    text = "\n".join([
        "- First item.",
        "* * *",
        f"    still part of the list {EM} here",
        "",
    ])
    em = hits(profile(tmp, text), "em-dash")
    check("thematic break: indented line after it is still prose", em is not None,
          "the line after the break was masked as code")


def case_sentences(tmp):
    """Abbreviations do not split a sentence."""
    prof = profile(tmp, "Dr. Smith met Ms. Jones at 3 p.m. and left. They spoke e.g. about rates.\n")
    n = prof["draft"]["sentences"]["n"]
    check("sentences: abbreviations kept whole", n == 2, f"expected 2 sentences, got {n}")


def case_tiers(tmp):
    """The shipped corpus has no house tells, and every tier it uses is ranked."""
    corpus = json.loads(CORPUS.read_text(encoding="utf-8"))
    house = [t["id"] for t in corpus["tells"] if t["tier"] == "house"]
    check("corpus: ships no house tells", house == [], f"house tells shipped: {house}")
    prof = profile(tmp, f"We leverage it {EM} as an AI would.\n")
    totals = prof["draft"]["tell_totals"]
    check("tiers: forensic, strict and aesthetic each counted",
          totals["forensic"] == 1 and totals["strict"] == 1 and totals["aesthetic"] == 1 and totals["house"] == 0,
          f"got {totals}")


def case_overlay(tmp):
    """An overlay promotes a shipped tell by id and adds preserve words."""
    overlay = write(tmp, "house.json", {
        "tells": [{"id": "em-dash", "tier": "house", "category": "punctuation",
                   "pattern": EM, "note": "Barred by our standards."}],
        "preserve": ["seamless"],
    })
    prof = profile(tmp, f"A seamless rollout {EM} and a seamless one again.\n",
                   "--overlay", str(overlay))
    em = hits(prof, "em-dash")
    check("overlay: same id replaces the shipped tell", em is not None and em["tier"] == "house",
          f"got {em and em['tier']}")
    check("overlay: replaced, not duplicated",
          sum(1 for h in prof["draft"]["tells"] if h["id"] == "em-dash") == 1, "em-dash listed twice")
    check("overlay: preserve word is blanked", hits(prof, "seamless") is None,
          "seamless still reported")

    second = write(tmp, "later.json", {"tells": [{"id": "em-dash", "tier": "strict", "category": "p",
                                                  "pattern": EM, "note": "later wins"}]})
    prof = profile(tmp, f"One {EM} two.\n", "--overlay", str(overlay), "--overlay", str(second))
    em = hits(prof, "em-dash")
    check("overlay: a later overlay wins", em is not None and em["tier"] == "strict",
          f"got {em and em['tier']}")


def case_baseline(tmp):
    """A baseline far longer than the draft flags the length-sensitive rows."""
    draft = write(tmp, "d.md", "Short draft here. It has two sentences.\n")
    base = write(tmp, "b.md", " ".join(f"Sentence number {i} runs a little longer than that." for i in range(60)) + "\n")
    out = run(str(draft), "--baseline", str(base), "--format", "json")
    rows = {r["metric"]: r for r in json.loads(out.stdout)["comparison"]}
    check("baseline: length-sensitive row flagged", rows["longest sentence"]["unreliable_here"] is True,
          f"got {rows['longest sentence']}")
    check("baseline: stable row not flagged", rows["mean sentence length"]["unreliable_here"] is False,
          f"got {rows['mean sentence length']}")


def case_no_score(tmp):
    """The report never prints a percentage."""
    draft = write(tmp, "s.md", "We leverage synergies. It is worth noting that it works.\n")
    out = run(str(draft))
    check("report: no percentage", out.returncode == 0 and "%" not in out.stdout,
          f"exit {out.returncode}, percent present: {'%' in out.stdout}")


def expect_error(name, args, needle, stdin=None):
    out = run(*args, stdin=stdin)
    ok = out.returncode != 0 and needle in out.stderr and "Traceback" not in out.stderr
    check(f"error: {name}", ok, f"exit {out.returncode}, stderr {out.stderr.strip()!r}")


def case_errors(tmp):
    good = write(tmp, "good.md", "A sentence of prose.\n")
    expect_error("missing draft", [str(Path(tmp) / "nope.md")], "nope.md")
    expect_error("empty draft", [str(write(tmp, "empty.md", "  \n"))], "empty.md")
    expect_error("no prose left", [str(write(tmp, "code.md", "```\nonly code\n```\n"))], "no prose")
    expect_error("empty baseline", [str(good), "--baseline", str(write(tmp, "eb.md", "\n"))], "eb.md")
    expect_error("bad JSON overlay", [str(good), "--overlay", str(write(tmp, "bad.json", "{oops"))], "bad.json")
    expect_error("bad pattern", [str(good), "--overlay", str(write(tmp, "rx.json", {"tells": [
        {"id": "broken", "tier": "strict", "category": "c", "pattern": "(", "note": "n"}]}))], "rx.json")
    expect_error("unknown tier", [str(good), "--overlay", str(write(tmp, "tier.json", {"tells": [
        {"id": "loud", "tier": "shouty", "category": "c", "pattern": "a", "note": "n"}]}))], "tier.json")
    expect_error("missing field", [str(good), "--overlay", str(write(tmp, "field.json", {"tells": [
        {"id": "short", "tier": "strict", "pattern": "a", "note": "n"}]}))], "category")
    expect_error("corpus without tiers", [str(good), "--tells", str(write(tmp, "c.json", {"tells": []}))], "tiers")


def main():
    with tempfile.TemporaryDirectory() as tmp:
        for case in (case_mask, case_thematic_break, case_sentences, case_tiers, case_overlay,
                     case_baseline, case_no_score, case_errors):
            try:
                case(tmp)
            except Exception as exc:  # a case that crashes is a failure, not a pass
                failures.append(f"{case.__name__}: crashed: {exc}")
    print(f"{passed} passed, {len(failures)} failed")
    for f in failures:
        print(f"FAIL {f}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()

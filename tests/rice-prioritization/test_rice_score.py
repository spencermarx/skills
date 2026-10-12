#!/usr/bin/env python3
"""Prove rice-prioritization's rice_score.py scores, ranks and refuses as it claims.

Covers `skills/strategy/rice-prioritization/scripts/rice_score.py`.

Usage: python3 tests/rice-prioritization/test_rice_score.py
       RICE_SCORE=/path/to/mutant.py python3 tests/rice-prioritization/test_rice_score.py

Each case runs the script as the skill does, on a small JSON list, and asserts
on its output or its exit. The scoring cases pin the published worked examples
the skill's methodology cites, the confidence normalization, full-precision
ranking, tie grouping and confidence sensitivity. The validation cases prove
every bad input exits 1 with a message naming the candidate or the problem,
never a traceback and never a silent score. RICE_SCORE points the suite at
another copy of the script, so a deliberately broken copy can be shown to fail.

Stdlib only. No third-party dependencies, no venv.
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = Path(os.environ.get("RICE_SCORE") or
              REPO / "skills" / "strategy" / "rice-prioritization" / "scripts" / "rice_score.py")

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


def item(name, reach, impact, confidence, effort, **extra):
    return {"name": name, "reach": reach, "impact": impact,
            "confidence": confidence, "effort": effort, **extra}


def score(items, *args):
    """Run on a list via stdin and return the parsed JSON report."""
    out = run("-", *args, stdin=json.dumps(items))
    if out.returncode != 0:
        raise AssertionError(f"exit {out.returncode}: {out.stderr}")
    return json.loads(out.stdout)


def by_name(report):
    return {r["name"]: r for r in report["results"]}


def scoring_case(name, fn):
    try:
        fn()
    except Exception as exc:  # a crash or bad JSON is a failed case, not a dead suite
        failures.append(f"{name}: {type(exc).__name__}: {exc}")


# --- Scoring ---------------------------------------------------------------

def savio():
    rep = score([
        item("Streak CRM Integration", 750, 1, 50, 30),
        item("Permissions & Roles", 1600, 2, 100, 60),
        item("Zapier Integration", 4250, 0.5, 80, 40),
    ])
    rows = by_name(rep)
    check("savio: Permissions & Roles scores 53.33", rows["Permissions & Roles"]["rice_score"] == 53.33,
          rows["Permissions & Roles"]["rice_score"])
    check("savio: Zapier scores 42.5", rows["Zapier Integration"]["rice_score"] == 42.5,
          rows["Zapier Integration"]["rice_score"])
    check("savio: Streak scores 12.5", rows["Streak CRM Integration"]["rice_score"] == 12.5,
          rows["Streak CRM Integration"]["rice_score"])
    order = [r["name"] for r in rep["results"]]
    check("savio: ranked highest first", order == ["Permissions & Roles", "Zapier Integration",
                                                   "Streak CRM Integration"], order)
    check("savio: ranks are 1..N", [r["rank"] for r in rep["results"]] == [1, 2, 3],
          [r["rank"] for r in rep["results"]])
    check("savio: gaps above 15% are not ties", rep["ties"] == [] and
          all(r["tie_group"] is None for r in rep["results"]), rep["ties"])


def whatfix():
    rep = score([item("Whatfix", 1500, 2, 0.5, 2)])
    check("whatfix: (1500 x 2 x 0.5) / 2 = 750", rep["results"][0]["rice_score"] == 750,
          rep["results"][0]["rice_score"])
    check("whatfix: a single item has no sensitivity pairs", rep["sensitivity"] == [], rep["sensitivity"])
    check("whatfix: default tolerance is 0.15", rep["tolerance"] == 0.15, rep["tolerance"])


def confidence_forms():
    rep = score([item("Percent", 100, 1, 50, 1), item("Fraction", 200, 1, 0.5, 2),
                 item("Bare one", 100, 1, 1, 2), item("Hundred", 100, 1, 100, 4)])
    rows = by_name(rep)
    check("confidence: 50 is read as 50%", rows["Percent"]["confidence"] == 0.5 and
          rows["Percent"]["rice_score"] == 50, rows["Percent"])
    check("confidence: 0.5 is read as a fraction", rows["Fraction"]["rice_score"] == 50, rows["Fraction"])
    check("confidence: a bare 1 is 100%", rows["Bare one"]["confidence"] == 1.0 and
          rows["Bare one"]["rice_score"] == 50, rows["Bare one"])
    check("confidence: 100 is 100%", rows["Hundred"]["confidence"] == 1.0 and
          rows["Hundred"]["rice_score"] == 25, rows["Hundred"])


def full_precision_ranking():
    # Both round to 100.0; the higher raw score must still rank first.
    rep = score([item("Lower", 100.001, 1, 1, 1), item("Higher", 100.004, 1, 1, 1)])
    order = [r["name"] for r in rep["results"]]
    check("ranking: uses full precision, not the rounded score", order == ["Higher", "Lower"], order)


def avion_tie_and_sensitivity():
    rep = score([item("Referral program", 4000, 1, 60, 2), item("Checkout improvement", 7000, 2, 40, 4)])
    rows = by_name(rep)
    check("avion: checkout scores 1400", rows["Checkout improvement"]["rice_score"] == 1400,
          rows["Checkout improvement"]["rice_score"])
    check("avion: referral scores 1200", rows["Referral program"]["rice_score"] == 1200,
          rows["Referral program"]["rice_score"])
    check("avion: reach outranks confidence", rep["results"][0]["name"] == "Checkout improvement",
          rep["results"][0]["name"])
    # 1200 is 14.3% below 1400: inside the default 15% band.
    check("avion: a 14.3% gap is a tie at 15%",
          rows["Checkout improvement"]["tie_group"] == rows["Referral program"]["tie_group"] == 1,
          (rows["Checkout improvement"]["tie_group"], rows["Referral program"]["tie_group"]))
    check("avion: the tie summary lists both, highest first",
          rep["ties"] == [{"tie_group": 1, "members": ["Checkout improvement", "Referral program"]}], rep["ties"])
    sens = rep["sensitivity"]
    expected = {"pair": ["Checkout improvement", "Referral program"], "score_gap": 200.0,
                "lower_item_confidence_to_overtake": 0.7, "current_lower_confidence": 0.6,
                "flippable_by_confidence_alone": True}
    check("avion: referral overtakes at 70% confidence", sens == [expected], sens)

    tight = score([item("Referral program", 4000, 1, 60, 2), item("Checkout improvement", 7000, 2, 40, 4)],
                  "--tolerance", "0.1")
    check("tolerance: a 14.3% gap is not a tie at 10%", tight["ties"] == [] and tight["tolerance"] == 0.1,
          tight["ties"])


def robust_order():
    rep = score([item("Big", 10000, 3, 100, 1), item("Small", 10, 0.25, 50, 10)])
    s = rep["sensitivity"][0]
    check("sensitivity: an order confidence cannot flip is reported robust",
          s["flippable_by_confidence_alone"] is False and s["lower_item_confidence_to_overtake"] > 1, s)


def tie_chain():
    rep = score([item("A", 100, 1, 1, 1), item("B", 90, 1, 1, 1), item("C", 80, 1, 1, 1),
                 item("D", 10, 1, 1, 1), item("E", 9, 1, 1, 1)])
    groups = [r["tie_group"] for r in rep["results"]]
    check("ties: adjacent near-ties chain into one group, a gap starts the next",
          groups == [1, 1, 1, 2, 2], groups)
    check("ties: the summary has both groups", [t["members"] for t in rep["ties"]] ==
          [["A", "B", "C"], ["D", "E"]], rep["ties"])


def passthrough():
    rep = score([item("Kept", 10, 1, 80, 1, reach_source="funnel report Q3", needs_human=["effort"],
                      notes={"why": "x"})])
    row = rep["results"][0]
    check("passthrough: provenance keys survive untouched",
          row.get("reach_source") == "funnel report Q3" and row.get("needs_human") == ["effort"]
          and row.get("notes") == {"why": "x"}, row)
    check("passthrough: no internal field leaks", "_raw_score" not in row, sorted(row))


def numeric_strings():
    rep = score([item("Strings", "1500", "2", "50", "2")])
    check("input: numeric strings are accepted", rep["results"][0]["rice_score"] == 750, rep["results"][0])


def file_and_table():
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "candidates.json"
        path.write_text(json.dumps([item("Alpha", 1400, 1, 1, 1), item("Beta", 1300, 1, 1, 1),
                                    item("Gamma", 100, 1, 1, 1)]), encoding="utf-8")
        js = run(str(path))
        check("file: a path argument is read", js.returncode == 0 and
              json.loads(js.stdout)["results"][0]["name"] == "Alpha", js.stderr)
        tab = run("--format", "table", str(path))
        lines = tab.stdout.splitlines()
        check("table: exits 0", tab.returncode == 0, tab.stderr)
        check("table: one ranked row per candidate, highest first",
              any(l.split()[:4] == ["1", "1400.00", "1", "Alpha"] for l in lines)
              and any(l.split()[:4] == ["3", "100.00", "-", "Gamma"] for l in lines), tab.stdout)
        check("table: near-ties are summarized", "Near-ties (within 15%" in tab.stdout and
              "group 1: Alpha, Beta" in tab.stdout, tab.stdout)


# --- Validation --------------------------------------------------------------

def refuses(name, payload, *must_say, args=(), raw=False):
    """Bad input exits 1, names the problem on stderr, prints nothing to stdout."""
    stdin = payload if raw else json.dumps(payload)
    out = run(*args, "-", stdin=stdin)
    said = out.stderr.lower()
    check(f"{name}: exits 1", out.returncode == 1, f"exit {out.returncode}, stdout {out.stdout[:200]!r}")
    check(f"{name}: no traceback", "Traceback" not in out.stderr, out.stderr[-300:])
    check(f"{name}: prints no report", out.stdout == "", out.stdout[:200])
    for phrase in must_say:
        check(f"{name}: says {phrase!r}", phrase.lower() in said, out.stderr.strip())


def validation():
    ok = item("Fine", 10, 1, 80, 1)
    for bad in (4, 5, 1.5, 0):
        refuses(f"impact {bad} off the scale", [ok, item("Off", 10, bad, 80, 1)], "'Off'", "impact", "canonical")
    refuses("effort 0", [item("Free", 10, 1, 80, 0)], "'Free'", "effort", "> 0")
    refuses("negative effort", [item("Neg", 10, 1, 80, -1)], "'Neg'", "effort")
    refuses("negative reach", [item("Neg", -1, 1, 80, 1)], "'Neg'", "reach", ">= 0")
    refuses("confidence 0", [item("Zero", 10, 1, 0, 1)], "'Zero'", "confidence", "> 0")
    refuses("confidence above 100", [item("Over", 10, 1, 101, 1)], "'Over'", "confidence", "exceeds 100")
    refuses("non-numeric confidence", [item("Word", 10, 1, "high", 1)], "'Word'", "confidence", "number")
    refuses("non-numeric reach", [item("Word", "lots", 1, 80, 1)], "'Word'", "reach", "number")
    refuses("boolean confidence", [item("Bool", 10, 1, True, 1)], "'Bool'", "confidence", "number")
    refuses("null effort", [item("Null", 10, 1, 80, None)], "'Null'", "effort", "number")
    refuses("NaN reach", '[{"name": "NaN", "reach": NaN, "impact": 1, "confidence": 80, "effort": 1}]',
            "'NaN'", "reach", "finite", raw=True)
    refuses("Infinity effort", '[{"name": "Inf", "reach": 1, "impact": 1, "confidence": 80, "effort": Infinity}]',
            "'Inf'", "effort", "finite", raw=True)
    refuses("missing keys", [{"name": "Half", "reach": 10, "impact": 1}], "'Half'", "missing", "confidence", "effort")
    refuses("an item that is not an object", [ok, "just a string"], "item #1", "not an object")
    refuses("duplicate names", [ok, item("Fine", 20, 2, 50, 2)], "unique")
    refuses("malformed JSON", "[{", "invalid json", raw=True)
    refuses("a top-level object", {"name": "x"}, "must be a list")
    refuses("an empty list", [], "empty")
    refuses("tolerance of 1", [ok], "--tolerance", args=("--tolerance", "1"))
    refuses("negative tolerance", [ok], "--tolerance", args=("--tolerance", "-0.1"))

    missing = run("/nonexistent/candidates.json")
    check("missing file: exits 1 and names the path", missing.returncode == 1 and
          "/nonexistent/candidates.json" in missing.stderr and "Traceback" not in missing.stderr,
          missing.stderr)


if not SCRIPT.is_file():
    print(f"rice_score.py not found at {SCRIPT}", file=sys.stderr)
    sys.exit(1)

for case in (savio, whatfix, confidence_forms, full_precision_ranking, avion_tie_and_sensitivity,
             robust_order, tie_chain, passthrough, numeric_strings, file_and_table, validation):
    scoring_case(case.__name__, case)

if failures:
    print(f"{len(failures)} failed, {passed} passed:", file=sys.stderr)
    for f in failures:
        print(f"  FAIL {f}", file=sys.stderr)
    sys.exit(1)
print(f"rice_score.py: {passed} checks passed")

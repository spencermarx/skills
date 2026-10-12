#!/usr/bin/env python3
"""RICE prioritization calculator.

Deterministic helper for the `rice-prioritization` skill. Takes a list of
scored candidates, computes RICE = (Reach x Impact x Confidence) / Effort,
ranks them, flags near-ties (scores within a tolerance band), and reports
confidence-sensitivity for adjacent pairs (how much a confidence change would
flip the order).

The model supplies judgment (which scale value, what evidence). This script
supplies arithmetic only. It validates inputs and errors loudly rather than
guessing, so a bad scale value never silently corrupts a ranking.

Stdlib only. No third-party dependencies, no venv.

Usage:
    python3 rice_score.py candidates.json
    python3 rice_score.py --tolerance 0.15 candidates.json
    cat candidates.json | python3 rice_score.py -
    python3 rice_score.py --format table candidates.json

Input JSON: a list of objects, each:
    {
      "name": "Feature A",
      "reach": 1500,          # absolute count in the round's fixed time window
      "impact": 2,            # canonical scale: 3, 2, 1, 0.5, 0.25
      "confidence": 0.8,      # 0-1, or a percentage 1-100 (auto-normalized)
      "effort": 2             # person-months across all disciplines, > 0
    }
Optional per-item passthrough keys (e.g. "notes", "reach_source") are preserved
in the output untouched.

Output JSON: { "tolerance": float, "results": [ ... ], "ties": [...],
"sensitivity": [...] } where each result adds rice_score, rank, tie_group.
"""

import argparse
import json
import math
import sys

# Canonical Intercom impact multipliers. A value outside this set is almost
# always a scale mistake (e.g. a 1-5 scale leaking in), so we reject it.
CANONICAL_IMPACT = {3.0, 2.0, 1.0, 0.5, 0.25}

REQUIRED_KEYS = ("name", "reach", "impact", "confidence", "effort")


def _fail(message):
    """Print an error to stderr and exit non-zero."""
    print(f"rice_score: error: {message}", file=sys.stderr)
    sys.exit(1)


def to_number(raw, name, field):
    """Return raw as a finite float, or fail naming the candidate and field.

    Booleans are refused even though Python treats them as numbers: a `true`
    in the JSON is a typo, not a score. NaN and Infinity are refused because
    JSON parsing accepts them and they would pass every range check silently.
    """
    if isinstance(raw, bool):
        _fail(f"'{name}': {field} must be a number, got {raw!r}")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        _fail(f"'{name}': {field} must be a number, got {raw!r}")
    if not math.isfinite(value):
        _fail(f"'{name}': {field} must be a finite number, got {raw!r}")
    return value


def normalize_confidence(raw, name):
    """Accept confidence as 0-1 or as a 1-100 percentage; return a 0-1 float.

    Ambiguity note: a bare 1 is read as 100% (1.0), and 0 < x <= 1 as a
    fraction. Values above 100 are rejected.
    """
    c = to_number(raw, name, "confidence")
    if c <= 0:
        _fail(f"'{name}': confidence must be > 0, got {c}")
    if c > 100:
        _fail(f"'{name}': confidence {c} exceeds 100")
    # Treat values above 1 as percentages.
    return c / 100.0 if c > 1 else c


def validate_item(item, index):
    """Validate one candidate dict and return a normalized copy."""
    if not isinstance(item, dict):
        _fail(f"item #{index} is not an object: {item!r}")
    missing = [k for k in REQUIRED_KEYS if k not in item]
    if missing:
        label = item.get("name", f"item #{index}")
        _fail(f"'{label}' is missing required keys: {', '.join(missing)}")

    name = str(item["name"])

    reach = to_number(item["reach"], name, "reach")
    impact = to_number(item["impact"], name, "impact")
    effort = to_number(item["effort"], name, "effort")

    if reach < 0:
        _fail(f"'{name}': reach must be >= 0, got {reach}")
    if impact not in CANONICAL_IMPACT:
        _fail(
            f"'{name}': impact {impact} is not a canonical RICE value "
            f"(allowed: 3, 2, 1, 0.5, 0.25). If you are using a different "
            f"scale, convert it before scoring."
        )
    if effort <= 0:
        _fail(f"'{name}': effort must be > 0 person-months, got {effort}")

    confidence = normalize_confidence(item["confidence"], name)

    normalized = dict(item)  # preserve passthrough keys (notes, sources, flags)
    normalized["name"] = name
    normalized["reach"] = reach
    normalized["impact"] = impact
    normalized["confidence"] = confidence
    normalized["effort"] = effort
    return normalized


def compute(items, tolerance):
    """Score, rank, flag ties, and compute confidence-sensitivity.

    tolerance is a fraction (0.15 = 15%). Two adjacent scores are a "tie" when
    their relative gap is within tolerance, i.e. they are too close to call
    given RICE's inherent estimation noise.
    """
    scored = []
    for it in items:
        raw = (it["reach"] * it["impact"] * it["confidence"]) / it["effort"]
        row = dict(it)
        row["rice_score"] = round(raw, 2)
        row["_raw_score"] = raw  # full-precision, used internally for ranking
        scored.append(row)

    scored.sort(key=lambda r: r["_raw_score"], reverse=True)

    # Assign ranks. Standard competition ranking is unnecessary here; we keep
    # a strict 1..N order but mark ties separately so the reader sees them.
    for i, row in enumerate(scored):
        row["rank"] = i + 1

    # Group near-ties by walking adjacent pairs. Anything within tolerance of
    # its neighbor joins the same tie group.
    tie_group_id = 0
    ties = []
    for i, row in enumerate(scored):
        if i == 0:
            row["tie_group"] = None
            continue
        prev = scored[i - 1]
        higher = prev["_raw_score"]
        lower = row["_raw_score"]
        # Relative gap against the higher score. Guard divide-by-zero.
        gap = (higher - lower) / higher if higher > 0 else 0.0
        if gap <= tolerance:
            if prev.get("tie_group") is None:
                tie_group_id += 1
                prev["tie_group"] = tie_group_id
            row["tie_group"] = prev["tie_group"]
        else:
            row["tie_group"] = None

    # Collect tie groups for the summary block.
    groups = {}
    for row in scored:
        g = row.get("tie_group")
        if g is not None:
            groups.setdefault(g, []).append(row["name"])
    for g, names in sorted(groups.items()):
        ties.append({"tie_group": g, "members": names})

    # Confidence-sensitivity for adjacent pairs: what new confidence on the
    # LOWER item would lift its score to match the HIGHER item, holding all
    # else equal. If that confidence is <= 1.0 it is achievable and the order
    # is "flippable"; otherwise the order is robust to confidence alone.
    sensitivity = []
    for i in range(1, len(scored)):
        higher = scored[i - 1]
        lower = scored[i]
        denom = lower["reach"] * lower["impact"]
        if denom <= 0:
            continue
        needed_conf = (higher["_raw_score"] * lower["effort"]) / denom
        flippable = needed_conf <= 1.0
        sensitivity.append(
            {
                "pair": [higher["name"], lower["name"]],
                "score_gap": round(higher["rice_score"] - lower["rice_score"], 2),
                "lower_item_confidence_to_overtake": round(needed_conf, 3),
                "current_lower_confidence": round(lower["confidence"], 3),
                "flippable_by_confidence_alone": flippable,
            }
        )

    # Strip internal field before returning.
    for row in scored:
        del row["_raw_score"]

    return {"tolerance": tolerance, "results": scored, "ties": ties, "sensitivity": sensitivity}


def format_table(report):
    """Render a compact human-readable table for quick eyeballing."""
    rows = report["results"]
    lines = []
    header = f"{'#':>2}  {'Score':>9}  {'Tie':>3}  Name"
    lines.append(header)
    lines.append("-" * max(len(header), 40))
    for r in rows:
        tie = str(r["tie_group"]) if r["tie_group"] is not None else "-"
        lines.append(f"{r['rank']:>2}  {r['rice_score']:>9.2f}  {tie:>3}  {r['name']}")
    if report["ties"]:
        lines.append("")
        lines.append("Near-ties (within %.0f%%, treat as a tie):" % (report["tolerance"] * 100))
        for t in report["ties"]:
            lines.append(f"  group {t['tie_group']}: {', '.join(t['members'])}")
    return "\n".join(lines)


def load_input(path):
    if path == "-":
        text = sys.stdin.read()
    else:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                text = fh.read()
        except OSError as exc:
            _fail(f"cannot read {path}: {exc}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        _fail(f"invalid JSON: {exc}")
    if not isinstance(data, list):
        _fail("top-level JSON must be a list of candidate objects")
    if not data:
        _fail("candidate list is empty")
    return data


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Compute RICE scores, ranks, ties, and confidence-sensitivity."
    )
    parser.add_argument("input", help="path to candidates JSON, or '-' for stdin")
    parser.add_argument(
        "--tolerance",
        type=float,
        default=0.15,
        help="near-tie band as a fraction (default 0.15 = 15%%)",
    )
    parser.add_argument(
        "--format",
        choices=("json", "table"),
        default="json",
        help="output format (default json)",
    )
    args = parser.parse_args(argv)

    if not (0 <= args.tolerance < 1):
        _fail(f"--tolerance must be in [0, 1), got {args.tolerance}")

    raw_items = load_input(args.input)
    items = [validate_item(it, i) for i, it in enumerate(raw_items)]

    names = [it["name"] for it in items]
    if len(set(names)) != len(names):
        _fail("candidate names must be unique")

    report = compute(items, args.tolerance)

    if args.format == "table":
        print(format_table(report))
    else:
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

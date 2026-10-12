#!/usr/bin/env python3
"""Report a skill whose description overruns the description cap.

Usage: check_descriptions.py [repo-root] [--cap N] [--root DIR ...]

The default cap is 1024 characters, the Agent Skills specification's maximum and
the point at which Copilot and VS Code truncate. A repository with a tighter house
cap passes it with `--cap` (500 is a common one: it keeps the always-resident
description budget small).

**Why a length check exists at all, against the standing advice not to build
one.** `references/tiers.md` resists linting description length, and it is right
about the check it has in mind: a check that asks whether a description is a
*good* dispatch surface flags every human-invoked skill as too short, because a
skill a person reaches by name needs no trigger-tuned prose. This check is the
other direction. It is a **maximum**, not a quality judgement, and a maximum
cannot mistake a short human-invoked description for a defect. Every registrable
description is resident whether a model dispatches on it or not, so the cap
applies to every skill without a partition to draw.

Skills are found exactly where `census.py` finds them, and measured with its
extraction, so the two never disagree about a number.

Exit 0 clean, 1 with findings printed one per line, worst overrun first. Exit 1
with empty stdout is a precondition that could not be met, explained on stderr:
read both streams before reading an empty result as a pass.

Stdlib only. No third-party dependencies, no venv.
"""

import sys
from pathlib import Path

# No .pyc beside the scripts: an installed skill folder may be read-only.
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from census import description, discover_skills, ls_files  # noqa: E402

DEFAULT_CAP = 1024


def check(root, cap=DEFAULT_CAP, extra_roots=()):
    """Findings, worst overrun first.

    Ordered by how far over the cap a description runs, because the size of the
    overrun is the whole measure of the defect.
    """
    files = ls_files(root, prog="check_descriptions.py")
    findings = []
    for d in discover_skills(root, files, extra_roots):
        rel = f"{d}/SKILL.md"
        chars = len(description(root / rel))
        if chars > cap:
            findings.append((chars, f"{rel}: description is {chars} chars, over the {cap}-character cap"))
    findings.sort(key=lambda pair: -pair[0])
    return [text for _, text in findings]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    cap = DEFAULT_CAP
    extra = []
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in ("--cap", "--root"):
            if i + 1 >= len(argv):
                raise SystemExit(f"check_descriptions.py: {arg} needs a value")
            if arg == "--cap":
                try:
                    cap = int(argv[i + 1])
                except ValueError:
                    raise SystemExit("check_descriptions.py: --cap needs a whole number")
            else:
                extra.append(argv[i + 1])
            i += 2
            continue
        if arg.startswith("--"):
            raise SystemExit("usage: check_descriptions.py [repo-root] [--cap N] [--root DIR ...]")
        positional.append(arg)
        i += 1
    if len(positional) > 1:
        raise SystemExit("usage: check_descriptions.py [repo-root] [--cap N] [--root DIR ...]")
    root = Path(positional[0] if positional else ".").resolve()

    findings = check(root, cap, extra)
    for finding in findings:
        print(finding)
    print(f"\n{len(findings)} findings", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())

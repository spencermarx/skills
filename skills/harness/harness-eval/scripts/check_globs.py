#!/usr/bin/env python3
"""Report a Claude Code rule glob that reaches further than the rule can govern, or nowhere.

Usage: check_globs.py [repo-root] [--vendored PREFIX ...]

**Claude Code only.** A rule in `.claude/rules/` carries a `paths:` list of globs,
and Claude Code loads the rule whenever a file matching one is read. Other
harnesses have no equivalent, so a repository without `.claude/rules/` is skipped:
exit 0 with a note on stderr.

Two failures, both invisible from inside the rule:

**Over-reach.** A rule fires on every file its globs match and pays a context
load each time. A rule globbing `**/*.md` claims every markdown file in a vendored
tree that nobody in this repository authors and which it will therefore never fix.
The rule is not wrong about its convention; it is wrong about its own
jurisdiction. Name each vendored tree with `--vendored PREFIX` (for example
`--vendored third_party/`); with none named, only dead globs are reported.

**Dead glob.** A glob matching no file routes nothing, and reads exactly like a
healthy rule.

Both checks have an injected defect proving they fire and a legitimate shape
proving they stay quiet, in the catalog's `tests/harness-eval/test_checks.py`.
Adding a third check means adding both cases in the same change.

Exit 0 clean, 1 with findings printed one per line. Exit 1 with empty stdout is
a precondition that could not be met, explained on stderr: read both streams
before reading an empty result as a pass.

Stdlib only. No third-party dependencies, no venv.
"""

import re
import subprocess
import sys
from pathlib import Path

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)


def tracked(root):
    """Every file git knows about or would add, as repo-relative POSIX paths."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except FileNotFoundError:
        raise SystemExit("check_globs.py: git is not on PATH, so the file list cannot be built.")
    except subprocess.CalledProcessError:
        raise SystemExit(f"check_globs.py: {root} is not a git repository.")
    return [line for line in out.splitlines() if line]


def glob_to_regex(pattern):
    """Translate the four portable glob forms into one regex.

    `**`, `*`, `?` and `[abc]`. Braces, negation and extended globs are not
    portable across glob engines, and a pattern using them will simply not match
    here, which surfaces as the dead-glob finding below: rewrite it as several
    plain globs.

    The subtle case is `**/`, which must match zero segments as well as many, so
    that `**/*.md` reaches a file at the repository root and not only files in a
    subdirectory.
    """
    out = []
    i = 0
    while i < len(pattern):
        char = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:[^/]+/)*")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif char == "*":
            out.append("[^/]*")
            i += 1
        elif char == "?":
            out.append("[^/]")
            i += 1
        elif char == "[":
            close = pattern.find("]", i)
            if close == -1:
                out.append(re.escape(char))
                i += 1
            else:
                out.append("[" + pattern[i + 1 : close] + "]")
                i = close + 1
        else:
            out.append(re.escape(char))
            i += 1
    return re.compile("\\A" + "".join(out) + "\\Z")


def rule_globs(path):
    """The `paths:` list of a rule file, as raw glob strings."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return []
    match = FRONTMATTER.match(text)
    if not match:
        return []
    body = match.group(1)
    block = re.search(r"^paths:\s*\n((?:\s*-\s*.+\n?)+)", body, re.M)
    if not block:
        return []
    globs = []
    for line in block.group(1).splitlines():
        item = re.match(r"\s*-\s*(.+?)\s*$", line)
        if item:
            globs.append(item.group(1).strip().strip("'\""))
    return globs


def check(root, vendored=()):
    """Findings, worst first.

    Ordered by how many files a glob over-reaches, because volume is the whole
    difference between the two shapes this check finds. A rule claiming 60 files
    of vendored prose it will never fix is a defect. A rule reaching one vendored
    `CLAUDE.md` at a boundary is usually the rule working: that file can satisfy
    it. The script cannot tell those apart, so it ranks them and leaves the
    judgement where it belongs, which is why the skill's `## Done` says every
    finding is resolved *or explained*.
    """
    files = tracked(root)
    dead = []
    reach = []
    prefixes = sorted({p.rstrip("/") + "/" for p in vendored})

    rules = sorted(p for p in (root / ".claude" / "rules").rglob("*.md"))
    for rule in rules:
        rel = rule.relative_to(root).as_posix()
        for pattern in rule_globs(rule):
            regex = glob_to_regex(pattern)
            matched = [f for f in files if regex.match(f)]

            if not matched:
                dead.append(
                    f"{rel}: glob '{pattern}' matches no file, so it routes nothing"
                )
                continue

            for prefix in prefixes:
                reached = [f for f in matched if f.startswith(prefix)]
                if reached:
                    reach.append(
                        (
                            len(reached),
                            f"{rel}: glob '{pattern}' reaches {len(reached)} files under "
                            f"{prefix}, which this repository does not author",
                        )
                    )

    reach.sort(key=lambda pair: -pair[0])
    return dead + [text for _, text in reach]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    vendored = []
    positional = []
    i = 0
    while i < len(argv):
        if argv[i] == "--vendored":
            if i + 1 >= len(argv):
                raise SystemExit("check_globs.py: --vendored needs a path prefix")
            vendored.append(argv[i + 1])
            i += 2
            continue
        if argv[i].startswith("--"):
            raise SystemExit("usage: check_globs.py [repo-root] [--vendored PREFIX ...]")
        positional.append(argv[i])
        i += 1
    if len(positional) > 1:
        raise SystemExit("usage: check_globs.py [repo-root] [--vendored PREFIX ...]")
    root = Path(positional[0] if positional else ".").resolve()

    if not (root / ".claude" / "rules").is_dir():
        print("check_globs.py: no .claude/rules/ here, so there is nothing to check "
              "(rule globs are a Claude Code feature). Skipped.", file=sys.stderr)
        return 0

    findings = check(root, vendored)
    for finding in findings:
        print(finding)
    print(f"\n{len(findings)} findings", file=sys.stderr)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Check that every convention is stated once and reached the way it claims.

Usage: validate-routing.py [repo-root] [--conventions PATH] [--rules DIR ...]
                           [--decisions DIR ...]

The repository is the one the working directory sits in (or `repo-root`). The
conventions folder comes from `--conventions`, else from the `Conventions folder`
line of `docs/agents/workspace.md`. It may be a folder of documents with a
`README.md` index, or a single file such as `CONVENTIONS.md`.

What is checked, and why each one is silent without this script:

- Every markdown link into the conventions resolves: the document exists and the
  `#anchor` is one of its headings. A renamed heading breaks every link aimed at
  it without a word, wherever the link lives, the conventions' own documents
  included. A link labelled `doc § Section` points at that section.
- The instructions file (`AGENTS.md`, else `CLAUDE.md`) names the conventions,
  because it is the one file every harness loads in every session.
- Every document is listed in the folder's `README.md` index.

When a routing layer exists, which is any harness rule file that links into the
conventions (Claude Code `.claude/rules/`, Cursor `.cursor/rules/`, or a folder
passed with `--rules`), also:

- A pointer rule carries a glob and nothing that makes it load everywhere, and
  no frontmatter beyond what a pointer needs.
- Every `##` section is routed by a rule, or declared in the index's
  `## Intentionally unrouted` section, never both; and a declared section is
  linked by some file other than the index, the consumer that reaches it.

A decision record (a file whose name starts with a digit, in a folder named `adr`
or `decisions`, or under a `--decisions` folder) is history: its links are not
checked and it never counts as a consumer.

Whether a glob reaches any file is not checked here; harness-eval's
`check_globs.py` reports dead Claude Code globs.

Exit 0 clean, 1 with findings printed one per line. Exit 1 with nothing on
stdout means the check could not run at all, explained on stderr: read both
streams before reading an empty result as a pass.

Stdlib only. Never prompts.
"""

import argparse
import posixpath
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

PROG = "validate-routing"
RULE_DIRS = (".claude/rules", ".cursor/rules")
UNROUTED = "Intentionally unrouted"
RECORD_FOLDERS = {"adr", "decisions"}

# What a pointer rule may carry, per harness. A key outside the set means the
# rule is doing more than routing. `always` names how the harness is told to
# load a rule in every session, which turns a router into an always-on cost.
DIALECTS = {
    "claude": {
        "harness": "Claude Code",
        "glob": "paths",
        "keys": {"description", "paths"},
        "no_glob": "has no `paths:` glob, so Claude Code loads it in every session "
        "instead of when a matching file is read",
    },
    "cursor": {
        "harness": "Cursor",
        "glob": "globs",
        "keys": {"description", "globs", "alwaysApply"},
        "no_glob": "has no `globs:`, so no matching file attaches it",
    },
}

# A label may wrap across lines, as prose does, but never across a blank line.
LINK = re.compile(r"\[((?:[^\]\n]|\n(?![ \t]*\n))*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+\"[^\"\n]*\")?\s*\)")
FENCE = re.compile(r"^\s{0,3}(```|~~~)")
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
CODE_SPAN = re.compile(r"(`+)(?:(?!\1)[\s\S])+?\1")


def fail_to_run(msg):
    raise SystemExit(f"{PROG}: {msg}")


def git_toplevel(cwd):
    try:
        out = subprocess.run(
            ["git", "-C", str(cwd), "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except FileNotFoundError:
        fail_to_run("git is not on PATH, and this check reads the repository's file list from git.")
    except subprocess.CalledProcessError:
        fail_to_run(f"{cwd} is not inside a git repository. Run it from the repository, or pass its root.")
    return Path(out)


def repo_files(root):
    """Every file git tracks or would add, as repo-relative POSIX paths.

    Ignored folders drop out, which matters: a git-ignored copy of the repository
    (a worktree, a review session) would otherwise answer "yes, still linked"
    for a link deleted from the real tree.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            capture_output=True, text=True, check=True,
        ).stdout
    except FileNotFoundError:
        fail_to_run("git is not on PATH, and this check reads the repository's file list from git.")
    except subprocess.CalledProcessError:
        fail_to_run(f"{root} is not a git repository.")
    return sorted(rel for rel in set(out.split("\0")) if rel and (root / rel).is_file())


def workspace_setting(root, label):
    """A path from docs/agents/workspace.md: the path, None for "none", "" when unset."""
    try:
        text = (root / "docs" / "agents" / "workspace.md").read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""
    for line in text.splitlines():
        m = re.search(re.escape(label) + r"[^:]*:\**\s*(.*)$", line, re.I)
        if not m:
            continue
        rest = m.group(1).strip()
        if rest.lower().startswith("none"):
            return None
        tick = re.search(r"`([^`]+)`", rest)
        return tick.group(1) if tick else ""
    return ""


def read(root, rel):
    try:
        return (root / rel).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def prose_lines(text):
    """Lines outside fenced code blocks. A link or heading inside a fence is an example."""
    out, fence = [], None
    for line in text.splitlines():
        m = FENCE.match(line)
        if m:
            if fence is None:
                fence = m.group(1)
            elif m.group(1) == fence:
                fence = None
            continue
        if fence is None:
            out.append(line)
    return out


def slug(heading):
    """GitHub's anchor for a heading: lowercase, punctuation dropped, spaces to hyphens."""
    s = re.sub(r"[^\w\- ]", "", heading.strip().lower())
    return s.replace(" ", "-")


def headings(text):
    """[(level, text, anchor)], with GitHub's -1, -2 suffixes on repeated anchors."""
    seen, out = {}, []
    for line in prose_lines(text):
        m = HEADING.match(line)
        if not m:
            continue
        base = slug(m.group(2))
        n = seen.get(base, 0)
        seen[base] = n + 1
        out.append((len(m.group(1)), m.group(2), base if n == 0 else f"{base}-{n}"))
    return out


def links(text):
    """[(label, target)] outside code fences and code spans.

    A link that starts inside a code span is an example of a link, not one. A
    code span inside a label is part of the label.
    """
    prose = "\n".join(prose_lines(text))
    spans = [m.span() for m in CODE_SPAN.finditer(prose)]
    out = []
    for m in LINK.finditer(prose):
        if any(a <= m.start() < b for a, b in spans):
            continue
        label, target = " ".join(m.group(1).split()), m.group(2)
        out.append((label, target[1:-1] if target.startswith("<") else target))
    return out


def names_another_section(label, anchor):
    """True when a `doc § Section` label names a section other than the anchor.

    A label may shorten a long heading ("§ Owning an area" for "Owning an area
    and when one is created"), so a label whose slug starts the anchor at a word
    boundary names the same section.
    """
    if "§" not in label:
        return False
    named = slug(label.split("§", 1)[1])
    return bool(named) and anchor != named and not anchor.startswith(named + "-")


def resolve(source, target):
    """(repo-relative path, anchor or None) for a link, or None if it leaves the repository."""
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I):
        return None
    path, _, anchor = target.partition("#")
    path = unquote(path)
    if not path:
        rel = source
    elif path.startswith("/"):
        rel = posixpath.normpath(path.lstrip("/"))
    else:
        rel = posixpath.normpath(posixpath.join(posixpath.dirname(source), path))
    if rel == ".." or rel.startswith("../"):
        return None
    return rel, (unquote(anchor) or None)


def frontmatter(text):
    """(keys in order, {key: raw value or list of items}). No frontmatter yields ([], {})."""
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n", text, re.S)
    if not m:
        return [], {}
    keys, values, current = [], {}, None
    for line in m.group(1).splitlines():
        top = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if top:
            current = top.group(1)
            keys.append(current)
            values[current] = top.group(2).strip()
        elif current and line.strip().startswith("- "):
            if not isinstance(values[current], list):
                values[current] = []
            values[current].append(line.strip()[2:].strip())
    return keys, values


def glob_list(value):
    if isinstance(value, list):
        items = value
    else:
        items = value.strip().strip("[]").split(",") if value else []
    return [i.strip().strip("'\"") for i in items if i.strip().strip("'\"")]


def dialect_of(rel):
    if rel.endswith(".mdc") or "/.cursor/" in f"/{rel}":
        return "cursor"
    return "claude"


def main():
    ap = argparse.ArgumentParser(prog=PROG, description=__doc__.split("\n\n")[0])
    ap.add_argument("root", nargs="?", help="repository root (default: the one the working directory is in)")
    ap.add_argument("--conventions", help="conventions folder or file, relative to the root")
    ap.add_argument("--rules", action="append", default=[], help="an extra folder of harness rule files")
    ap.add_argument("--decisions", action="append", default=[], help="an extra folder of decision records")
    args = ap.parse_args()

    root = Path(args.root).resolve() if args.root else git_toplevel(Path.cwd())
    files = repo_files(root)
    fileset = set(files)

    conv = args.conventions
    if conv is None:
        conv = workspace_setting(root, "Conventions folder")
        if conv is None:
            fail_to_run("docs/agents/workspace.md sets the conventions folder to none, so there is "
                        "nothing to check. Set it there, or pass --conventions PATH.")
        if conv == "":
            fail_to_run("no conventions folder is configured (no `Conventions folder` line in "
                        "docs/agents/workspace.md). Set one there, or pass --conventions PATH.")
    conv = posixpath.normpath(conv.strip().rstrip("/"))
    single = conv in fileset
    if not single and not any(f.startswith(conv + "/") for f in files):
        fail_to_run(f"the conventions {'file' if conv.endswith('.md') else 'folder'} {conv!r} "
                    f"holds no file git can see. Create it, or point --conventions at the right path.")

    def in_conv(rel):
        return rel == conv if single else rel.startswith(conv + "/")

    index = conv if single else f"{conv}/README.md"
    docs = [f for f in files if f.endswith(".md") and in_conv(f)]
    extra_records = [posixpath.normpath(d.strip("/")) for d in args.decisions]

    def is_record(rel):
        parent = posixpath.dirname(rel)
        named = posixpath.basename(parent).lower() in RECORD_FOLDERS
        listed = any(rel.startswith(d + "/") for d in extra_records)
        return (named or listed) and posixpath.basename(rel)[:1].isdigit()

    findings = []

    anchors = {}   # doc -> set of anchors
    sections = {}  # (doc, anchor) -> heading text, the `##` sections that are standards
    for doc in docs:
        hs = headings(read(root, doc))
        anchors[doc] = {a for _, _, a in hs}
        if doc == index and not single:
            continue
        for level, text, a in hs:
            if level == 2 and not (single and text == UNROUTED):
                sections[(doc, a)] = text

    # Every link into the conventions, from every markdown file git can see.
    cites = []  # (source, label, doc, anchor)
    for src in files:
        if not src.endswith((".md", ".mdc")) or is_record(src):
            continue
        for label, target in links(read(root, src)):
            hit = resolve(src, target)
            if not hit or not in_conv(hit[0]):
                continue
            doc, anchor = hit
            if doc not in fileset:
                findings.append(f"{src}: link {label!r} points at {doc}, which does not exist")
                continue
            if anchor and doc in anchors and anchor not in anchors[doc]:
                findings.append(f"{src}: link {label!r} points at {doc}#{anchor}, which is not a heading")
                continue
            cites.append((src, label, doc, anchor))
            if anchor and names_another_section(label, anchor):
                findings.append(f"{src}: link labelled {label!r} points at #{anchor}, a different section")

    # The always-loaded router.
    instructions = next((f for f in ("AGENTS.md", "CLAUDE.md") if f in fileset), None)
    if instructions is None:
        findings.append("no AGENTS.md (or CLAUDE.md) at the root, so nothing every session loads "
                        "points at the conventions")
    elif conv not in read(root, instructions) and not any(c[0] == instructions for c in cites):
        findings.append(f"{instructions}: never names {conv}, so no session learns the conventions exist")

    if not single:
        if index not in fileset:
            findings.append(f"{conv}/: no README.md index, so an agent arriving at the folder "
                            f"cannot tell which document owns what")
        else:
            listed = {doc for src, _, doc, _ in cites if src == index}
            for doc in docs:
                if doc != index and doc not in listed:
                    findings.append(f"{doc}: not linked from {index}, so an agent reading the "
                                    f"index never finds it")

    # The optional routing layer.
    rule_dirs = [d for d in RULE_DIRS if any(f.startswith(d + "/") for f in files)]
    rule_dirs += [posixpath.normpath(d.strip("/")) for d in args.rules]
    rule_files = sorted({f for f in files for d in rule_dirs
                         if f.startswith(d + "/") and f.endswith((".md", ".mdc"))})
    pointer_rules = sorted({src for src, _, _, _ in cites if src in rule_files})

    routed = set()
    for rule in pointer_rules:
        d = DIALECTS[dialect_of(rule)]
        keys, values = frontmatter(read(root, rule))
        for k in keys:
            if k not in d["keys"]:
                findings.append(f"{rule}: frontmatter key {k!r} is not one a pointer rule carries "
                                f"({', '.join(sorted(d['keys']))}), so the rule is doing more than routing")
        if not glob_list(values.get(d["glob"], "")):
            findings.append(f"{rule}: {d['no_glob']}")
        if str(values.get("alwaysApply", "")).lower() == "true":
            findings.append(f"{rule}: alwaysApply: true loads it in every session, so it routes nothing by file")
        for src, label, doc, anchor in cites:
            if src != rule:
                continue
            if anchor is None:
                routed.update(k for k in sections if k[0] == doc)
                continue
            routed.add((doc, anchor))

    declared = set()
    if pointer_rules and index in fileset:
        block, inside = [], False
        for line in prose_lines(read(root, index)):
            m = HEADING.match(line)
            if m and len(m.group(1)) <= 2:
                inside = len(m.group(1)) == 2 and m.group(2) == UNROUTED
                continue
            if inside:
                block.append(line)
        for label, target in links("\n".join(block)):
            hit = resolve(index, target)
            if hit and in_conv(hit[0]) and hit[1] and (hit[0], hit[1]) in sections:
                declared.add(hit)

        # A declaration claims some consumer reaches the section instead of a rule.
        # Unverified, the list decays into a place to park sections nobody routed.
        consumed = {(doc, anchor) for src, _, doc, anchor in cites if src != index and anchor}
        for key in sorted(declared - consumed):
            findings.append(f"{key[0]} § {sections[key]}: declared unrouted, but no file links it, "
                            f"so nothing reaches it at all")
        for key, text in sorted(sections.items()):
            if key in routed and key in declared:
                findings.append(f"{key[0]} § {text}: both routed by a rule and declared unrouted")
            elif key not in routed and key not in declared:
                findings.append(f"{key[0]} § {text}: neither routed by a rule nor declared unrouted "
                                f"in {index} § {UNROUTED}")

    for f in findings:
        print(f"FAIL  {f}")
    layer = (f"{len(pointer_rules)} pointer rules, {len(routed & sections.keys())} sections routed, "
             f"{len(declared)} declared unrouted" if pointer_rules
             else "no routing layer: sections are reached through the index")
    print(f"\n{len(docs)} documents, {len(sections)} sections; {layer}; {len(findings)} findings")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Inventory a repository's agent harness and split its skills by how they are invoked.

Usage: census.py [repo-root] [--json] [--root DIR ...] [--conventions DIR] [--cases DIR]

Every tier of the eval system depends on one distinction this script draws:
a skill carrying `disable-model-invocation: true` is reached by a person typing
its name, so its description is not a dispatch surface and no trigger eval can
be written for it. Measuring a library without that split produces confident
nonsense: a description-length check run across the whole library flags the
human-invoked skills as under-triggering defects, and every one of those is a
false positive.

This script is the only place the split is counted. Nothing else should state the
totals in prose, because a count written beside the script that computes it goes
stale the first time a skill's frontmatter changes.

Skills are found wherever they live:

- the project skill folders harnesses read: `.claude/skills/`, `.agents/skills/`,
  `.github/skills/`, `.cursor/skills/` (one folder per skill);
- a catalog layout, `skills/**/SKILL.md` at the repository root;
- every `.claude-plugin/plugin.json`: its `skills` array, or the plugin's
  `skills/` folder when the array is absent;
- any extra folder passed with `--root`, searched recursively.

Fixtures and test material outside those places are deliberately not counted.

The conventions folder and the eval cases folder are read from
`docs/agents/workspace.md` when it exists (override with `--conventions` and
`--cases`); a repository without them simply reports none.

Reports counts only. It is an inventory, not a check, so it exits 0 whenever it
could run at all.

Files come from `git ls-files --cached --others --exclude-standard`, so a skill
written seconds ago is visible and an ignored worktree copy cannot inflate a count.

Stdlib only. No third-party dependencies, no venv.
"""

import json
import posixpath
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

HARNESS_SKILL_DIRS = (".claude/skills", ".agents/skills", ".github/skills", ".cursor/skills")
DEFAULT_CASES = ".evals/cases"

FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n", re.S)
# A key at the start of a line, which is where a top-level frontmatter key sits.
# Nested keys are indented and must not be mistaken for one.
KEY = re.compile(r"^([A-Za-z][A-Za-z0-9_-]*):(.*)$", re.M)


def ls_files(root, prog="census.py"):
    """Every file git knows about or would add, as repo-relative POSIX paths.

    `--others --exclude-standard` makes a skill authored ten seconds ago visible,
    which is the moment a measurement is most wanted, while still honouring
    `.gitignore`.
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--cached", "--others", "--exclude-standard"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
    except FileNotFoundError:
        raise SystemExit(f"{prog}: git is not on PATH, so the file list cannot be built.")
    except subprocess.CalledProcessError:
        raise SystemExit(f"{prog}: {root} is not a git repository, so there is nothing to inventory.")
    return sorted({line for line in out.splitlines() if line})


def _frontmatter_text(path):
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    match = FRONTMATTER.match(text)
    return match.group(1) if match else None


def frontmatter(path):
    """The top-level frontmatter keys of a markdown file, as a dict of raw strings.

    Deliberately not a YAML parse: the only values read here are scalars and a
    boolean, and a stdlib-only script that guesses at YAML is a worse dependency
    than no parse at all. A key whose value spans lines comes back as the empty
    string, which is enough to know the key is present.
    """
    body = _frontmatter_text(path)
    if body is None:
        return {}
    return {k: v.strip() for k, v in KEY.findall(body)}


def description(path):
    """The description as one line, with block-scalar folding flattened.

    Length matters here and wrapping does not, so a folded block and a single
    long line that say the same thing must measure the same. Surrounding quotes
    on a one-line value are not part of the description and are not counted.
    """
    body = _frontmatter_text(path)
    if body is None:
        return ""
    found = re.search(
        r"^description:[ \t]*(>-|>\+|>|\|-|\|\+|\|)?[ \t]*\n?((?:.|\n)*?)(?=\n[A-Za-z][A-Za-z0-9_-]*:|\Z)",
        body,
        re.M,
    )
    if not found:
        return ""
    text = " ".join(found.group(2).split())
    if not found.group(1) and len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        quote = text[0]
        text = text[1:-1]
        text = text.replace("''", "'") if quote == "'" else text.replace('\\"', '"')
    return text


def _skill_dirs_under(files, prefix, recursive):
    """Skill folders (the parent of a SKILL.md) under `prefix`."""
    prefix = prefix.strip("/")
    found = []
    for f in files:
        p = PurePosixPath(f)
        if p.name != "SKILL.md":
            continue
        parent = p.parent
        try:
            rel = parent.relative_to(prefix) if prefix else parent
        except ValueError:
            continue
        if str(rel) == ".":
            continue
        if recursive or len(rel.parts) == 1:
            found.append(str(parent))
    return found


def _plugin_skill_dirs(root, files, file_set, manifest):
    """The plugin's name and the skill folders its manifest registers.

    A `skills` entry may name one skill folder or a folder of skills. Without the
    array, Claude Code reads the plugin's own `skills/` folder.
    """
    plugin_root = posixpath.dirname(posixpath.dirname(manifest))
    try:
        data = json.loads((root / manifest).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        data = {}
    name = data.get("name") if isinstance(data, dict) and isinstance(data.get("name"), str) else (plugin_root or "(root)")
    entries = data.get("skills", ["skills"]) if isinstance(data, dict) else ["skills"]
    if isinstance(entries, str):
        entries = [entries]
    dirs = []
    for entry in entries:
        if not isinstance(entry, str):
            continue
        rel = posixpath.normpath(posixpath.join(plugin_root, entry))
        rel = "" if rel == "." else rel
        if posixpath.join(rel, "SKILL.md") in file_set:
            dirs.append(rel)
        else:
            dirs.extend(_skill_dirs_under(files, rel, recursive=False))
    return name, dirs


def discover_skills(root, files=None, extra_roots=()):
    """Every skill in the repository, as {dir: set(sources)}, in path order."""
    files = ls_files(root) if files is None else files
    found = {}

    def add(dirs, source):
        for d in dirs:
            found.setdefault(d, set()).add(source)

    for d in HARNESS_SKILL_DIRS:
        add(_skill_dirs_under(files, d, recursive=False), d + "/")
    add(_skill_dirs_under(files, "skills", recursive=True), "skills/")
    file_set = set(files)
    for manifest in (f for f in files if f.endswith(".claude-plugin/plugin.json")):
        name, dirs = _plugin_skill_dirs(root, files, file_set, manifest)
        add(dirs, f"plugin {name}")
    for extra in extra_roots:
        add(_skill_dirs_under(files, extra, recursive=True), extra.strip("/") + "/")
    return dict(sorted(found.items()))


def workspace_setting(root, label):
    """A path from docs/agents/workspace.md, `None` for "none", "" when unset."""
    path = root / "docs" / "agents" / "workspace.md"
    try:
        text = path.read_text(encoding="utf-8")
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


def _count(files, predicate):
    return sum(1 for f in files if predicate(f))


def census(root, extra_roots=(), conventions="", cases=""):
    files = ls_files(root)
    skills = []
    for d, sources in discover_skills(root, files, extra_roots).items():
        path = root / d / "SKILL.md"
        keys = frontmatter(path)
        under = d + "/"
        skills.append(
            {
                "name": keys.get("name") or PurePosixPath(d).name,
                "path": f"{d}/SKILL.md",
                "found_in": sorted(sources),
                "description_chars": len(description(path)),
                "body_bytes": path.stat().st_size if path.exists() else 0,
                "model_invocable": keys.get("disable-model-invocation", "").lower() != "true",
                "references": _count(files, lambda f: f.startswith(under + "references/")),
                "scripts": _count(files, lambda f: f.startswith(under + "scripts/")),
                "sub_skills": _count(files, lambda f: f.startswith(under + "sub-skills/")),
            }
        )
    skills.sort(key=lambda s: (s["name"], s["path"]))

    if conventions == "":
        conventions = workspace_setting(root, "Conventions folder")
    if cases == "":
        cases = workspace_setting(root, "Eval cases") or DEFAULT_CASES
    cases = cases.strip("/") if cases else None
    conventions = conventions.strip("/") if conventions else None

    case_files = []
    if cases:
        case_files = [
            f for f in files
            if f.startswith(cases + "/") and f.endswith((".yaml", ".yml"))
            and not f.endswith((".config.yaml", ".config.yml"))
        ]
    case_text = ""
    for f in case_files:
        try:
            case_text += (root / f).read_text(encoding="utf-8") + "\n"
        except (OSError, UnicodeDecodeError):
            pass
    for s in skills:
        s["has_cases"] = bool(re.search(
            r"^\s*(?:-\s*)?value:\s*['\"]?" + re.escape(s["name"]) + r"['\"]?\s*$", case_text, re.M
        ))

    names = {}
    for s in skills:
        names.setdefault(s["name"], []).append(s["path"])
    duplicates = {n: p for n, p in names.items() if len(p) > 1}

    base = lambda f: PurePosixPath(f).name
    harness = {
        "AGENTS.md": _count(files, lambda f: base(f) == "AGENTS.md"),
        "CLAUDE.md": _count(files, lambda f: base(f) == "CLAUDE.md"),
        "GEMINI.md": _count(files, lambda f: base(f) == "GEMINI.md"),
        "copilot instructions": _count(files, lambda f: f == ".github/copilot-instructions.md"
                                       or (f.startswith(".github/instructions/") and f.endswith(".md"))),
        "Claude Code rules": _count(files, lambda f: f.startswith(".claude/rules/") and f.endswith(".md")),
        "Cursor rules": _count(files, lambda f: f.startswith(".cursor/rules/")),
        "Claude Code agents": _count(files, lambda f: f.startswith(".claude/agents/") and f.endswith(".md")),
        "Claude Code commands": _count(files, lambda f: f.startswith(".claude/commands/") and f.endswith(".md")),
        "plugin manifests": _count(files, lambda f: f.endswith(".claude-plugin/plugin.json")),
    }
    conventions_docs = (
        _count(files, lambda f: f.startswith(conventions + "/") and f.endswith(".md")) if conventions else 0
    )

    return {
        "skills": skills,
        "duplicate_names": duplicates,
        "harness": {k: v for k, v in harness.items() if v},
        "conventions": {"folder": conventions, "docs": conventions_docs},
        "cases": {"folder": cases, "files": len(case_files)},
        "counts": {
            "skills": len(skills),
            "model_invocable": sum(1 for s in skills if s["model_invocable"]),
            "human_invoked": sum(1 for s in skills if not s["model_invocable"]),
            "references": sum(s["references"] for s in skills),
            "scripts": sum(s["scripts"] for s in skills),
            "sub_skills": sum(s["sub_skills"] for s in skills),
        },
    }


def _take(argv, flag, many=False):
    values = []
    while flag in argv:
        i = argv.index(flag)
        if i + 1 >= len(argv):
            raise SystemExit(f"census.py: {flag} needs a value")
        values.append(argv[i + 1])
        del argv[i : i + 2]
    if many:
        return values
    return values[-1] if values else ""


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in argv
    if as_json:
        argv.remove("--json")
    extra = _take(argv, "--root", many=True)
    conventions = _take(argv, "--conventions")
    cases = _take(argv, "--cases")
    if len(argv) > 1 or any(a.startswith("--") for a in argv):
        raise SystemExit("usage: census.py [repo-root] [--json] [--root DIR ...] [--conventions DIR] [--cases DIR]")
    root = Path(argv[0] if argv else ".").resolve()

    data = census(root, extra, conventions, cases)
    if as_json:
        print(json.dumps(data, indent=2))
        return 0

    counts = data["counts"]
    skills = data["skills"]
    invocable = [s for s in skills if s["model_invocable"]]
    manual = [s for s in skills if not s["model_invocable"]]

    print(f"{counts['skills']} skills: {counts['model_invocable']} model-invocable, "
          f"{counts['human_invoked']} human-invoked")
    sources = {}
    for s in skills:
        for src in s["found_in"]:
            sources[src] = sources.get(src, 0) + 1
    if sources:
        print("  found in: " + ", ".join(f"{k} ({v})" for k, v in sorted(sources.items())))
    print(f"  {counts['references']} references, {counts['sub_skills']} sub-skills, "
          f"{counts['scripts']} scripts")
    for name, paths in sorted(data["duplicate_names"].items()):
        print(f"  name '{name}' appears {len(paths)} times: {', '.join(paths)}")

    if data["harness"]:
        print("Harness files: " + ", ".join(f"{v} {k}" for k, v in data["harness"].items()))
    conv = data["conventions"]
    print(f"Conventions folder: {conv['folder']}/ ({conv['docs']} documents)" if conv["folder"]
          else "Conventions folder: none configured")
    cases = data["cases"]
    covered = sum(1 for s in invocable if s["has_cases"])
    if cases["folder"]:
        print(f"Routing cases: {cases['files']} files in {cases['folder']}/, "
              f"asserting on {covered} of {len(invocable)} model-invocable skills")

    print("\nModel-invocable. A trigger eval can be written for each of these:")
    for s in invocable:
        mark = "  cases" if s["has_cases"] else ""
        print(f"  {s['name']:34} {s['description_chars']:>4} chars{mark}")

    print("\nHuman-invoked. No trigger eval is possible; a person types the name:")
    for s in manual:
        print(f"  {s['name']:34} {s['description_chars']:>4} chars")

    total = sum(s["description_chars"] for s in skills)
    print(f"\nAlways-resident descriptions: {total} chars, roughly {total // 4} tokens.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Prove every harness-eval script bites, and stays quiet where it should.

Covers `check_globs.py`, `check_descriptions.py`, `census.py`'s skill discovery,
`run.sh --print-config` and `engine.sh status`, all in
`skills/harness/harness-eval/scripts/`.

Usage: python3 tests/harness-eval/test_checks.py

Each case builds a small git repository, plants one shape, and asserts the script
either reports it or says nothing. A check nobody has watched fail is a check
nobody should believe: the clean run it produces is indistinguishable from one
where it never ran. A check nobody has watched stay silent is one that will start
crying wolf.

Both halves are load-bearing and both tallies are printed. A new finding any
check can emit is not covered until a case here makes it fire, so add the case in
the same change as the check.

Stdlib only. No third-party dependencies, no venv. Costs nothing: no routing run
is ever started.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCRIPTS = REPO / "skills" / "harness" / "harness-eval" / "scripts"
ENGINE = REPO / "skills" / "harness" / "harness-eval" / "engine"
FIXTURES = HERE / "fixtures"


def git_init(root):
    subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)


def write(root, rel, text="# stub\n"):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def skill_md(name, description, extra=""):
    extra = f"{extra}\n" if extra else ""
    return f"---\nname: {name}\ndescription: {description}\n{extra}---\n\n# {name}\n"


def build_rules(root, rule_globs, files):
    """One Claude Code rule carrying `rule_globs`, plus `files` on disk."""
    paths = "\n".join(f"  - '{g}'" for g in rule_globs)
    write(root, ".claude/rules/writing/probe.md", f"---\ndescription: A probe rule\npaths:\n{paths}\n---\n\n# Probe\n")
    for rel in files:
        write(root, rel)
    git_init(root)


def build_skills(root, skills):
    """`skills` maps a SKILL.md path to its full text."""
    for rel, text in skills.items():
        write(root, rel, text)
    git_init(root)


def run(args, cwd=None):
    proc = subprocess.run(args, capture_output=True, text=True, cwd=cwd)
    return proc.stdout, proc.stderr, proc.returncode


def py(script, *args):
    return run([sys.executable, str(SCRIPTS / script), *map(str, args)])


# ---------------------------------------------------------------------------
# check_globs.py. Each: label, globs, files, extra args, expected substring.
# ---------------------------------------------------------------------------
GLOB_BITES = [
    ("over-reach into a named vendored tree", ["**/*.md"],
     ["docs/note.md", "vendor/kit/SKILL.md", "vendor/kit/reference.md"], ["--vendored", "vendor/"],
     "reaches 2 files under vendor/"),
    ("over-reach, with the prefix named without its trailing slash", ["**/*.md"],
     ["docs/note.md", "third_party/CLAUDE.md"], ["--vendored", "third_party"],
     "reaches 1 files under third_party/"),
    ("a glob matching nothing at all", ["Nonexistent/**/*.md"], ["docs/note.md"], [],
     "matches no file"),
    ("brace syntax, which is not portable and therefore matches nothing", ["docs/**/*.{md,txt}"],
     ["docs/note.md"], [], "matches no file"),
]

GLOB_QUIET = [
    ("a glob scoped to a tree this repository authors", ["docs/**/*.md"],
     ["docs/note.md", "vendor/reference.md"], ["--vendored", "vendor/"]),
    ("a broad glob where no vendored tree is named", ["**/*.md"], ["docs/note.md", "vendor/note.md"], []),
    ("a root-anchored glob matching exactly one real file", ["CLAUDE.md"],
     ["CLAUDE.md", "vendor/reference.md"], ["--vendored", "vendor/"]),
    ("`**/` matching zero intervening segments, so a root file is reached", ["**/CLAUDE.md"], ["CLAUDE.md"], []),
]

# ---------------------------------------------------------------------------
# check_descriptions.py. Each: label, {path: SKILL.md text}, extra args, expected.
# ---------------------------------------------------------------------------
DESC_BITES = [
    ("one character over the default 1024 cap",
     {".claude/skills/probe/SKILL.md": skill_md("probe", "a" * 1025)}, [],
     "description is 1025 chars, over the 1024-character cap"),
    ("a human-invoked description over the cap, which still spends the budget",
     {".claude/skills/probe/SKILL.md": skill_md("probe", "a" * 1100, "disable-model-invocation: true")}, [],
     "description is 1100 chars, over the 1024-character cap"),
    ("a house cap passed with --cap",
     {".claude/skills/probe/SKILL.md": skill_md("probe", "a" * 501)}, ["--cap", "500"],
     "description is 501 chars, over the 500-character cap"),
    ("a skill in a catalog layout, skills/<family>/<name>/",
     {"skills/family/probe/SKILL.md": skill_md("probe", "a" * 1030)}, [],
     "skills/family/probe/SKILL.md: description is 1030 chars"),
    ("a skill in .agents/skills/",
     {".agents/skills/probe/SKILL.md": skill_md("probe", "a" * 1030)}, [],
     ".agents/skills/probe/SKILL.md: description is 1030 chars"),
    ("a folded block scalar measured after folding",
     {".claude/skills/probe/SKILL.md": "---\nname: probe\ndescription: >-\n  " + "\n  ".join(["a" * 100] * 11)
      + "\n---\n"}, [],
     "description is 1110 chars"),
]

DESC_QUIET = [
    ("a description comfortably under the cap",
     {".claude/skills/probe/SKILL.md": skill_md("probe", "A short and tidy description.")}, []),
    ("a description exactly on the default cap",
     {".claude/skills/probe/SKILL.md": skill_md("probe", "a" * 1024)}, []),
    ("a quoted one-line description on the cap; the quotes are not counted",
     {".claude/skills/probe/SKILL.md": skill_md("probe", '"' + "a" * 1024 + '"')}, []),
    ("a long fixture outside every discovery root",
     {"tests/fixtures/skills/probe/SKILL.md": skill_md("probe", "a" * 2000)}, []),
]


def case_globs(bites):
    results = []
    for label, globs, files, args, *expected in (GLOB_BITES if bites else GLOB_QUIET):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            root.mkdir()
            build_rules(root, globs, files)
            out, err, code = py("check_globs.py", root, *args)
            ok = (expected[0] in out and code == 1) if bites else (code == 0 and not out.strip())
            results.append((label, ok, code, out))
    return results


def case_descriptions(bites):
    results = []
    for label, skills, args, *expected in (DESC_BITES if bites else DESC_QUIET):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            root.mkdir()
            build_skills(root, skills)
            out, err, code = py("check_descriptions.py", root, *args)
            ok = (expected[0] in out and code == 1) if bites else (code == 0 and not out.strip())
            results.append((label, ok, code, out))
    return results


def case_globs_skip():
    """No .claude/rules/: the check is Claude Code only, so it skips cleanly."""
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "repo"
        root.mkdir()
        build_skills(root, {".agents/skills/probe/SKILL.md": skill_md("probe", "x")})
        out, err, code = py("check_globs.py", root)
        return [("no .claude/rules/ is skipped, not failed", code == 0 and not out.strip() and "Skipped" in err, code, out + err)]


def case_census():
    """Discovery finds skills wherever harnesses read them, and nowhere else."""
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "repo"
        root.mkdir()
        build_skills(root, {
            ".claude/skills/alpha/SKILL.md": skill_md("alpha", "Alpha."),
            ".agents/skills/bravo/SKILL.md": skill_md("bravo", "Bravo."),
            "skills/family/charlie/SKILL.md": skill_md("charlie", "Charlie.", "disable-model-invocation: true"),
            "plugins/p/.claude-plugin/plugin.json": json.dumps({"name": "p", "skills": ["./extra/delta"]}),
            "plugins/p/extra/delta/SKILL.md": skill_md("delta", "Delta."),
            "tests/fixtures/skills/echo/SKILL.md": skill_md("echo", "Echo."),
            "docs/agents/workspace.md": "- **Conventions folder:** `docs/standards/`.\n"
                                        "- **Eval cases:** `evals/cases/`. Routing cases.\n",
            "docs/standards/voice.md": "# Voice\n",
            "evals/cases/alpha.yaml": "- vars:\n    query: q\n  assert:\n    - type: skill-used\n      value: alpha\n",
        })
        out, err, code = py("census.py", root, "--json")
        try:
            data = json.loads(out)
        except json.JSONDecodeError:
            return [("census --json parses", False, code, out + err)]
        names = {s["name"]: s for s in data["skills"]}
        results.append(("finds .claude, .agents, catalog and plugin skills, not fixtures",
                        set(names) == {"alpha", "bravo", "charlie", "delta"}, code, str(sorted(names))))
        results.append(("splits the human-invoked skill out",
                        names.get("charlie", {}).get("model_invocable") is False
                        and data["counts"]["model_invocable"] == 3, code, json.dumps(data["counts"])))
        results.append(("names the plugin a skill came from",
                        "plugin p" in names.get("delta", {}).get("found_in", []), code, str(names.get("delta"))))
        results.append(("reads the conventions and cases folders from workspace.md",
                        data["conventions"] == {"folder": "docs/standards", "docs": 1}
                        and data["cases"] == {"folder": "evals/cases", "files": 1}, code,
                        json.dumps([data["conventions"], data["cases"]])))
        results.append(("marks which skills a case asserts on",
                        names["alpha"]["has_cases"] and not names["bravo"]["has_cases"], code, ""))

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "repo"
        root.mkdir()
        build_skills(root, {
            ".claude/skills/alpha/SKILL.md": skill_md("alpha", "Alpha."),
            "docs/agents/workspace.md": "- **Conventions folder:** none. Set a path (for example `docs/standards/`).\n",
        })
        out, err, code = py("census.py", root, "--json")
        data = json.loads(out) if code == 0 else {}
        results.append(("a conventions folder of none is not mistaken for its example path",
                        data.get("conventions", {}).get("folder") is None, code, out + err))
    return results


def case_run_config():
    """run.sh --print-config: the invariants a routing run depends on, at no cost."""
    results = []
    run_sh = SCRIPTS / "run.sh"
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "repo"
        root.mkdir()
        write(root, ".evals/cases/widget.yaml", (FIXTURES / "widget-forge.yaml").read_text(encoding="utf-8"))
        write(root, ".evals/cases/widget.config.yaml", "description: not a case file\n")
        write(root, "simple.yaml", "- query: forge a widget\n  should_trigger: true\n")
        git_init(root)

        out, err, code = run(["bash", str(run_sh), "--repo", str(root), "--skills", str(FIXTURES / "skills"),
                              "--print-config"])
        sandbox = next((l.split('"')[1] for l in out.splitlines() if l.strip().startswith("working_dir:")), "")
        try:
            results.append(("Skill is an allowed tool, or no skill-used assertion could pass",
                            code == 0 and '"Skill"' in out, code, out + err))
            results.append(("the default cases folder is used and .config.yaml is skipped",
                            "widget.yaml" in out and "widget.config.yaml" not in out, code, out))
            results.append(("--skills copies every fixture into a sandbox .claude/skills/",
                            bool(sandbox) and all((Path(sandbox) / ".claude" / "skills" / n / "SKILL.md").is_file()
                                                  for n in ("widget-forge-a", "widget-forge-b", "widget-inspect")),
                            code, sandbox))
        finally:
            if sandbox.startswith(tempfile.gettempdir()) or "harness-eval-sandbox." in sandbox:
                shutil.rmtree(sandbox, ignore_errors=True)

        out, err, code = run(["bash", str(run_sh), "--repo", str(root), "--print-config", "simple.yaml"])
        results.append(("a case file in another format is refused, not run",
                        code == 1 and "not in the case format" in err, code, out + err))

        out, err, code = run(["bash", str(run_sh), "--repo", str(root), "--print-config"])
        results.append(("without --skills the repository itself is the working directory",
                        code == 0 and f'working_dir: "{root.resolve()}"' in out, code, out + err))
    return results


def case_engine():
    """engine.sh status plans the install in engine/ or, read-only, in the scratch folder."""
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        skill = Path(tmp) / "skill"
        (skill / "scripts").mkdir(parents=True)
        (skill / "engine").mkdir()
        shutil.copy(SCRIPTS / "engine.sh", skill / "scripts" / "engine.sh")
        for f in ("package.json", "package-lock.json"):
            shutil.copy(ENGINE / f, skill / "engine" / f)
        repo = Path(tmp) / "repo"
        repo.mkdir()
        git_init(repo)
        engine = (skill / "engine").resolve()

        out, err, code = run(["bash", str(skill / "scripts" / "engine.sh"), "status", "--repo", str(repo)])
        results.append(("not installed: exit 3 and the exact npm ci command for engine/",
                        code == 3 and f'npm ci --prefix "{engine}"' in out, code, out + err))

        if os.geteuid() != 0:
            os.chmod(engine, 0o555)
            try:
                out, err, code = run(["bash", str(skill / "scripts" / "engine.sh"), "status", "--repo", str(repo),
                                      "--scratch", ".scratch"])
            finally:
                os.chmod(engine, 0o755)
            fallback = repo.resolve() / ".scratch" / "harness-eval-engine"
            results.append(("read-only engine/: the install falls back to the scratch folder",
                            code == 3 and f'npm ci --prefix "{fallback}"' in out, code, out + err))

        out, err, code = run(["bash", str(skill / "scripts" / "engine.sh"), "path", "--repo", str(repo)])
        results.append(("path fails with exit 3 when nothing is installed", code == 3 and not out.strip(), code, out))
    return results


def main():
    groups = [
        ("bites", case_globs(True) + case_descriptions(True)),
        ("quiet", case_globs(False) + case_descriptions(False) + case_globs_skip()),
        ("works", case_census() + case_run_config() + case_engine()),
    ]
    failed = 0
    for kind, results in groups:
        for label, ok, code, detail in results:
            if ok:
                print(f"  {kind:6}  {label}")
            else:
                failed += 1
                print(f"  FAILED  {label}")
                print(f"          exit {code}; output: {detail.strip()[:600] or '(empty)'}")
    bites, quiet, works = (groups[0][1], groups[1][1], groups[2][1])
    print(f"\n{sum(r[1] for r in bites)}/{len(bites)} injected defects caught")
    print(f"{sum(r[1] for r in quiet)}/{len(quiet)} legitimate shapes proven not to fire")
    print(f"{sum(r[1] for r in works)}/{len(works)} discovery, config and install checks hold")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

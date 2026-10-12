#!/usr/bin/env python3
"""Prove every check in the standards skill's validate-routing.py bites, and stays quiet.

Usage: python3 tests/standards/test_validate_routing.py

Each case builds the fixture repository below in a temporary folder, applies one
change, and asserts the validator either reports it or says nothing. A check
nobody has watched fail is indistinguishable from one that never ran; a check
nobody has watched stay silent is one that will start crying wolf. Both tallies
are printed. A new finding the validator can emit is not covered until a case
here makes it fire, so add the case in the same change as the check.

Set VALIDATOR to run the suite against another copy of the script (for example a
deliberately broken one, to watch the suite fail).

Stdlib only.
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
VALIDATOR = Path(os.environ.get("VALIDATOR") or REPO / "skills" / "harness" / "standards" / "scripts" / "validate-routing.py")

# A small repository with a conventions folder, an always-loaded router, a
# Claude Code rule, a Cursor rule, one declared-unrouted section with the skill
# that consumes it, and a decision record. It must validate clean.
FIXTURE = {
    ".gitignore": ".scratchpad/\n",
    "AGENTS.md": "# Agents\n\nHouse rules live in [docs/standards/](docs/standards/README.md).\n",
    "docs/agents/workspace.md": (
        "# Workspace\n\n- **Scratch folder:** `.scratchpad/`.\n"
        "- **Conventions folder:** `docs/standards/`. House rules.\n"
    ),
    "docs/standards/README.md": (
        "# Standards\n\n## The documents\n\n"
        "- [writing](writing.md): prose.\n- [code](code.md): source.\n\n"
        "## Intentionally unrouted\n\n"
        "- [code § Commit messages](code.md#commit-messages): no file is open when a "
        "commit is written; the `commit` skill links it.\n"
    ),
    "docs/standards/writing.md": (
        "# Writing\n\n## House voice\n\nPlain words.\n\n"
        "## Links\n\nRelative links. See [code § Error handling](code.md#error-handling).\n"
    ),
    "docs/standards/code.md": (
        "# Code\n\n## Error handling\n\nFail loudly.\n\n### Retries\n\nThree at most.\n\n"
        "## Commit messages\n\nConventional commits.\n"
    ),
    ".claude/rules/writing.md": (
        "---\ndescription: House writing rules for markdown\npaths:\n  - '**/*.md'\n---\n\n"
        "# Writing\n\n- [writing § House voice](../../docs/standards/writing.md#house-voice)\n"
        "- [writing § Links](../../docs/standards/writing.md#links)\n"
    ),
    ".cursor/rules/errors.mdc": (
        "---\ndescription: Error handling in TypeScript\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\n"
        "- [code § Error handling](../../docs/standards/code.md#error-handling)\n"
    ),
    "skills/commit/SKILL.md": (
        "---\nname: commit\ndescription: Commit.\n---\n\n"
        "Follow [code § Commit messages](../../docs/standards/code.md#commit-messages).\n"
    ),
    "docs/adr/0001-conventional-commits.md": (
        "# Conventional commits\n\nWeighed against [code § Commit messages](../standards/code.md#commit-messages).\n"
    ),
    "src/app.ts": "export const app = 1;\n",
}


def write(root, rel, text):
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def edit(root, rel, old, new):
    p = root / rel
    text = p.read_text(encoding="utf-8")
    assert old in text, f"fixture drift: {old!r} not in {rel}"
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


def remove(root, rel):
    p = root / rel
    shutil.rmtree(p) if p.is_dir() else p.unlink()


def build(root, files=FIXTURE, git=True):
    for rel, text in files.items():
        write(root, rel, text)
    if git:
        subprocess.run(["git", "-C", str(root), "init", "-q"], check=True)


def run(root, *args, cwd=None):
    proc = subprocess.run(
        [sys.executable, str(VALIDATOR), *([str(root)] if root else []), *args],
        capture_output=True, text=True, cwd=cwd,
    )
    return proc.stdout, proc.stderr, proc.returncode


# --- mutations ------------------------------------------------------------------


def mask_with_ignored_copy(r):
    """A git-ignored scratch note still links the section after the real consumer stops.

    Scratch notes, review sessions and worktree copies sit on disk beside the real
    tree. Counting one as the consumer reports the section reached when nothing a
    commit contains reaches it.
    """
    write(r, ".scratchpad/notes.md", "Copied: [code § Commit messages](../docs/standards/code.md#commit-messages)\n")
    edit(r, "skills/commit/SKILL.md", "code.md#commit-messages", "code.md")


def record_as_consumer(r):
    """The consumer stops linking; only a decision record still names the section."""
    edit(r, "skills/commit/SKILL.md", "code.md#commit-messages", "code.md")


def readme_in_decision_folder(r):
    """A decision folder's README is a live document, not a record, so it is checked."""
    write(r, "docs/adr/README.md", "# Decisions\n\nSee [code § Gone](../standards/code.md#gone).\n")


def retired_heading_in_record(r):
    write(r, "docs/adr/0002-retired.md", "# Retired\n\nOnce [code § Gone](../standards/code.md#gone).\n")


def no_routing_layer(r):
    """No harness rules at all: the index and AGENTS.md are the whole router."""
    remove(r, ".claude")
    remove(r, ".cursor")
    edit(r, "docs/standards/code.md", "## Commit messages", "## Naming\n\nShort.\n\n## Commit messages")


def whole_document_pointer(r):
    """A rule that links a whole document routes every section in it."""
    write(r, ".claude/rules/writing.md",
          "---\ndescription: House writing rules\npaths:\n  - '**/*.md'\n---\n\n"
          "- [writing](../../docs/standards/writing.md)\n")


def unrelated_rule(r):
    """A rule that links nothing in the conventions is not a pointer rule and is left alone."""
    write(r, ".claude/rules/legacy.md", "---\nalwaysApply: true\nweird: 1\n---\n\nUse tabs.\n")


def single_file_conventions(r):
    """The conventions are one file: it is both the index and the only document."""
    remove(r, "docs/standards")
    write(r, "CONVENTIONS.md",
          "# Conventions\n\n## House voice\n\nPlain.\n\n## Commit messages\n\nConventional.\n\n"
          "## Intentionally unrouted\n\n- [Commit messages](#commit-messages): the `commit` skill.\n")
    write(r, "AGENTS.md", "# Agents\n\nRead CONVENTIONS.md.\n")
    write(r, "docs/agents/workspace.md", "- **Conventions folder:** `CONVENTIONS.md`.\n")
    write(r, ".claude/rules/writing.md",
          "---\ndescription: d\npaths:\n  - '**/*.md'\n---\n\n- [House voice](../../CONVENTIONS.md#house-voice)\n")
    remove(r, ".cursor")
    write(r, "skills/commit/SKILL.md", "Follow [commits](../../CONVENTIONS.md#commit-messages).\n")
    remove(r, "docs/adr")


CASES = [
    ("a routed heading is renamed out from under its pointer",
     lambda r: edit(r, "docs/standards/writing.md", "## House voice", "## Voice"),
     "writing.md#house-voice, which is not a heading"),
    ("a heading rename breaks a link from inside the conventions folder itself",
     lambda r: edit(r, "docs/standards/code.md", "## Error handling", "## Errors"),
     "docs/standards/writing.md: link"),
    ("a heading rename breaks a citation in a skill",
     lambda r: edit(r, "skills/commit/SKILL.md", "#commit-messages", "#commit-message"),
     "skills/commit/SKILL.md: link"),
    ("a link points at a document that does not exist",
     lambda r: edit(r, "skills/commit/SKILL.md", "code.md#", "coding.md#"),
     "which does not exist"),
    ("a link's label names a different section than it points at",
     lambda r: edit(r, ".claude/rules/writing.md", "[writing § Links]", "[writing § House voice]"),
     "a different section"),
    ("a new section is neither routed nor declared",
     lambda r: edit(r, "docs/standards/code.md", "## Commit messages", "## Naming\n\nShort.\n\n## Commit messages"),
     "code.md § Naming: neither routed"),
    ("a declaration is dropped from the index",
     lambda r: edit(r, "docs/standards/README.md", "- [code § Commit messages](code.md#commit-messages)", "- Commit messages"),
     "code.md § Commit messages: neither routed"),
    ("a section is both routed and declared unrouted",
     lambda r: edit(r, "docs/standards/README.md", "## Intentionally unrouted\n",
                    "## Intentionally unrouted\n\n- [writing § Links](writing.md#links): nothing.\n"),
     "both routed by a rule and declared unrouted"),
    ("the consumer a declaration names stops linking the section",
     lambda r: edit(r, "skills/commit/SKILL.md", "code.md#commit-messages", "code.md"),
     "but no file links it"),
    ("a git-ignored scratch note masks a link deleted from the real tree",
     mask_with_ignored_copy, "but no file links it"),
    ("a decision record is counted as the consumer a declaration promises",
     record_as_consumer, "but no file links it"),
    ("a decision folder's README cites a heading that does not exist",
     readme_in_decision_folder, "docs/adr/README.md: link"),
    ("a Claude Code pointer rule grows a third frontmatter key",
     lambda r: edit(r, ".claude/rules/writing.md", "description:", "alwaysApply: true\ndescription:"),
     "frontmatter key 'alwaysApply'"),
    ("a Claude Code pointer rule loses its paths glob",
     lambda r: edit(r, ".claude/rules/writing.md", "paths:\n  - '**/*.md'\n", ""),
     "loads it in every session"),
    ("a Cursor pointer rule is set to always apply",
     lambda r: edit(r, ".cursor/rules/errors.mdc", "alwaysApply: false", "alwaysApply: true"),
     "alwaysApply: true loads it in every session"),
    ("a Cursor pointer rule loses its globs",
     lambda r: edit(r, ".cursor/rules/errors.mdc", "globs: src/**/*.ts\n", ""),
     "no matching file attaches it"),
    ("a document is missing from the index",
     lambda r: write(r, "docs/standards/testing.md", "# Testing\n\n## Fixtures\n\nSmall.\n"),
     "docs/standards/testing.md: not linked from"),
    ("the folder loses its README index",
     lambda r: remove(r, "docs/standards/README.md"), "no README.md index"),
    ("AGENTS.md stops naming the conventions",
     lambda r: write(r, "AGENTS.md", "# Agents\n\nNothing here.\n"),
     "AGENTS.md: never names docs/standards"),
    ("the repository has no instructions file",
     lambda r: remove(r, "AGENTS.md"), "no AGENTS.md"),
    ("a section in a rules folder passed with --rules goes unrouted once that rule is removed",
     lambda r: (shutil.move(str(r / ".cursor"), str(r / "harness-rules"))),
     "code.md § Error handling: neither routed"),
]

# Cases that must leave the tree clean.
QUIET = [
    ("the fixture as built", lambda r: None),
    ("a link written in angle brackets with an encoded space",
     lambda r: (write(r, "docs/standards/house style.md", "# House style\n\n## Tone\n\nWarm.\n"),
                edit(r, "docs/standards/README.md", "- [code](code.md): source.",
                     "- [code](code.md): source.\n- [style](<house style.md>): tone."),
                edit(r, ".claude/rules/writing.md", "- [writing § Links]",
                     "- [style § Tone](../../docs/standards/house%20style.md#tone)\n- [writing § Links]"))),
    ("a decision record cites a heading that has since been retired", retired_heading_in_record),
    ("a broken link inside a code fence is an example, not a link",
     lambda r: edit(r, "skills/commit/SKILL.md", "Follow",
                    "```\n[x](../../docs/standards/code.md#nope)\n```\n\nFollow")),
    ("a broken link inside a tilde fence is an example, not a link",
     lambda r: edit(r, "skills/commit/SKILL.md", "Follow",
                    "~~~md\n[x](../../docs/standards/code.md#nope)\n~~~\n\nFollow")),
    ("a heading inside a fenced example is not a section",
     lambda r: edit(r, "docs/standards/code.md", "Fail loudly.",
                    "Fail loudly.\n\n~~~md\n## An example heading\n~~~")),
    ("a broken link inside a code span is an example, not a link",
     lambda r: edit(r, "skills/commit/SKILL.md", "Follow",
                    "Write `[x](../../docs/standards/code.md#nope)` like this. Follow")),
    ("a repeated heading resolves with GitHub's numeric suffix",
     lambda r: (edit(r, "docs/standards/code.md", "Three at most.", "Three at most.\n\n### Retries\n\nAgain."),
                edit(r, "skills/commit/SKILL.md", "Follow", "See [r](../../docs/standards/code.md#retries-1). Follow"))),
    ("a link label wraps across a line break, as prose does",
     lambda r: edit(r, "skills/commit/SKILL.md", "[code § Commit messages]", "[code § Commit\nmessages]")),
    ("a link label carries a code span",
     lambda r: (edit(r, "docs/standards/code.md", "## Commit messages", "## Commit messages in `git log`"),
                edit(r, "skills/commit/SKILL.md", "[code § Commit messages](../../docs/standards/code.md#commit-messages)",
                     "[code § Commit messages in `git log`](../../docs/standards/code.md#commit-messages-in-git-log)"),
                edit(r, "docs/standards/README.md", "(code.md#commit-messages)", "(code.md#commit-messages-in-git-log)"),
                edit(r, "docs/adr/0001-conventional-commits.md", "#commit-messages", "#commit-messages-in-git-log"))),
    ("a link label shortens a long heading",
     lambda r: edit(r, "skills/commit/SKILL.md", "[code § Commit messages]", "[code § Commit]")),
    ("a rule that links a whole document routes all its sections", whole_document_pointer),
    ("a rule that links nothing in the conventions is left alone", unrelated_rule),
    ("Cursor globs written as a list", lambda r: edit(r, ".cursor/rules/errors.mdc", "globs: src/**/*.ts", "globs:\n  - src/**/*.ts")),
    ("no routing layer: sections need no declaration", no_routing_layer),
    ("the conventions are a single file", single_file_conventions),
    ("--conventions overrides workspace.md",
     lambda r: write(r, "docs/agents/workspace.md", "- **Conventions folder:** `elsewhere/`.\n")),
]
QUIET_ARGS = {"--conventions overrides workspace.md": ["--conventions", "docs/standards/"]}
CASE_ARGS = {"a section in a rules folder passed with --rules goes unrouted once that rule is removed": []}

# The precondition half: exit 1, nothing on stdout, the reason on stderr.
PRECONDITIONS = [
    ("workspace.md sets the conventions to none",
     lambda r: write(r, "docs/agents/workspace.md", "- **Conventions folder:** none.\n"), "sets the conventions folder to none"),
    ("no conventions line and no flag",
     lambda r: remove(r, "docs/agents/workspace.md"), "no conventions folder is configured"),
    ("the configured folder does not exist",
     lambda r: remove(r, "docs/standards"), "holds no file git can see"),
]


def main():
    failures = 0

    def check(name, ok, out, err):
        nonlocal failures
        print(f"{'ok' if ok else 'FAILED'}  {name}")
        if not ok:
            failures += 1
            print("        " + ((out + err).strip() or "(no output)").replace("\n", "\n        "))

    bites = 0
    for name, mutate, expect in CASES:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build(root)
            mutate(root)
            out, err, code = run(root, *CASE_ARGS.get(name, []))
            ok = code == 1 and expect in out
            # The --rules case also proves the flag: passing the moved folder routes it again.
            if ok and name in CASE_ARGS:
                out2, err2, code2 = run(root, "--rules", "harness-rules")
                ok = code2 == 0
                out, err = out + out2, err + err2
            bites += ok
            check(f"bites: {name}", ok, out, err)

    quiet = 0
    for name, mutate in QUIET:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build(root)
            mutate(root)
            out, err, code = run(root, *QUIET_ARGS.get(name, []))
            ok = code == 0 and "FAIL" not in out
            quiet += ok
            check(f"quiet: {name}", ok, out, err)

    pre = 0
    for name, mutate, expect in PRECONDITIONS:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            build(root)
            mutate(root)
            out, err, code = run(root)
            ok = code == 1 and out == "" and expect in err
            pre += ok
            check(f"precondition: {name}", ok, out, err)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build(root, git=False)
        out, err, code = run(root)
        ok = code == 1 and out == "" and "not a git repository" in err
        pre += ok
        check("precondition: not a git repository", ok, out, err)

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        build(root)
        out, err, code = run(None, cwd=root / "src")
        ok = code == 0
        quiet += ok
        check("quiet: run with no argument from a subfolder finds the repository", ok, out, err)

    print(f"\n{bites}/{len(CASES)} injected defects caught")
    print(f"{quiet}/{len(QUIET) + 1} legitimate shapes proven not to fire")
    print(f"{pre}/{len(PRECONDITIONS) + 1} preconditions reported on stderr")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Pin session-retro's session-digest.py to the counting claims the skill tells an agent to trust.

Usage: python3 tests/session-retro/test_session_digest.py

`fixture/` is a small synthetic Claude Code project directory, built to break a
careless parser. It carries both on-disk layouts for subagent transcripts (flat
`agent-*.jsonl` beside the parent, and nested `<session id>/subagents/`), a
sibling session with its own subagent that must NOT be folded in, requests split
across content-block lines, a repeated tool_use id, a successful tool result
beside the failed ones, a line `json.loads` rejects,
a line that parses without being a record, content blocks that are bare strings,
one search retried with different flags, and three failures sharing one command
text so a grouped row has more than one candidate id.

Every check is named, and every one has been watched failing against a
deliberately broken copy of the script. Set SESSION_DIGEST to run the suite
against another copy (for example a mutated one, to watch it fail).

Stdlib only.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Importing the script would leave a __pycache__ inside the skill folder, which installers copy.
sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SCRIPT = Path(
    os.environ.get("SESSION_DIGEST")
    or REPO / "skills" / "harness" / "session-retro" / "scripts" / "session-digest.py"
)
FIXTURE = HERE / "fixture"
PARENT = "11111111-1111-1111-1111-111111111111"
OTHER = "22222222-2222-2222-2222-222222222222"


def load():
    spec = importlib.util.spec_from_file_location("session_digest", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def cli(*args, cwd=None, env=None):
    full = dict(os.environ)
    full.update(env or {})
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True, text=True, cwd=cwd, env=full,
    )


def main():
    failures = []

    def check(label, got, want):
        if got == want:
            print("  ok    %s" % label)
        else:
            failures.append(label)
            print("  FAIL  %s: got %r, want %r" % (label, got, want))

    sd = load()

    # Folding: both layouts join the parent by sessionId; the decoy session does not.
    paths = sd.with_sidechains([str(FIXTURE / (PARENT + ".jsonl"))], str(FIXTURE))
    check("transcripts folded: both subagent layouts, not the decoy",
          sorted(os.path.basename(p) for p in paths),
          [PARENT + ".jsonl", "agent-flat01.jsonl", "agent-nest01.jsonl"])

    d = sd.Digest()
    try:
        for path in paths:
            d.ingest(path)
        crash = None
    except Exception as exc:  # a guard removed: report it by name, not as a traceback
        crash = "%s: %s" % (type(exc).__name__, exc)
    check("ingest skips unparseable lines, non-records and bare-string blocks", crash, None)
    if crash:
        print("\n1 check(s) FAILED: ingest crashed, so nothing after it can be checked")
        return 1
    check("subagent transcripts counted", d.agent_transcripts, 2)

    # Counts. 14 assistant lines in the parent, 1 flat, 2 nested; the unparseable
    # line, the bare JSON string and the user records are none of them.
    check("assistant lines, one per content block", d.assistant_lines, 17)
    check("API requests, distinct requestId", len(d.request_ids), 12)
    check("tool calls, distinct tool_use id (an echoed line counts once)", len(d.calls), 13)
    check("sidechain lines", d.sidechain_lines, 3)
    check("failed calls", len(d.errors), 7)
    check("tool calls by tool", dict(d.by_tool()),
          {"Bash": 8, "Read": 1, "Grep": 1, "WebFetch": 1, "Skill": 1, "Agent": 1})
    check("skills fired", dict(d.skills()), {"handoff": 1})
    check("subagents dispatched", dict(d.subagents()), {"Explore": 1})
    check("read churn joins a file read and a shell cat of the same path", d.reads().get("/x/y.md"), 2)

    # The failure table: identical failures group, the rare tool sorts first, the
    # retained id is the first occurrence, and a cd prefix never hides the command.
    rows = d.failure_rows()
    check("identical failures group to one row", len(rows), 5)
    check("grouped row keeps the first id", [r[1] for r in rows if r[3] == 3], ["call-h1"])
    check("rarest tool sorts first", rows[0][0], "WebFetch")
    check("cd prefix stripped from failed shell calls",
          sorted(r[2] for r in rows if r[0] == "Bash"),
          ["grep -rn needle src", "ls dup", "ls missing", "ls other"])

    check("cd: quoted path", sd.strip_cd_prefix('cd "/a b/c" && ls x'), "ls x")
    check("cd: single-quoted path", sd.strip_cd_prefix("cd '/a b/c' && ls x"), "ls x")
    check("cd: newline separates", sd.strip_cd_prefix('cd "/a b/c"\nls x'), "ls x")
    check("cd: nested", sd.strip_cd_prefix('cd /a && cd "/b c" && ls x'), "ls x")
    check("cd: a bare cd is left alone", sd.strip_cd_prefix("cd /tmp"), "cd /tmp")
    check("cd: cdk is not cd", sd.strip_cd_prefix("cdk && ls x"), "cdk && ls x")
    check("slug: every non-alphanumeric becomes a dash", sd.slug("/a b/c.d_e"), "-a-b-c-d-e")

    # Shell parsing: the counted command is the real one, not a prefix or wrapper.
    check("command after a prefix segment", sd.bash_head("set -e && cat f"), "cat")
    check("command behind an assignment and wrappers", sd.bash_head("FOO=1 env time grep x"), "grep")
    check("args stop at the first redirect", sd.commands("cat f > out.txt"), [("cat", ["f"])])
    check("bash shape counts the first real command", dict(d.bash_shape()), {"ls": 5, "grep": 2, "cat": 1})

    # Repeated searches: a retry with other flags collides; two different searches never do.
    check("repeated search collides on the term", d.searches().get("grep needle src"), 2)

    def key(line):
        return ["%s %s" % (h, sd.search_key(a)) for h, a in sd.commands(line) if h in sd.SEARCHERS]

    check("search: retry with other flags collides", key("grep -rn x src") == key("grep -n x src"), True)
    check("search: a filter value is not the term", key("rg --glob '*.py' x .") == key("rg x ."), True)
    check("search: a context value is not the term", key("rg -A 3 x") == key("rg -B 5 x"), True)
    check("search: different -name targets stay apart", key("find . -name a") != key("find . -name b"), True)
    check("search: different patterns stay apart", key("rg -A 3 a") != key("rg -B 3 b"), True)
    check("search: a pattern-file flag keeps its argument", key("grep -f a.txt src") != key("grep -f b.txt src"), True)
    check("search: an unbalanced quote still keys on the term", sd.search_key(["'x", "src"]), "x src")

    # The command line, end to end.
    out = cli("--project", str(FIXTURE), PARENT)
    check("cli: exit code", out.returncode, 0)
    check("cli: reports the fold", "from 2 subagent transcripts" in out.stdout, True)
    seeded = [cli("--project", str(FIXTURE), PARENT, env={"PYTHONHASHSEED": s}).stdout for s in ("1", "987654")]
    check("cli: output is identical under two hash seeds", seeded[0] == seeded[1] and seeded[0] != "", True)

    out = cli("--project", str(FIXTURE), PARENT, "--json")
    try:
        data = json.loads(out.stdout)
        got = (data["tool_calls"], data["api_requests"], data["failed_calls"], data["agent_transcripts"],
               data["read_churn"], data["repeated_searches"])
    except (ValueError, KeyError) as exc:
        got = "unreadable JSON: %s" % exc
    check("cli: --json carries the counts", got, (13, 12, 7, 2, {"/x/y.md": 2}, {"grep needle src": 2}))

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp).resolve()
        config = tmp / "config"
        work = tmp / "work"
        (work / "nested" / "deeper").mkdir(parents=True)
        project = config / "projects" / sd.slug(str(work))
        shutil.copytree(FIXTURE, project)
        # The parent is the newest session; a sidechain newer still must not be picked.
        for name, stamp in ((OTHER + ".jsonl", 1000), (PARENT + ".jsonl", 2000), ("agent-flat01.jsonl", 3000)):
            os.utime(project / name, (stamp, stamp))
        env = {"CLAUDE_CONFIG_DIR": str(config)}

        out = cli(cwd=work / "nested" / "deeper", env=env)
        check("default: CLAUDE_CONFIG_DIR, slug, fallback up the tree, newest parent session",
              (out.returncode, "sessions        " + PARENT in out.stdout,
               "from 2 subagent transcripts" in out.stdout),
              (0, True, True))

        out = cli("--list", cwd=work, env=env)
        listed = [line.split()[-1] for line in out.stdout.splitlines()[1:]]
        check("--list: parent sessions only, newest first", listed, [PARENT, OTHER])

        out = cli(PARENT, cwd=work, env=env)
        check("a session id resolves under this working directory's project",
              (out.returncode, "from 2 subagent transcripts" in out.stdout), (0, True))

        stranger = tmp / "elsewhere"
        stranger.mkdir()
        empty = {"CLAUDE_CONFIG_DIR": str(tmp / "no-config")}
        out = cli(str(project / (PARENT + ".jsonl")), cwd=stranger, env=empty)
        check("a pointed-at transcript folds the sidechains beside it",
              (out.returncode, "from 2 subagent transcripts" in out.stdout), (0, True))

        out = cli(cwd=stranger, env=empty)
        check("no transcript directory: a usable error",
              (out.returncode != 0, out.stdout, str(tmp / "no-config" / "projects") in out.stderr,
               "--project" in out.stderr),
              (True, "", True, True))

        out = cli("no-such-session", cwd=work, env=env)
        check("unknown session id: a usable error",
              (out.returncode != 0, "no transcript named no-such-session" in out.stderr), (True, True))

    if failures:
        print("\n%d check(s) FAILED: %s" % (len(failures), "; ".join(failures)))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

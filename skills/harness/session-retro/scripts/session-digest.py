#!/usr/bin/env python3
"""Digest a Claude Code session transcript into the counts a retro reasons from.

Reports tool-call counts, which skills fired, file-read churn, repeated searches,
failed calls and subagent dispatches. It reads and prints. It writes nothing.

The format is Claude Code's: one JSONL file per session under
`$CLAUDE_CONFIG_DIR/projects/<slug>/` (default `~/.claude/projects/`), with
subagent sidechains in `agent-*.jsonl` files stamped with the parent's sessionId.
Other harnesses keep other logs; this script does not read them.

The correctness property: a transcript writes ONE LINE PER CONTENT BLOCK, and
every line of one response repeats that response's `requestId` and `usage`.
Anything counting lines counts a single API call two to four times. Turns are
therefore counted as distinct `requestId` values, and tool calls as distinct
`tool_use` block ids, so a repeated line can never inflate either.

Python 3 standard library only. Deterministic: every table sorts by count
descending, then by name, so two runs over the same file are byte-identical.
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import re
import shlex
import sys

READERS = {"cat", "head", "tail", "sed", "bat", "less", "more", "nl", "rtk", "open"}
SEARCHERS = {"grep", "rg", "ugrep", "ug", "ack", "ag", "find", "fd", "locate"}
SEARCH_TOOLS = {"Grep", "Glob"}
PROJECTS = os.path.join(
    os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude"), "projects"
)

# A shell line is several commands. Split on the operators first, so `set -e && cat f`
# reports `cat` rather than `set`, and a heredoc body never reaches the path filter.
OPERATORS = re.compile(r"\|\||&&|[;|&\n]")
COMMAND_WORD = re.compile(r"^[A-Za-z_][A-Za-z0-9_.-]*$")
PATHLIKE = re.compile(r"^[^\s]*(/[^\s]*|\.[A-Za-z0-9]{1,5})$")
REDIRECT = re.compile(r"^\d*[<>]")
METACHARS = set("\\*?[]!$<>|{}")
NOISE = "`'\"()[],:;"
# A segment prefix is the whole command: nothing a retro counts hides behind it.
SEGMENT_PREFIXES = {"cd", "pushd", "set", "export", "unset", "source", "."}
# A wrapper stands in front of the real command, which is what should be counted.
WRAPPER_PREFIXES = {"time", "env", "sudo", "exec", "nohup", "xargs"}


def slug(path):
    """Claude Code names a project directory by replacing every non-alphanumeric."""
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(path))


def project_dir(start):
    """The transcript directory for `start`, or for its nearest ancestor that has one.

    A worktree gets its own directory; falling back up the tree finds the primary
    checkout's transcripts when the worktree has none of its own yet.
    """
    here = os.path.abspath(start)
    while True:
        candidate = os.path.join(PROJECTS, slug(here))
        if os.path.isdir(candidate) and any(f.endswith(".jsonl") for f in os.listdir(candidate)):
            return candidate
        parent = os.path.dirname(here)
        if parent == here:
            return None
        here = parent


def transcripts(directory):
    """Parent session transcripts, newest first.

    `agent-*.jsonl` is a subagent's sidechain, not a session anybody asks for by
    name: it carries its PARENT's sessionId, so it is folded into that parent by
    `with_sidechains` rather than being offered as a session of its own.
    """
    files = [
        os.path.join(directory, f)
        for f in os.listdir(directory)
        if f.endswith(".jsonl") and not f.startswith("agent-")
    ]
    return sorted(files, key=os.path.getmtime, reverse=True)


def session_id_of(path):
    """The sessionId this transcript belongs to, or None."""
    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            if record.get("sessionId"):
                return record["sessionId"]
    return None


def agent_transcripts(directory):
    """Every subagent transcript under `directory`, in either on-disk layout.

    Claude Code writes these two ways: flat beside the parent, and nested at
    `<session id>/subagents/agent-*.jsonl`. Both carry the parent's sessionId,
    so the join key is the same; only the traversal differs. Walking rather than
    listing is what makes this layout-agnostic, and the nested form is by far
    the more common of the two, so a flat listing misses most of the work.
    """
    found = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d != "tool-results"]
        for name in files:
            if name.startswith("agent-") and name.endswith(".jsonl"):
                found.append(os.path.join(root, name))
    return sorted(found)


def with_sidechains(paths, directory):
    """Each path plus every subagent transcript sharing its sessionId.

    A session that dispatched subagents has their work in separate files stamped
    with the parent's sessionId. Selecting by filename alone reports the parent's
    tool calls and silently drops every subagent's, which is why this joins on
    identity. It reports a count so a zero is legible as a real zero.
    """
    if not directory or not os.path.isdir(directory):
        return paths
    wanted, out = set(), list(paths)
    for path in paths:
        sid = session_id_of(path)
        if sid:
            wanted.add(sid)
    if not wanted:
        return out
    seen = set(os.path.abspath(p) for p in out)
    for sibling in agent_transcripts(directory):
        if os.path.abspath(sibling) in seen:
            continue
        # In the nested layout the containing session directory names the parent,
        # which saves opening the file; the flat layout has to be read.
        parent = os.path.basename(os.path.dirname(os.path.dirname(sibling)))
        sid = parent if parent in wanted else session_id_of(sibling)
        if sid in wanted:
            out.append(sibling)
    return out


def resolve(args):
    """Return the list of transcript paths to digest, newest first.

    A path given directly folds in the sidechains beside it, not the ones under
    this working directory's project: a log the user points at from another
    checkout or machine keeps its subagents.
    """
    if args.session:
        out = []
        for s in args.session:
            if os.path.isfile(s):
                path = os.path.abspath(s)
                directory = args.project or os.path.dirname(path)
            else:
                directory = args.project or project_dir(os.getcwd())
                if not directory:
                    sys.exit(
                        "no transcript directory under %s for this working directory; "
                        "pass a path to a .jsonl file or --project DIR" % PROJECTS
                    )
                path = os.path.join(directory, s if s.endswith(".jsonl") else s + ".jsonl")
                if not os.path.isfile(path):
                    sys.exit("no transcript named %s under %s; --list shows what is there" % (s, directory))
            seen = set(os.path.abspath(p) for p in out)
            out.extend(p for p in with_sidechains([path], directory) if os.path.abspath(p) not in seen)
        return out
    directory = args.project or project_dir(os.getcwd())
    if not directory:
        sys.exit(
            "no transcript directory under %s for this working directory; "
            "pass a session's .jsonl path or --project DIR" % PROJECTS
        )
    found = transcripts(directory)
    if not found:
        sys.exit("no .jsonl transcripts under %s" % directory)
    return with_sidechains(found[: args.last], directory)


# Flags whose next token is context or a filter rather than part of what was
# searched for. Dropping them is what stops `rg -A 3 x` keying on "3" and
# colliding with `rg -B 3 y`, reporting a repeat for two searches that never
# repeated. A flag whose argument IS the pattern (`-e`, `-name`, `-f`) is
# deliberately absent: it falls through as an unrecognised flag and its argument
# lands in the key as an ordinary token, which is the behaviour wanted.
VALUE_FLAGS = {
    "-A", "-B", "-C", "-m", "--include", "--exclude",
    "--max-count", "--glob", "-type", "-maxdepth", "--context",
}
# `-g` is absent on purpose, and it is the only such case: it means a glob to
# ripgrep but the pattern itself to fd and ag, and one table cannot know which
# ran. Keeping an ambiguous value splits one row into two, which under-reports a
# repeat; dropping it merges two searches into a repeat that never happened.
# Only the second fabricates evidence, so ambiguity keeps the value. The short
# flags listed above carry the same meaning in every searcher here, so they are
# safe to drop.


def strip_cd_prefix(line):
    """A shell line with any leading `cd ...&&` segments removed.

    A session that opens every shell call with a cd into the same long absolute
    path would otherwise show the same sixty characters on every row of a
    head-truncated detail column, identifying nothing.
    """
    rest = str(line)
    # Strip before normalising whitespace: a newline is a separator too, and
    # flattening it to a space first hides that. Most leading cd lines in a real
    # session end in a newline rather than && or ;.
    while True:
        stripped = re.sub(
            r"^\s*cd\s+(?:'[^']*'|\"[^\"]*\"|\S+)\s*(?:&&|;|\n)\s*", "", rest
        )
        if stripped == rest:
            break
        rest = stripped
    return " ".join(rest.split())


def search_key(args):
    """The searched-for part of a command: flags and their filter values removed.

    Keying on the whole line means the same search retried with a different flag
    never collides, which is the repeat this table exists to show. Keying on the
    first non-flag token is worse: it fabricates repeats, because `find . -name a`
    and `find . -name b` both reduce to `.`. What identifies a search is every
    token that is neither a flag nor a filter's value, quotes stripped so
    `grep "x"` and `grep 'x'` are one row rather than two.
    """
    terms, drop_next = [], False
    for arg in args:
        if drop_next:
            drop_next = False
            continue
        if arg in VALUE_FLAGS:
            drop_next = True
            continue
        if arg.startswith("-"):
            continue
        terms.append(arg.strip("'\""))
    return " ".join(terms) or "(no term)"


def commands(line):
    """Every command in a shell line, as (name, args), skipping prefixes like `cd`.

    Args stop at the first redirect, which is what keeps a heredoc body out.
    """
    found = []
    for segment in OPERATORS.split(line or ""):
        try:
            tokens = shlex.split(segment)
        except ValueError:
            tokens = segment.split()
        while tokens:
            head = tokens[0]
            if head in SEGMENT_PREFIXES:
                tokens = []  # this segment belongs to a prefix command, not to a reader
                break
            if head in WRAPPER_PREFIXES or (
                COMMAND_WORD.match(head.split("=")[0] or "x") and "=" in head
            ):
                tokens = tokens[1:]  # strip the wrapper or assignment, keep the command
                continue
            if not COMMAND_WORD.match(head):
                tokens = tokens[1:]
                continue
            break
        if not tokens:
            continue
        args = []
        for token in tokens[1:]:
            if REDIRECT.match(token):
                break
            args.append(token)
        found.append((tokens[0], args))
    return found


def bash_head(line):
    """The first real command word in a shell line, for the tool-economy histogram."""
    found = commands(line)
    return found[0][0] if found else ""


def paths_from(args):
    out = []
    for token in args:
        if token.startswith("-"):
            continue
        token = token.strip(NOISE)
        if token and not METACHARS & set(token) and PATHLIKE.match(token):
            out.append(token)
    return out


class Digest:
    def __init__(self):
        self.assistant_lines = 0
        self.request_ids = set()
        self.sidechain_lines = 0
        self.calls = {}  # tool_use id -> (tool name, input dict)
        self.errors = set()  # tool_use ids that came back is_error
        self.sessions = []
        self.directories = []  # step 2 of the retro needs the path, not just the id
        self.agent_transcripts = 0  # sidechain files folded in, reported beside the count
        self.branches = collections.Counter()
        self.first = None
        self.last = None

    def ingest(self, path):
        name = os.path.basename(path)[:-6]
        if name.startswith("agent-"):
            self.agent_transcripts += 1
        else:
            self.sessions.append(name)
        directory = os.path.dirname(os.path.abspath(path))
        if directory not in self.directories:
            self.directories.append(directory)
        with open(path, errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                # A truncated write can leave a line that parses as valid JSON
                # without being a record, so check the shape and not just the parse.
                if not isinstance(rec, dict):
                    continue
                kind = rec.get("type")
                stamp = rec.get("timestamp")
                if stamp:
                    self.first = min(self.first or stamp, stamp)
                    self.last = max(self.last or stamp, stamp)
                if rec.get("gitBranch"):
                    self.branches[rec["gitBranch"]] += 1
                content = (rec.get("message") or {}).get("content")
                if not isinstance(content, list):
                    continue
                if kind == "assistant":
                    self.assistant_lines += 1
                    if rec.get("isSidechain"):
                        self.sidechain_lines += 1
                    msg = rec.get("message") or {}
                    self.request_ids.add(rec.get("requestId") or msg.get("id") or rec.get("uuid"))
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "tool_use":
                            # setdefault, never +=: a repeated line must not count twice.
                            self.calls.setdefault(block.get("id"), (block.get("name"), block.get("input") or {}))
                elif kind == "user":
                    for block in content:
                        if (
                            isinstance(block, dict)
                            and block.get("type") == "tool_result"
                            and block.get("is_error")
                        ):
                            self.errors.add(block.get("tool_use_id"))

    # Derived views.

    def by_tool(self):
        return collections.Counter(name for name, _ in self.calls.values())

    def skills(self):
        fired = collections.Counter()
        for name, params in self.calls.values():
            if name == "Skill" and params.get("skill"):
                fired[params["skill"]] += 1
        return fired

    def subagents(self):
        return collections.Counter(
            params.get("subagent_type", "unspecified")
            for name, params in self.calls.values()
            if name == "Agent"
        )

    def reads(self):
        hits = collections.Counter()
        for name, params in self.calls.values():
            if name == "Read" and params.get("file_path"):
                hits[params["file_path"]] += 1
            elif name == "Bash":
                for head, args in commands(params.get("command", "")):
                    if head in READERS:
                        for p in paths_from(args):
                            hits[p] += 1
        return hits

    def searches(self):
        hits = collections.Counter()
        for name, params in self.calls.values():
            if name in SEARCH_TOOLS:
                hits["%s %s in %s" % (name, params.get("pattern", ""), params.get("path", "."))] += 1
            elif name == "Bash":
                line = params.get("command", "")
                for head, args in commands(line):
                    if head not in SEARCHERS:
                        continue
                    hits["%s %s" % (head, search_key(args))] += 1
        return hits

    def bash_shape(self):
        return collections.Counter(
            bash_head(params.get("command", "")) or "(empty)"
            for name, params in self.calls.values()
            if name == "Bash"
        )

    def failures(self):
        return collections.Counter(
            self.calls[i][0] for i in self.errors if i in self.calls
        )

    def failure_rows(self):
        """Failed calls as (tool, tool_use id, what identifies the call, count).

        Step 2 of the retro is told to open the session at the failed calls, so a
        bare tool name is not enough to act on: the id is what makes the call
        findable in the transcript without reading it end to end.

        Two things this has to survive on a fanned-out session. Identical calls
        are collapsed and counted, because a repeated failure is one finding and
        sixty rows of the same shell prefix is not evidence. And a Bash detail is
        the command itself rather than the raw line, because a session that opens
        every line with the same `cd` into a long absolute path would have a
        head-truncation reduce it to sixty identical rows.
        """
        grouped = {}
        # Iterate self.calls, not self.errors: the latter is a set, so its order
        # is hash-randomised and both the retained id and the tie order would
        # change between runs. self.calls preserves transcript order, which makes
        # the retained id the first occurrence and the whole table reproducible.
        for i, (name, params) in self.calls.items():
            if i not in self.errors:
                continue
            if name == "Bash":
                # Drop the leading `cd <path> &&` a line may open with, then
                # keep the rest: truncating the head instead collapsed sixty
                # distinct commands into one row, and stopping at the first
                # redirect merged ten different heredocs into `python3 -`.
                detail = strip_cd_prefix(params.get("command", ""))
            else:
                detail = (
                    params.get("file_path")
                    or params.get("pattern")
                    or params.get("path")
                    or params.get("url")
                    or ""
                )
            detail = " ".join(str(detail).split())[:70]
            key = (name, detail)
            if key in grouped:
                grouped[key][1] += 1
            else:
                grouped[key] = [i, 1]
        rows = [(n, i, d, c) for (n, d), (i, c) in grouped.items()]
        # Rarer tools first: a lone WebFetch failure among sixty Bash ones is the
        # row most likely to be worth opening, and sorting by tool name buries it.
        # Every key is total so the order cannot depend on insertion or hashing.
        per_tool = collections.Counter(n for n, _, _, _ in rows)
        rows.sort(key=lambda r: (per_tool[r[0]], r[0], -r[3], r[2], r[1]))
        return rows


def ranked(counter, top=None, floor=1):
    rows = [(v, k) for k, v in counter.items() if v >= floor]
    rows.sort(key=lambda r: (-r[0], str(r[1])))
    return rows[:top] if top else rows


def render(d, top):
    out = []
    add = out.append
    calls = len(d.calls)
    add("SESSION DIGEST")
    listed = d.sessions if len(d.sessions) <= 3 else d.sessions[:3] + ["and %d more" % (len(d.sessions) - 3)]
    add("  sessions        %s" % ", ".join(listed))
    add("  window          %s to %s" % (d.first or "?", d.last or "?"))
    add("  transcripts     %s" % (", ".join(d.directories) or "?"))
    add("  branches        %s" % (", ".join(b for _, b in ranked(d.branches, 5)) or "?"))
    add("")
    add("COUNTS (deduplicated)")
    add("  assistant lines %d   one per content block, never a call count" % d.assistant_lines)
    add("  API requests    %d   distinct requestId" % len(d.request_ids))
    add("  inflation       %.2fx lines per request" % (d.assistant_lines / len(d.request_ids) if d.request_ids else 0))
    add("  tool calls      %d   distinct tool_use block ids" % calls)
    add("  sidechain lines %d   from %d subagent transcript%s folded in by sessionId"
        % (d.sidechain_lines, d.agent_transcripts, "" if d.agent_transcripts == 1 else "s"))
    add("  failed calls    %d   %.0f%% of tool calls" % (
        len(d.errors), 100.0 * len(d.errors) / calls if calls else 0))

    def table(title, rows, note=""):
        add("")
        add(title + (("  " + note) if note else ""))
        if not rows:
            add("  (none)")
            return
        for count, label in rows:
            add("  %5d  %s" % (count, label))

    table("TOOL CALLS BY TOOL", ranked(d.by_tool(), top))
    table("SKILLS FIRED", ranked(d.skills()))
    table("SUBAGENTS DISPATCHED", ranked(d.subagents()))
    table("FAILED CALLS BY TOOL", ranked(d.failures(), top))

    rows = d.failure_rows()
    if rows:
        add("")
        add("FAILED CALLS  (id finds one of them; xN = that many with the same text)")
        for name, call_id, detail, count in rows[:top]:
            tail = "  x%d" % count if count > 1 else ""
            add("  %-10s %s  %s%s" % (name, call_id, detail, tail))
        if len(rows) > top:
            add("  ... %d more distinct failures" % (len(rows) - top))
    table("BASH COMMAND SHAPE", ranked(d.bash_shape(), top), "(tool economy)")
    table("FILE-READ CHURN", ranked(d.reads(), top, floor=2), "(read 2+ times)")
    table("REPEATED SEARCHES", ranked(d.searches(), top, floor=2), "(issued 2+ times)")
    return "\n".join(out)


def as_json(d, top):
    return json.dumps(
        {
            "sessions": d.sessions,
            "directories": d.directories,
            "agent_transcripts": d.agent_transcripts,
            "window": [d.first, d.last],
            "assistant_lines": d.assistant_lines,
            "api_requests": len(d.request_ids),
            "tool_calls": len(d.calls),
            "sidechain_lines": d.sidechain_lines,
            "failed_calls": len(d.errors),
            "by_tool": dict(ranked_pairs(d.by_tool(), top)),
            "skills": dict(ranked_pairs(d.skills(), None)),
            "subagents": dict(ranked_pairs(d.subagents(), None)),
            "failures": dict(ranked_pairs(d.failures(), top)),
            "failure_rows": [
                {"tool": n, "id": i, "detail": s, "count": c}
                for n, i, s, c in d.failure_rows()
            ],
            "bash_shape": dict(ranked_pairs(d.bash_shape(), top)),
            "read_churn": dict(ranked_pairs(d.reads(), top, floor=2)),
            "repeated_searches": dict(ranked_pairs(d.searches(), top, floor=2)),
        },
        indent=2,
    )


def ranked_pairs(counter, top, floor=1):
    return [(label, count) for count, label in ranked(counter, top, floor)]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("session", nargs="*", help="session id or .jsonl path; default is the newest")
    parser.add_argument("--project", help="transcript directory to read instead of the one for this cwd")
    parser.add_argument("--last", type=int, default=1, help="digest the N newest transcripts (default 1)")
    parser.add_argument("--top", type=int, default=15, help="rows per table (default 15)")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of the report")
    parser.add_argument("--list", action="store_true", help="list available transcripts, newest first")
    args = parser.parse_args(argv)

    if args.list:
        directory = args.project or project_dir(os.getcwd())
        if not directory:
            sys.exit(
                "no transcript directory under %s for this working directory; "
                "pass --project DIR" % PROJECTS
            )
        print(directory)
        for path in transcripts(directory):
            print("  %8d B  %s" % (os.path.getsize(path), os.path.basename(path)[:-6]))
        return 0

    digest = Digest()
    for path in resolve(args):
        digest.ingest(path)
    print(as_json(digest, args.top) if args.json else render(digest, args.top))
    return 0


if __name__ == "__main__":
    sys.exit(main())

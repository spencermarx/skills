#!/usr/bin/env python3
"""Persist a board subagent's final message to the file its PATH: line names.

Usage: persist-final-message.py <subagent transcript.jsonl>

The transcript is the JSONL file a harness keeps for a subagent (Claude Code's
task output file): one JSON object per line, with "type" of "user" or
"assistant" and "message.content" a list of blocks. The final message is the
text of the assistant rows after the last user row; its first non-blank line
must read `PATH: <absolute path>`. The rest is written there and the path
printed, so the hands persist a refused write without restating the document.

The path must lie inside an existing board directory, the scratch entry the
board's session created (.../arch-board/<YYYYMMDD-HHMMSS>-<slug>/), must not be
inside this skill's own folder, and must not exist yet. A PATH line is written by
a subagent, so these checks are what keep it from adding files anywhere else,
an installed skill's references/ or scripts/ included.
"""
import json
import os
import re
import sys

USAGE = "usage: persist-final-message.py <subagent transcript.jsonl>"
BOARD_SEGMENT = "arch-board"
# A scratch entry's name: the UTC timestamp `new` stamps, then the kebab-case slug.
BOARD_ENTRY = re.compile(r"^[0-9]{8}-[0-9]{6}-[a-z0-9]+(-[a-z0-9]+)*$")
SKILL_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def final_message(transcript):
    rows = []
    with open(transcript, encoding="utf-8") as f:
        for n, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as e:
                sys.exit(f"{transcript}:{n}: not a JSONL transcript ({e.msg})")
    last_user = max((i for i, r in enumerate(rows) if r.get("type") == "user"), default=-1)
    parts = []
    for row in rows[last_user + 1:]:
        if row.get("type") != "assistant":
            continue
        content = row.get("message", {}).get("content", [])
        if isinstance(content, str):
            parts.append(content)
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block["text"])
    return "".join(parts)


def board_dir_of(dest):
    """The .../arch-board/<entry> prefix of dest, or None when dest is not beneath one."""
    parts = dest.split(os.sep)
    # The last arch-board segment followed by a scratch entry name and a file beneath it.
    for i in range(len(parts) - 3, -1, -1):
        if parts[i] == BOARD_SEGMENT and BOARD_ENTRY.match(parts[i + 1]):
            return os.sep.join(parts[: i + 2])
    return None


def inside_skill(dest):
    """Whether dest lies in this skill's folder, judged by file identity.

    A string comparison misses a path that differs only in case on a
    case-insensitive file system, where realpath does not fold case. Every
    existing ancestor of dest is compared with the skill folder as a file instead.
    """
    path = dest
    while True:
        if os.path.exists(path) and os.path.samefile(path, SKILL_DIR):
            return True
        parent = os.path.dirname(path)
        if parent == path:
            return False
        path = parent


def main():
    if len(sys.argv) != 2:
        sys.exit(USAGE)
    transcript = sys.argv[1]
    if not os.path.isfile(transcript):
        sys.exit(f"no such transcript: {transcript}")
    text = final_message(transcript).lstrip("\n")
    first, _, body = text.partition("\n")
    if not first.startswith("PATH:"):
        sys.exit("final message does not start with a PATH: line; nothing written")
    raw = first[len("PATH:"):].strip()
    if not os.path.isabs(raw):
        sys.exit(f"PATH is not absolute: {raw}")
    dest = os.path.realpath(raw)
    if inside_skill(dest):
        sys.exit(f"refusing to write inside the arch-board skill's own folder: {dest}")
    board = board_dir_of(dest)
    if board is None or not os.path.isdir(board):
        sys.exit(f"refusing to write outside an existing arch-board session directory: {dest}")
    if os.path.lexists(dest):
        sys.exit(f"refusing to overwrite: {dest}")
    if not body.strip():
        sys.exit("final message has a PATH: line but no body; nothing written")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "w", encoding="utf-8") as f:
        f.write(body.strip("\n") + "\n")
    print(dest)


if __name__ == "__main__":
    main()

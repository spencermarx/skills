#!/usr/bin/env bash
#
# Run routing cases through promptfoo and the Claude Agent SDK, or open the viewer.
#
#   run.sh [options] <case file or folder>... [-- <promptfoo eval args>]
#   run.sh --view [--repo DIR] [--scratch DIR]
#
# Options:
#   --repo DIR              repository under test (default: the git root of the cwd)
#   --scratch DIR           scratch folder, relative to the repo (default: .scratchpad)
#   --skills DIR            measure the skills under DIR instead of the repo's
#                           .claude/skills/ (repeatable). They are copied into a
#                           throwaway sandbox's .claude/skills/, so skill names stay bare.
#   --setting-sources LIST  Claude Code settings to load (default: project). Add
#                           user (project,user) to see user-installed skills and plugins.
#   --repeat N              run every case N times (passed to promptfoo)
#   --print-config          print the generated promptfoo config and stop. Needs no
#                           install and costs nothing.
#
# With no case paths, runs every case file under <repo>/.evals/cases/.
#
# A case file is a promptfoo test list (vars.query plus skill-used /
# not-skill-used assertions). Files ending .config.yaml are skipped.
#
# This measures Claude Code: the provider runs the same `claude` binary and
# `claude_code` system prompt a live session does. Every case costs money,
# billed to the Claude Code login or ANTHROPIC_API_KEY.
#
# Paths are resolved from this script's own location, so it works from any cwd.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR

usage() {
  sed -n '3,23p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

repo=""
scratch=".scratchpad"
setting_sources="project"
view=0
print_config=0
skills=()
cases=()
passthrough=()

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:?--repo needs a directory}"; shift 2 ;;
    --scratch) scratch="${2:?--scratch needs a directory}"; shift 2 ;;
    --skills) skills+=("${2:?--skills needs a directory}"); shift 2 ;;
    --setting-sources) setting_sources="${2:?--setting-sources needs a list}"; shift 2 ;;
    --repeat) passthrough+=("--repeat" "${2:?--repeat needs a number}"); shift 2 ;;
    --print-config) print_config=1; shift ;;
    --view) view=1; shift ;;
    -h | --help) usage ;;
    --) shift; passthrough+=("$@"); break ;;
    -*) echo "run.sh: unknown option $1 (pass promptfoo options after --)" >&2; exit 2 ;;
    *) cases+=("$1"); shift ;;
  esac
done

if [ -z "$repo" ]; then
  repo="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi
repo="$(cd "$repo" && pwd -P)"
case "$scratch" in
  /*) scratch_dir="$scratch" ;;
  *) scratch_dir="$repo/${scratch%/}" ;;
esac

# promptfoo keeps its results database here. Without PROMPTFOO_CONFIG_DIR it
# writes to ~/.promptfoo, outside the repository, and a later run compares
# against nothing: a silent failure, since the suite still prints a number.
export PROMPTFOO_CONFIG_DIR="$scratch_dir/harness-eval/promptfoo"

engine_dir() {
  bash "$SCRIPT_DIR/engine.sh" path --repo "$repo" --scratch "$scratch" || {
    echo "run.sh: install the engine first. See: bash $SCRIPT_DIR/engine.sh status" >&2
    exit 3
  }
}

if [ "$view" -eq 1 ]; then
  install="$(engine_dir)"
  mkdir -p "$PROMPTFOO_CONFIG_DIR"
  cd "$install"
  exec "$install/node_modules/.bin/promptfoo" view
fi

command -v python3 >/dev/null 2>&1 || { echo "run.sh: python3 is required." >&2; exit 1; }

[ ${#cases[@]} -gt 0 ] || cases=("$repo/.evals/cases")

# Each case path is resolved against the cwd first, then the repository root.
resolved=()
for c in "${cases[@]}"; do
  if [ -e "$c" ]; then
    resolved+=("$(cd "$(dirname "$c")" && pwd)/$(basename "$c")")
  elif [ -e "$repo/$c" ]; then
    resolved+=("$repo/$c")
  else
    echo "run.sh: no case file or folder at $c" >&2
    exit 1
  fi
done
skill_dirs=()
for s in ${skills[@]+"${skills[@]}"}; do
  if [ -d "$s" ]; then
    skill_dirs+=("$(cd "$s" && pwd)")
  elif [ -d "$repo/$s" ]; then
    skill_dirs+=("$(cd "$repo/$s" && pwd)")
  else
    echo "run.sh: no skills folder at $s" >&2
    exit 1
  fi
done

if [ "$print_config" -eq 1 ]; then
  out="-"
else
  install="$(engine_dir)"
  # The config must live under the install: promptfoo resolves the Agent SDK
  # from the directory of the config it is handed, so a config anywhere else
  # cannot find node_modules.
  mkdir -p "$install/runs" "$PROMPTFOO_CONFIG_DIR"
  out="$install/runs/routing-$(date +%Y%m%d-%H%M%S)-$$.yaml"
fi

python3 - "$out" "$repo" "$setting_sources" "${#skill_dirs[@]}" \
  ${skill_dirs[@]+"${skill_dirs[@]}"} "${resolved[@]}" <<'PY'
import json, os, re, shutil, sys, tempfile

out, repo, sources = sys.argv[1], sys.argv[2], sys.argv[3]
n = int(sys.argv[4])
skill_roots = sys.argv[5:5 + n]
case_paths = sys.argv[5 + n:]

def fail(msg):
    print(f"run.sh: {msg}", file=sys.stderr)
    sys.exit(1)

files = []
for p in case_paths:
    if os.path.isdir(p):
        for dirpath, dirnames, names in os.walk(p):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(names):
                if name.endswith((".yaml", ".yml")) and not name.endswith((".config.yaml", ".config.yml")):
                    files.append(os.path.join(dirpath, name))
    else:
        files.append(p)
if not files:
    fail("no case files found in " + ", ".join(case_paths))
for f in files:
    text = open(f, encoding="utf-8").read()
    if re.search(r"^\s*-?\s*should_trigger:", text, re.M) or not re.search(r"^\s*assert:", text, re.M):
        fail(f"{f} is not in the case format (a promptfoo test list with vars.query and assert). "
             "See references/writing-cases.md in the harness-eval skill.")

working_dir = repo
if skill_roots:
    sandbox = tempfile.mkdtemp(prefix="harness-eval-sandbox.")
    target = os.path.join(sandbox, ".claude", "skills")
    os.makedirs(target)
    seen = {}
    ignore = shutil.ignore_patterns("node_modules", "runs", ".git")
    for root in skill_roots:
        for dirpath, dirnames, names in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if d not in ("node_modules", ".git"))
            if "SKILL.md" not in names:
                continue
            name = os.path.basename(dirpath)
            if name in seen:
                fail(f"two skills are named {name}: {seen[name]} and {dirpath}")
            seen[name] = dirpath
            shutil.copytree(dirpath, os.path.join(target, name), ignore=ignore)
            dirnames[:] = []
    if not seen:
        fail("no SKILL.md found under " + ", ".join(skill_roots))
    working_dir = sandbox
    print(f"run.sh: sandbox with {len(seen)} skills at {sandbox}", file=sys.stderr)

q = json.dumps
lines = [
    "# Generated by harness-eval's run.sh. Regenerated on every run; edit the cases, not this.",
    f"description: {q('routing: ' + ', '.join(os.path.basename(f) for f in files))}",
    "providers:",
    "  - id: anthropic:claude-agent-sdk",
    "    label: claude-code",
    "    config:",
    f"      working_dir: {q(working_dir)}",
    f"      setting_sources: {q([s.strip() for s in sources.split(',') if s.strip()])}",
    # Authenticate off the local Claude Code login when there is no API key.
    "      apiKeyRequired: false",
    # Skill first, and not optional: without it the agent cannot invoke a skill,
    # falls back to reading SKILL.md, every skill-used assertion becomes
    # unpassable and every not-skill-used passes for the wrong reason. The rest
    # are read-only so a case cannot edit the repository it is measuring.
    f"      append_allowed_tools: {q(['Skill', 'Read', 'Grep', 'Glob'])}",
    "prompts:",
    f"  - {q('{{query}}')}",
    "tests:",
] + [f"  - {q('file://' + f)}" for f in files]
text = "\n".join(lines) + "\n"
if out == "-":
    sys.stdout.write(text)
else:
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(text)
PY

[ "$print_config" -eq 1 ] && exit 0

echo "run.sh: config $out" >&2
echo "run.sh: results database $PROMPTFOO_CONFIG_DIR" >&2
cd "$install"
exec "$install/node_modules/.bin/promptfoo" eval -c "$out" ${passthrough[@]+"${passthrough[@]}"}

// The whiteboard's scratchpad home (SPEC §8.1): where every board's lock, port record, render, chat
// log and recipients live, when WHITEBOARD_HOME does not name it. scripts/whiteboard.sh resolves the
// same folder (main_checkout) and passes it as WHITEBOARD_HOME.
//
// [#71] It is the main checkout's `.scratchpad/whiteboard/`, whichever checkout the server serves:
// a repository keeps exactly one `.scratchpad/` (the scratchpad skill's `scratchpad.sh root`), and a
// board's lock only refuses a second server if both servers look in the same place.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The checkout that holds `start`: the first directory up from it with a `.git` (a directory in the
// main checkout, a file in a linked worktree).
export function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

// git's answer, or null when git is missing or the directory is not in a repository. Without the
// variables that locate a repository: one inherited from a git hook or `git rebase --exec` (GIT_DIR)
// would make both calls describe that repository, whatever `-C` names.
const GIT_ENV: NodeJS.ProcessEnv = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete GIT_ENV[k];
function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: GIT_ENV }).trim();
  } catch {
    return null;
  }
}

// The main checkout: the first entry `git worktree list` prints, trusted only once it is confirmed to
// be a working tree (a bare repository or `--separate-git-dir` names something that is not one). Any
// other answer falls back to the checkout that holds `start`. Mirrors `main_worktree_root()` in the
// scratchpad skill's `scripts/scratchpad.sh`. When git gives no answer from inside a linked worktree (its
// `.git` is a file), the fallback is that worktree's home, so it says so in one line.
export function mainCheckoutRoot(start: string): string {
  const listed = git(start, 'worktree', 'list', '--porcelain');
  const main = listed?.match(/^worktree (.+)$/m)?.[1];
  if (main && git(main, 'rev-parse', '--show-toplevel') === main) return main;
  const root = findRepoRoot(start);
  if (listed === null && fs.statSync(path.join(root, '.git'), { throwIfNoEntry: false })?.isFile()) {
    console.warn("[bridge] could not ask git for the main checkout; using this worktree's home, so a server from another checkout will not see this board's lock");
  }
  return root;
}

export const scratchpadHome = (start: string): string => path.join(mainCheckoutRoot(start), '.scratchpad', 'whiteboard');

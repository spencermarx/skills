#!/usr/bin/env node
// The publish step of the release workflow. Runs on every push to main that has no
// pending changesets, so it must be idempotent:
//   - tag v<version> if that tag does not exist yet, and push it;
//   - fast-forward the `stable` branch to the tagged commit.
// `npx skills add spencermarx/skills#stable` and the Codex `--ref stable` install
// track `stable`, so main can move ahead between releases without reaching users.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const plugin = JSON.parse(readFileSync(".claude-plugin/plugin.json", "utf8"));
const tag = `v${version}`;

if (plugin.version !== version) {
  console.error(`plugin.json is ${plugin.version} but package.json is ${version}; run npm run sync.`);
  process.exit(1);
}

const tagged = git("tag", "--list", tag) === tag;
if (tagged) {
  console.log(`${tag} already released; nothing to do.`);
  process.exit(0);
}

git("tag", "-a", tag, "-m", tag);
git("push", "origin", tag);
// Fails, rather than rewriting history, if stable has diverged from main.
git("push", "origin", `${tag}^{commit}:refs/heads/stable`);
console.log(`Released ${tag}; stable now points at it.`);
// changesets/action reads this line to report the release.
console.log(`New tag: ${tag}`);

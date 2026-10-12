// Tests setup-aclarify-skills' doctor.sh: setting OCR's default review team, and reporting it.
// Every case runs against tests/setup-aclarify-skills/fake-ocr.mjs, and again against the real
// ocr when it is installed, so the fake cannot drift from what `ocr team resolve` reports.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const doctor = join(root, "skills/core/setup-aclarify-skills/scripts/doctor.sh");
const stock = readFileSync(join(here, "setup-aclarify-skills/fixtures/stock-config.yaml"), "utf8");

const fakeBin = mkdtempSync(join(tmpdir(), "fake-ocr-"));
writeFileSync(join(fakeBin, "ocr"), `#!/bin/sh\nexec node "${join(here, "setup-aclarify-skills/fake-ocr.mjs")}" "$@"\n`);
chmodSync(join(fakeBin, "ocr"), 0o755);

const realOcr = spawnSync("sh", ["-c", "command -v ocr"], { encoding: "utf8" }).status === 0;
const backends = [
  { name: "fake ocr", PATH: `${fakeBin}:${process.env.PATH}`, fake: true },
  ...(realOcr ? [{ name: "real ocr", PATH: process.env.PATH, fake: false }] : []),
];

function repo(config = stock) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  mkdirSync(join(dir, ".ocr/skills/references/reviewers"), { recursive: true });
  writeFileSync(join(dir, ".ocr/skills/references/reviewers/architect.md"), "# Architect\n");
  writeFileSync(join(dir, ".ocr/config.yaml"), config);
  return dir;
}

const config = (dir) => readFileSync(join(dir, ".ocr/config.yaml"), "utf8");
// Everything outside the default_team block, which set-ocr-team must leave byte for byte.
const outsideTeam = (text) => text.replace(/^default_team:.*(?:\n(?:[ \t].*)?)*\n?/m, "");
const leftovers = (dir) => readdirSync(join(dir, ".ocr")).filter((f) => /\.(tmp|bak)\./.test(f));

// The pinned and named shapes come from the reproductions in round 1 of the PR #1 review.
const pinnedStockCounts = stock.replace(
  "  principal: 2    # Holistic architecture review\n",
  "  principal: { count: 2, model: claude-opus-4-7 }\n",
);
const namedForm3 = stock.replace(
  "  quality: 2      # Code quality and maintainability\n",
  "  quality:\n    - { model: claude-opus-4-7, name: q-deep }\n    - { model: claude-haiku-4-5, name: q-fast }\n",
);
const form3AtEnd =
  "other: 1\ndefault_team:\n  principal:\n    - { model: claude-opus-4-7 }\n    - { model: claude-sonnet-4-6, name: p-bal }\n  quality: 2";
const reworded =
  "default_team:\n  # Our rule: two reviewers max, principal plus architect.\n  principal: 1\n  architect: 1\nother: 1\n";

for (const ocr of backends) {
  describe(ocr.name, () => {
    const run = (dir, args, { cwd = dir, env = {} } = {}) =>
      spawnSync("bash", [doctor, ...args], { cwd, encoding: "utf8", env: { ...process.env, PATH: ocr.PATH, ...env } });
    const team = (dir) =>
      JSON.parse(spawnSync("ocr", ["team", "resolve", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: ocr.PATH } }).stdout)
        .map((r) => r.name)
        .sort();
    const teamLine = (dir, cwd = dir) => run(dir, [], { cwd }).stdout.split("\n").find((l) => / ocr-team /.test(l)) ?? "";

    test("stock team: check reports it as OCR's default and what the cap overrides; set-ocr-team replaces it", () => {
      const dir = repo();
      const line = teamLine(dir);
      assert.match(line, /^default /);
      assert.match(line, /overrides OCR's auto-added security and testing reviewers/);
      const r = run(dir, ["set-ocr-team"]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
      assert.match(config(dir), /TWO reviewers, always/);
      assert.match(config(dir), /SWAP it in rather than adding a third/);
      assert.equal(outsideTeam(config(dir)), outsideTeam(stock));
      if (ocr.fake) assert.ok(existsSync(join(dir, ".ocr/synced")), "reviewers-meta.json is re-synced");
      assert.deepEqual(leftovers(dir), []);
      assert.match(teamLine(dir), /^ok /);
    });

    test("set-ocr-team is idempotent", () => {
      const dir = repo();
      run(dir, ["set-ocr-team"]);
      const once = config(dir);
      const r = run(dir, ["set-ocr-team"]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /already/);
      assert.equal(config(dir), once);
    });

    for (const [what, text] of [
      ["another persona", stock.replace("  quality: 2 ", "  security: 1 ")],
      ["a pinned model on the stock counts", pinnedStockCounts],
      ["a Form 3 list with named, pinned instances", namedForm3],
      ["a Form 3 block at the end of the file", form3AtEnd],
      ["principal 1 + architect 1 under a reworded comment", reworded],
    ]) {
      test(`a custom team (${what}) is reported custom and left byte-identical without --force`, () => {
        const dir = repo(text);
        assert.match(teamLine(dir), /^custom /);
        const refused = run(dir, ["set-ocr-team"]);
        assert.equal(refused.status, 3, refused.stdout + refused.stderr);
        assert.equal(config(dir), text);
        assert.deepEqual(leftovers(dir), []);
        const forced = run(dir, ["set-ocr-team", "--force"]);
        assert.equal(forced.status, 0, forced.stderr);
        assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
        assert.equal(outsideTeam(config(dir)), outsideTeam(text));
      });
    }

    test("--force over an earlier copy and Form 3 instances leaves one comment and two reviewers", () => {
      const dir = repo(stock.replace("  principal: 2    # Holistic architecture review\n", "  principal:\n    - { model: a }\n    - { model: b, name: principal-b }\n    - { model: c }\n"));
      assert.equal(run(dir, ["set-ocr-team", "--force"]).status, 0);
      const first = config(dir);
      writeFileSync(join(dir, ".ocr/config.yaml"), first.replace("  architect: 1 ", "  architect: 2 "));
      assert.equal(run(dir, ["set-ocr-team", "--force"]).status, 0);
      assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
      assert.equal(config(dir), first, "the earlier comment is replaced, not kept beside the new one");
    });

    test("a reworded comment stays above the entries --force writes", () => {
      const dir = repo(reworded);
      assert.equal(run(dir, ["set-ocr-team", "--force"]).status, 0);
      const lines = config(dir).split("\n");
      assert.ok(lines.indexOf("  # Our rule: two reviewers max, principal plus architect.") < lines.findIndex((l) => /TWO reviewers, always/.test(l)));
    });

    for (const [what, text] of [
      ["a Form 3 list indented level with its key", "default_team:\n  # Form 1\n  principal: 2\n  quality:\n  - { model: claude-opus-4-7 }\n  - { name: q-fast }\n  # security: 1\nother: 1\n"],
      ["a Form 3 list under four-space keys", "default_team:\n    principal:\n        - { model: a }\n        - { model: b }\n    # keep me\n    quality: 2\n"],
      ["an inline mapping", "default_team: { principal: 2, quality: { count: 2, model: claude-haiku-4-5 } }\nother: 1\n"],
      ["an inline mapping over several lines", "default_team: {\n  principal: 2,\n  quality: 2 }\nother: 1\n"],
    ]) {
      test(`--force rewrites ${what} to the pair and keeps the other lines`, () => {
        const dir = repo(text);
        const r = run(dir, ["set-ocr-team", "--force"]);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
        assert.match(teamLine(dir), /^ok /);
        for (const kept of text.split("\n").filter((l) => /#|^other/.test(l))) assert.ok(config(dir).includes(kept), `kept: ${kept}`);
      });
    }

    test("an edit that does not resolve to the pair is rolled back", { skip: !ocr.fake && "needs the fake's FAKE_OCR_STUCK" }, () => {
      const dir = repo();
      const r = run(dir, ["set-ocr-team"], { env: { FAKE_OCR_STUCK: "1" } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /restored/);
      assert.equal(config(dir), stock);
      assert.deepEqual(leftovers(dir), []);
    });

    test("a symlinked config is written through, and stays a symlink", () => {
      const dir = repo();
      renameSync(join(dir, ".ocr/config.yaml"), join(dir, "shared-config.yaml"));
      symlinkSync("../shared-config.yaml", join(dir, ".ocr/config.yaml"));
      const r = run(dir, ["set-ocr-team"]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(lstatSync(join(dir, ".ocr/config.yaml")).isSymbolicLink());
      assert.match(readFileSync(join(dir, "shared-config.yaml"), "utf8"), /TWO reviewers, always/);
      assert.deepEqual(readdirSync(dir).filter((f) => /\.(tmp|bak)\./.test(f)), []);
    });

    test("run from a subdirectory, it works on the repository root", () => {
      const dir = repo();
      assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
      const sub = join(dir, "src/deep");
      mkdirSync(sub, { recursive: true });
      const check = run(dir, [], { cwd: sub }).stdout;
      assert.match(check, /^ok +ocr-init/m);
      assert.match(teamLine(dir, sub), /^default /);
      const r = run(dir, ["set-ocr-team"], { cwd: sub });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
      assert.ok(!existsSync(join(sub, ".ocr")), "nothing is created in the subdirectory");
    });
  });
}

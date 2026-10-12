// Tests setup-aclarify-skills' doctor.sh: setting OCR's default review team, and reporting it.
// Runs against tests/setup-aclarify-skills/fake-ocr.mjs, plus the real ocr when it is installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const fakePath = `${fakeBin}:${process.env.PATH}`;

function repo(config = stock) {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  mkdirSync(join(dir, ".ocr/skills/references/reviewers"), { recursive: true });
  writeFileSync(join(dir, ".ocr/skills/references/reviewers/architect.md"), "# Architect\n");
  writeFileSync(join(dir, ".ocr/config.yaml"), config);
  return dir;
}

const run = (dir, args, env = {}) =>
  spawnSync("bash", [doctor, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: fakePath, ...env } });
const config = (dir) => readFileSync(join(dir, ".ocr/config.yaml"), "utf8");
const team = (dir, PATH = fakePath) =>
  JSON.parse(spawnSync("ocr", ["team", "resolve", "--json"], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH } }).stdout)
    .map((r) => r.name)
    .sort();
// Everything outside the default_team block, which set-ocr-team must leave byte for byte.
const outsideTeam = (text) => text.replace(/^default_team:\n(?:(?:[ \t].*)?\n)*/m, "");
const teamLine = (dir) => run(dir, []).stdout.split("\n").find((l) => / ocr-team /.test(l)) ?? "";

test("stock team: check reports it outdated, set-ocr-team replaces it and keeps the rest", () => {
  const dir = repo();
  assert.match(teamLine(dir), /^outdated/);
  const r = run(dir, ["set-ocr-team"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
  assert.match(config(dir), /TWO reviewers, always/);
  assert.match(config(dir), /SWAP it in rather than adding a third/);
  assert.equal(outsideTeam(config(dir)), outsideTeam(stock));
  assert.ok(existsSync(join(dir, ".ocr/synced")), "reviewers-meta.json is re-synced");
  assert.match(teamLine(dir), /^ok/);
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

test("a customised team is left alone without --force, replaced with it", () => {
  const custom = stock.replace("  quality: 2 ", "  security: 1 ");
  const dir = repo(custom);
  assert.match(teamLine(dir), /^custom/);
  const refused = run(dir, ["set-ocr-team"]);
  assert.equal(refused.status, 3);
  assert.equal(config(dir), custom);
  const forced = run(dir, ["set-ocr-team", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
});

test("--force over an earlier copy and Form 3 instances leaves one comment and two reviewers", () => {
  const dir = repo(stock.replace("  principal: 2    # Holistic architecture review\n", "  principal:\n    - { model: a }\n    - { model: b, name: principal-b }\n    - { model: c }\n"));
  assert.equal(run(dir, ["set-ocr-team", "--force"]).status, 0);
  const first = config(dir);
  writeFileSync(join(dir, ".ocr/config.yaml"), first.replace("  architect: 1 ", "  architect: 2 "));
  assert.equal(run(dir, ["set-ocr-team", "--force"]).status, 0);
  assert.deepEqual(team(dir), ["architect-1", "principal-1"]);
  assert.equal(config(dir), first, "the earlier comment is replaced, not kept beside the new one");
});

test("an edit that does not resolve to the pair is rolled back", () => {
  const dir = repo();
  const r = run(dir, ["set-ocr-team"], { FAKE_OCR_STUCK: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /restored/);
  assert.equal(config(dir), stock);
});

const realOcr = spawnSync("sh", ["-c", "command -v ocr"], { encoding: "utf8" }).status === 0;

test("the real ocr resolves the team set-ocr-team writes", { skip: !realOcr && "ocr is not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-real-"));
  cpSync(join(root, ".ocr"), join(dir, ".ocr"), { recursive: true });
  writeFileSync(join(dir, ".ocr/config.yaml"), stock);
  const r = spawnSync("bash", [doctor, "set-ocr-team"], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(team(dir, process.env.PATH), ["architect-1", "principal-1"]);
});

// Guards arch-board's persist-final-message.py: it writes a subagent's PATH: final
// message into a board session, and refuses every write that could land elsewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(repo, "skills", "engineering", "arch-board", "scripts", "persist-final-message.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

const user = (text) => ({ type: "user", message: { content: [{ type: "text", text }] } });
const assistant = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const toolUse = () => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "x", input: {} }] } });

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "arch-board-test-")));
  const board = join(root, ".scratchpad", "arch-board", "20261012-120000-cache-design");
  mkdirSync(join(board, "round-1", "01-positions"), { recursive: true });
  return { root, board };
}

function run(root, rows, using = script) {
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return spawnSync("python3", [using, transcript], { encoding: "utf8" });
}

test("writes the final message body to the PATH inside a board session", { skip: !hasPython }, () => {
  const { root, board } = setup();
  try {
    const dest = join(board, "round-1", "01-positions", "fowler.md");
    const r = run(root, [
      user("go"),
      assistant(`PATH: ${dest}\n## What I examined\n`),
      assistant("KNOWN: the cache is per-tenant.\n"),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), dest);
    assert.equal(readFileSync(dest, "utf8"), "## What I examined\nKNOWN: the cache is per-tenant.\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reads only the turn after the last user row", { skip: !hasPython }, () => {
  const { root, board } = setup();
  try {
    const early = join(board, "round-1", "early.md");
    const dest = join(board, "round-1", "late.md");
    const r = run(root, [
      user("go"),
      assistant(`PATH: ${early}\nstale draft\n`),
      toolUse(),
      user("tool result"),
      assistant(`PATH: ${dest}\nfinal body\n`),
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!existsSync(early), "wrote from an earlier turn");
    assert.equal(readFileSync(dest, "utf8"), "final body\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const refusals = [
  ["a final message without a PATH line", (b) => "no path here\nbody\n", /PATH: line/],
  ["a relative PATH", () => "PATH: round-1/x.md\nbody\n", /not absolute/],
  ["a PATH outside any board session", (b, root) => `PATH: ${join(root, "elsewhere", "x.md")}\nbody\n`, /outside an existing arch-board/],
  ["a PATH under a board directory that does not exist", (b, root) => `PATH: ${join(root, ".scratchpad", "arch-board", "20261012-130000-missing", "x.md")}\nbody\n`, /outside an existing arch-board/],
  ["a PATH under an arch-board folder that is not a scratch entry", (b, root) => {
    mkdirSync(join(root, ".scratchpad", "arch-board", "notes"), { recursive: true });
    return `PATH: ${join(root, ".scratchpad", "arch-board", "notes", "x.md")}\nbody\n`;
  }, /outside an existing arch-board/],
  ["a PATH that climbs out of the board", (b, root) => `PATH: ${join(b, "..", "..", "..", "escaped.md")}\nbody\n`, /outside an existing arch-board/],
  ["a PATH with no body", (b) => `PATH: ${join(b, "round-1", "empty.md")}\n`, /no body/],
];

for (const [name, message, why] of refusals) {
  test(`refuses ${name}`, { skip: !hasPython }, () => {
    const { root, board } = setup();
    try {
      const r = run(root, [user("go"), assistant(message(board, root))]);
      assert.notEqual(r.status, 0, `accepted ${name}: ${r.stdout}`);
      assert.match(r.stderr, why);
      assert.ok(!existsSync(join(root, "elsewhere")) && !existsSync(join(root, "escaped.md")));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// An installed skill folder is itself named arch-board, so a PATH into it looks like a
// board path. Each case runs a copy of the script from a copy of the skill folder.
const intoSkill = [
  ["references/x.md", ["references", "x.md"]],
  ["scripts/x.sh", ["scripts", "x.sh"]],
  ["a nested references/deep/a/b.md", ["references", "deep", "a", "b.md"]],
  ["a folder named like a scratch entry", ["20261012-120000-planted", "x.md"]],
];

for (const [name, rel] of intoSkill) {
  test(`refuses a PATH into the skill's own folder: ${name}`, { skip: !hasPython }, () => {
    const { root } = setup();
    try {
      const skill = join(root, "installed", "arch-board");
      for (const d of ["scripts", "references", "20261012-120000-planted"]) mkdirSync(join(skill, d), { recursive: true });
      const copy = join(skill, "scripts", "persist-final-message.py");
      writeFileSync(copy, readFileSync(script));
      const dest = join(skill, ...rel);
      const r = run(root, [user("go"), assistant(`PATH: ${dest}\nplanted\n`)], copy);
      assert.notEqual(r.status, 0, `wrote into the skill folder: ${r.stdout}`);
      assert.match(r.stderr, /skill's own folder/);
      assert.ok(!existsSync(dest), `${dest} was created`);
      assert.ok(!existsSync(join(skill, "references", "deep")), "created directories inside the skill");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test("refuses to overwrite an existing board file", { skip: !hasPython }, () => {
  const { root, board } = setup();
  try {
    const dest = join(board, "round-1", "01-positions", "hickey.md");
    writeFileSync(dest, "original\n");
    const r = run(root, [user("go"), assistant(`PATH: ${dest}\nreplacement\n`)]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /overwrite/);
    assert.equal(readFileSync(dest, "utf8"), "original\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports a missing or malformed transcript", { skip: !hasPython }, () => {
  const { root } = setup();
  try {
    const missing = spawnSync("python3", [script, join(root, "nope.jsonl")], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /no such transcript/);
    const bad = join(root, "bad.jsonl");
    writeFileSync(bad, "{not json\n");
    const malformed = spawnSync("python3", [script, bad], { encoding: "utf8" });
    assert.notEqual(malformed.status, 0);
    assert.match(malformed.stderr, /not a JSONL transcript/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

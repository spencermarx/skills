// export-pdf.sh, the create-html-slides skill's PDF export, without downloading anything.
// A stand-in Playwright (tests/create-html-slides/fake-playwright) plays the runtime, and a
// stub npm plays the installer, so these run offline and in CI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "create-html-slides");
const script = join(here, "..", "..", "skills", "visual", "create-html-slides", "scripts", "export-pdf.sh");
const fake = join(here, "fake-playwright");

function setup({ installed = false, browser = true, slides = 3 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "html-slides-test-")));
  const runtime = join(root, "runtime");
  const log = join(root, "calls.jsonl");
  const deck = join(root, "deck", "talk.html");
  mkdirSync(dirname(deck), { recursive: true });
  writeFileSync(deck, "<!DOCTYPE html><section class=\"slide\"></section>");
  if (installed) cpSync(fake, join(runtime, "node_modules", "playwright"), { recursive: true });
  const env = {
    ...process.env,
    CREATE_HTML_SLIDES_RUNTIME: runtime,
    FAKE_PW_LOG: log,
    FAKE_PW_SLIDES: String(slides),
    ...(browser ? {} : { FAKE_PW_NO_BROWSER: "1" }),
  };
  delete env.XDG_CACHE_HOME;
  const sh = (...args) => spawnSync("bash", [script, ...args], { encoding: "utf8", env, cwd: root });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, runtime, deck, env, sh, calls };
}

test("arguments: missing, unknown and malformed ones exit 1 with a message", () => {
  const { sh, deck } = setup({ installed: true });
  assert.equal(sh().status, 1);
  let r = sh("--input");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--input needs a value/);
  r = sh("--input", deck, "--bogus", "x");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option: --bogus/);
  r = sh("--output", "x.pdf");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--input is required/);
  r = sh("--input", "nope.html");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /input file not found: nope\.html/);
  r = sh("--input", deck, "--width", "wide");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--width must be a positive whole number/);
  r = sh("--input", deck, "--output", "/no/such/dir/out.pdf");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /output folder does not exist/);
});

test("check: no runtime is exit 3 with both install commands, and installs nothing", () => {
  const { sh, runtime } = setup();
  const r = sh("check");
  assert.equal(r.status, 3, r.stderr);
  assert.ok(r.stdout.includes(`npm install --prefix "${runtime}" playwright@1`), r.stdout);
  assert.ok(r.stdout.includes(`"${runtime}/node_modules/.bin/playwright" install chromium`), r.stdout);
  assert.equal(existsSync(runtime), false, "check must not create the runtime");
});

test("check: the module without Chromium asks only for the browser download", () => {
  const { sh } = setup({ installed: true, browser: false });
  const r = sh("check");
  assert.equal(r.status, 3, r.stderr);
  assert.doesNotMatch(r.stdout, /npm install/);
  assert.match(r.stdout, /playwright" install chromium/);
});

test("check: a ready runtime is exit 0", () => {
  const { sh, runtime } = setup({ installed: true });
  const r = sh("check");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `ready: ${runtime}`);
});

test("export: no runtime is exit 3 with the commands, and never installs or writes a PDF", () => {
  const { sh, runtime, deck } = setup();
  const r = sh("--input", deck);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stdout, /install would run:/);
  assert.match(r.stdout, /npm install --prefix/);
  assert.equal(existsSync(runtime), false, "export must not install");
  assert.equal(existsSync(deck.replace(/\.html$/, ".pdf")), false);
});

test("export: defaults to DECK.pdf beside the deck, at 1920x1080, one shot per slide", () => {
  const { sh, deck, calls } = setup({ installed: true, slides: 4 });
  const r = sh("--input", "deck/talk.html");
  assert.equal(r.status, 0, r.stderr);
  const pdf = deck.replace(/\.html$/, ".pdf");
  assert.equal(readFileSync(pdf, "utf8"), "%PDF-fake");
  assert.match(r.stdout, new RegExp(`PDF exported to: ${pdf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const log = calls();
  assert.deepEqual(log.find((c) => c.call === "goto").args.url, `file://${deck}`);
  assert.deepEqual(log.find((c) => c.call === "setViewportSize").args, { width: 1920, height: 1080 });
  assert.equal(log.filter((c) => c.call === "screenshot").length, 4);
  assert.equal(log.find((c) => c.call === "setContent").args.pages, 4);
  assert.equal(log.find((c) => c.call === "pdf").args.path, pdf);
  assert.ok(log.some((c) => c.call === "close"), "the browser is closed");
  for (const shot of log.filter((c) => c.call === "screenshot")) {
    assert.equal(existsSync(shot.args.path), false, `screenshot left behind: ${shot.args.path}`);
  }
});

test("export: --output and a custom size are honoured", () => {
  const { sh, root, calls } = setup({ installed: true });
  const r = sh("--input", "deck/talk.html", "--output", "out.pdf", "--width", "1280", "--height", "720");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(root, "out.pdf")));
  const log = calls();
  assert.deepEqual(log.find((c) => c.call === "setViewportSize").args, { width: 1280, height: 720 });
  assert.equal(log.find((c) => c.call === "pdf").args.width, "1280px");
});

test("export: a deck with no slides fails and writes no PDF", () => {
  const { sh, deck, calls } = setup({ installed: true, slides: 0 });
  const r = sh("--input", deck);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No slides found/);
  assert.equal(existsSync(deck.replace(/\.html$/, ".pdf")), false);
  assert.ok(calls().some((c) => c.call === "close"), "the browser is closed on failure too");
});

test("install: runs the npm install, then the Chromium download, into the runtime", () => {
  const { root, runtime, env } = setup();
  const bin = join(root, "bin");
  mkdirSync(bin);
  const npmLog = join(root, "npm.log");
  // A stub npm that records its arguments and lays down the fake module plus a playwright CLI.
  writeFileSync(join(bin, "npm"), `#!/usr/bin/env bash
echo "npm $*" >> "${npmLog}"
prefix="$3"
mkdir -p "$prefix/node_modules/.bin"
cp -R "${fake}" "$prefix/node_modules/playwright"
printf '#!/usr/bin/env bash\\necho "playwright $*" >> "${npmLog}"\\n' > "$prefix/node_modules/.bin/playwright"
chmod +x "$prefix/node_modules/.bin/playwright"
`);
  chmodSync(join(bin, "npm"), 0o755);
  const r = spawnSync("bash", [script, "install"], { encoding: "utf8", env: { ...env, PATH: `${bin}:${env.PATH}` }, cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(npmLog, "utf8").trim().split("\n"), [
    `npm install --prefix ${runtime} playwright@1`,
    "playwright install chromium",
  ]);
  assert.equal(r.stdout.trim(), `installed: ${runtime}`);
  assert.ok(readdirSync(join(runtime, "node_modules")).includes("playwright"));
});

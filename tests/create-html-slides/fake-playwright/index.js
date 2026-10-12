// A stand-in for Playwright that drives no browser. It records each call as a JSON line in
// $FAKE_PW_LOG, reports $FAKE_PW_SLIDES slides, and writes placeholder files where the real
// one would write screenshots and the PDF. $FAKE_PW_NO_BROWSER makes Chromium "missing".
const { appendFileSync, writeFileSync } = require("fs");
const { join } = require("path");

const log = (call, args) => {
  if (process.env.FAKE_PW_LOG) appendFileSync(process.env.FAKE_PW_LOG, JSON.stringify({ call, args }) + "\n");
};

function page() {
  let evaluations = 0;
  return {
    setViewportSize: async (size) => log("setViewportSize", size),
    goto: async (url, opts) => log("goto", { url, ...opts }),
    waitForTimeout: async () => {},
    evaluate: async () => (evaluations++ === 0 ? Number(process.env.FAKE_PW_SLIDES ?? 3) : undefined),
    screenshot: async ({ path }) => { log("screenshot", { path }); writeFileSync(path, "png"); },
    setContent: async (html) => log("setContent", { pages: (html.match(/class="page"/g) || []).length }),
    pdf: async (opts) => { log("pdf", opts); writeFileSync(opts.path, "%PDF-fake"); },
  };
}

module.exports = {
  chromium: {
    executablePath: () => (process.env.FAKE_PW_NO_BROWSER ? join(__dirname, "no-such-browser") : __filename),
    launch: async (opts) => { log("launch", opts); return { newPage: async () => page(), close: async () => log("close") }; },
  },
};

// Screenshots every slide of a deck and assembles the shots into one PDF.
// Run by export-pdf.sh, which checks the runtime first; Playwright resolves from
// $PW_RUNTIME, not from this skill's folder or the repository.
// Usage: PW_RUNTIME=<dir> node capture.mjs <file:// url> <output.pdf> <width> <height>
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [inputUrl, outputPath, w, h] = process.argv.slice(2);
const width = Number.parseInt(w, 10);
const height = Number.parseInt(h, 10);
const { chromium } = createRequire(`${process.env.PW_RUNTIME}/`)("playwright");

// Two class conventions: `.slide` (this skill's template) and `.s` (older decks).
const SLIDES = ".slide";
const LEGACY_SLIDES = ".s";
const CHROME = ".prog, .progress-bar, .dots, .nav-dots";

const shots = mkdtempSync(join(tmpdir(), "html-slides-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setViewportSize({ width, height });
  await page.goto(inputUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const count = await page.evaluate(([a, b]) => {
    const legacy = document.querySelectorAll(b).length;
    return legacy > 0 ? legacy : document.querySelectorAll(a).length;
  }, [SLIDES, LEGACY_SLIDES]);
  if (!count) {
    console.error(`No slides found (looked for ${SLIDES} and ${LEGACY_SLIDES}).`);
    process.exitCode = 1;
  } else {
    console.error(`Found ${count} slides`);
    await page.evaluate((sel) => document.querySelectorAll(sel).forEach((el) => { el.style.display = "none"; }), CHROME);

    const images = [];
    for (let i = 0; i < count; i++) {
      await page.evaluate(([a, b, idx]) => {
        let slides = document.querySelectorAll(b);
        if (slides.length === 0) slides = document.querySelectorAll(a);
        slides[idx].scrollIntoView({ behavior: "instant" });
        slides[idx].classList.add("vis", "visible");
      }, [SLIDES, LEGACY_SLIDES, i]);
      await page.waitForTimeout(800);
      const path = join(shots, `slide-${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path, type: "png" });
      images.push(`data:image/png;base64,${readFileSync(path).toString("base64")}`);
      console.error(`  Captured slide ${i + 1}/${count}`);
    }

    const pdfPage = await browser.newPage();
    await pdfPage.setViewportSize({ width, height });
    await pdfPage.setContent(`<!DOCTYPE html>
<html><head><style>
  * { margin: 0; padding: 0; }
  @page { size: ${width}px ${height}px; margin: 0; }
  .page { width: ${width}px; height: ${height}px; page-break-after: always; overflow: hidden; }
  .page:last-child { page-break-after: auto; }
  .page img { width: 100%; height: 100%; object-fit: contain; }
</style></head><body>
  ${images.map((src) => `<div class="page"><img src="${src}" /></div>`).join("\n  ")}
</body></html>`, { waitUntil: "load" });
    await pdfPage.waitForTimeout(500);
    await pdfPage.pdf({
      path: outputPath,
      width: `${width}px`,
      height: `${height}px`,
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
    });
  }
} finally {
  await browser.close();
  rmSync(shots, { recursive: true, force: true });
}

// [render-cap] Test-only preload for Phases V and W of render-cap.test.ts. The suite loads it into the
// server's Node process through NODE_OPTIONS (`--import tsx --import <this file's URL>`); the server
// imports nothing from it. It arranges the render-canvas pages through the Playwright module the server
// itself imports (resolved from the server's working directory, its server/ folder, as index.ts does):
// - every page runs, at the start of each document, a script that blocks its main thread for
//   sessionStorage 'wbtest-block' ms, once, and reloads the page while the time is before sessionStorage
//   'wbtest-reload-until', so a blob can make the next document block, or make each document reload;
// - with WBTEST_NAV_ON_BOOT_VERIFY=1 in the environment, the launcher's verify of the boot launch's page
//   (its second evaluate of `() => true`, after the launch's own ready check) is preceded by that page
//   asking for its own reload and blocking its main thread 3 s, with the next document set to block 8 s,
//   so the verify meets the reload and asks the new document while it blocks. The preload logs
//   `[wbtest]` lines as it does so.
//
// The server's callback is matched as tsx compiles it, `()=>true`, with whitespace removed.

import { createRequire } from 'node:module';
import path from 'node:path';
import type { Browser, BrowserType, Page } from 'playwright';

const navOnBootVerify = process.env.WBTEST_NAV_ON_BOOT_VERIFY === '1';

const { chromium } = createRequire(path.join(process.cwd(), 'package.json'))('playwright') as typeof import('playwright');
const INIT = "{ const b = Number(sessionStorage.getItem('wbtest-block')); if (b > 0) { sessionStorage.removeItem('wbtest-block'); const end = Date.now() + b; while (Date.now() < end) {} } if (Number(sessionStorage.getItem('wbtest-reload-until')) > Date.now()) location.reload(); }";
const RELOAD = "sessionStorage.setItem('wbtest-block', '8000'); setTimeout(() => { location.reload(); const end = Date.now() + 3000; while (Date.now() < end) {} }, 0)";
const launch = chromium.launch.bind(chromium);
let launches = 0;
chromium.launch = async (...args: Parameters<BrowserType['launch']>): Promise<Browser> => {
  const b = await launch(...args);
  const n = ++launches;
  const newPage = b.newPage.bind(b);
  b.newPage = async (...a: Parameters<Browser['newPage']>): Promise<Page> => {
    const page = await newPage(...a);
    await page.addInitScript(INIT);
    if (navOnBootVerify && n === 1) {
      const evaluate = page.evaluate.bind(page) as unknown as (...a: unknown[]) => Promise<unknown>;
      let asks = 0;
      page.evaluate = (async (fn: unknown, ...rest: unknown[]) => {
        if (String(fn).replace(/\s/g, '') === '()=>true') {
          asks++;
          if (asks === 2) {
            await evaluate(RELOAD);
            await new Promise((r) => setTimeout(r, 300));
            console.log('[wbtest] the boot launch page reloads itself as the launcher verifies it');
          }
          if (asks === 3) console.log('[wbtest] the verify asks the new document, which blocks 8 s');
        }
        return evaluate(fn, ...rest);
      }) as Page['evaluate'];
    }
    return page;
  };
  return b;
};

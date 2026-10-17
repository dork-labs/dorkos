// Screenshot one screen in light and dark, headless.
// Usage: node shoot.cjs <url> <outDir> <name>
// Writes <name>.light.png, <name>.dark.png and <name>.json ({ ok, files, ms, error }).
//
// playwright-core and a Chromium are found by locate.cjs (VC_PLAYWRIGHT,
// VC_CHROME, Playwright's installed browsers, then a system Chrome).
const fs = require('fs');
const path = require('path');
const { findPlaywright, findChrome, PLAYWRIGHT_HELP, CHROME_HELP } = require('./locate.cjs');

async function shoot(url, outDir, name, opts = {}) {
  const started = Date.now();
  const status = path.join(outDir, name + '.json');
  fs.mkdirSync(outDir, { recursive: true });
  const pw = findPlaywright();
  if (!pw) {
    const res = { ok: false, error: PLAYWRIGHT_HELP, ms: 0 };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  }
  const executablePath = findChrome(pw);
  if (!executablePath) {
    const res = { ok: false, error: CHROME_HELP, ms: 0 };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  }
  let browser;
  const files = {};
  try {
    browser = await pw.chromium.launch({ executablePath, headless: true });
    const ctx = await browser.newContext({
      viewport: { width: opts.width || 1280, height: opts.height || 800 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    for (const theme of ['light', 'dark']) {
      const u = url + (url.includes('?') ? '&' : '?') + 'theme=' + theme;
      await page.goto(u, { waitUntil: 'load', timeout: 15000 });
      await page
        .waitForFunction(() => globalThis.__vcReady === true, null, { timeout: 5000 })
        .catch(() => {});
      const file = path.join(outDir, name + '.' + theme + '.png');
      await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
      files[theme] = file;
    }
    const res = { ok: true, files, ms: Date.now() - started };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  } catch (e) {
    const res = {
      ok: false,
      files,
      error: String(e && e.message ? e.message : e).split('\n')[0],
      ms: Date.now() - started,
    };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  const [url, outDir, name] = process.argv.slice(2);
  shoot(url, outDir, name).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  });
}

module.exports = { shoot, findPlaywright, findChrome };

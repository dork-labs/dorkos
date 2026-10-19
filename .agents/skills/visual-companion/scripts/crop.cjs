// Crop each note's element, in the state the note was made in, headless.
// Usage: node crop.cjs <jobs.json>
//   jobs: [{ url, frame?, selector, state?, viewport?, out }]
//   url    the page to load (a companion screen in shot mode, or a prototype)
//   frame  the url of the frame the note was made in, when the page hosts one
//   state  replayed with window.director.go(state) before the shot
// Writes <out> (a PNG with the element ringed and 24px of context around it) and
// <out minus .png>.json ({ ok, file, ms, error }). The review layer and director
// chrome stay out of the shot (window.__studioShot).
const fs = require('fs');
const path = require('path');
const { findPlaywright, findChrome, PLAYWRIGHT_HELP, CHROME_HELP } = require('./locate.cjs');

const PAD = 24;

// A note's page comes from a posted pin, so a crop only ever loads an http(s)
// page on this computer: never file://, and never another machine.
function isLocalPage(u) {
  try {
    const url = new URL(u);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

// The frame the note was made in. Its URL may carry the director's values in the
// query (?state=detail) that the fresh frame doesn't have yet, so match on the
// address without query or hash last; director.go() puts the state back after.
function frameFor(page, want) {
  if (!want) return page.mainFrame();
  const bare = (u) => String(u).replace(/#.*$/, '');
  const addr = (u) => String(u).replace(/[?#].*$/, '');
  return (
    page.frames().find((f) => f.url() === want) ||
    page.frames().find((f) => bare(f.url()) === bare(want)) ||
    page.frames().find((f) => f !== page.mainFrame() && addr(f.url()) === addr(want)) ||
    page.mainFrame()
  );
}

async function cropOne(browser, job) {
  const started = Date.now();
  const status = job.out.replace(/\.png$/, '.json');
  fs.mkdirSync(path.dirname(job.out), { recursive: true });
  if (!isLocalPage(job.url)) {
    const res = { ok: false, error: 'refused: crops only load local http(s) pages', ms: 0 };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  }
  const vp =
    job.viewport && job.viewport.w
      ? { width: job.viewport.w, height: job.viewport.h }
      : { width: 1280, height: 800 };
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
  try {
    await ctx.addInitScript(() => {
      window.__studioShot = true;
    });
    const page = await ctx.newPage();
    await page.goto(job.url, { waitUntil: 'load', timeout: 15000 });
    await page
      .waitForFunction(() => window.__vcReady === true || !window.__VC__, null, { timeout: 3000 })
      .catch(() => {});
    if (job.frame) await page.waitForTimeout(400); // a host page injects its adapter on the frame's load
    const fr = frameFor(page, job.frame);
    if (job.state && Object.keys(job.state).length) {
      const has = await fr
        .waitForFunction(() => !!(window.director && window.director.go), null, { timeout: 4000 })
        .then(
          () => true,
          () => false
        );
      if (has) {
        await fr.evaluate((s) => window.director.go(s), job.state);
        await page.waitForTimeout(700); // let the page settle into the state
      }
    }
    const el = fr.locator(job.selector).first();
    await el.waitFor({ state: 'visible', timeout: 4000 });
    await el.scrollIntoViewIfNeeded().catch(() => {});
    const b = await el.boundingBox();
    if (!b) throw new Error('element has no box');
    // Ring the element so the crop says which thing, not just where.
    await page.evaluate((r) => {
      const d = document.createElement('div');
      d.style.cssText = `position:fixed;left:${r.x - 3}px;top:${r.y - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border-radius:6px;box-shadow:0 0 0 2px #B54403,0 0 0 5px rgba(181,68,3,.18);pointer-events:none;z-index:2147483647`;
      document.documentElement.appendChild(d);
    }, b);
    const x = Math.max(0, b.x - PAD);
    const y = Math.max(0, b.y - PAD);
    const clip = {
      x,
      y,
      width: Math.min(vp.width - x, b.width + PAD * 2),
      height: Math.min(vp.height - y, b.height + PAD * 2),
    };
    await page.screenshot({ path: job.out, clip, animations: 'disabled' });
    const res = { ok: true, file: job.out, ms: Date.now() - started };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  } catch (e) {
    const res = {
      ok: false,
      error: String(e && e.message ? e.message : e).split('\n')[0],
      ms: Date.now() - started,
    };
    fs.writeFileSync(status, JSON.stringify(res) + '\n');
    return res;
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function crop(jobs) {
  const pw = findPlaywright();
  const executablePath = pw && findChrome(pw);
  if (!pw || !executablePath)
    return jobs.map(() => ({ ok: false, error: pw ? CHROME_HELP : PLAYWRIGHT_HELP }));
  const browser = await pw.chromium.launch({ executablePath, headless: true });
  try {
    const out = [];
    for (const j of jobs) out.push(await cropOne(browser, j));
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}

if (require.main === module) {
  const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  crop(jobs).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.every((x) => x.ok) ? 0 : 1);
  });
}

module.exports = { crop, isLocalPage };

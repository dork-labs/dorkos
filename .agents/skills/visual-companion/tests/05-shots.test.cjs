// Auto-screenshots: every new screen gets light and dark PNGs in shots/,
// including screens written straight into content/ without vc.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  project,
  vc,
  write,
  screen,
  OPTIONS,
  port,
  browser,
  waitFor,
  stopAll,
} = require('./lib.cjs');

const dirs = [];
let b;
test.before(async () => (b = await browser()));
test.after(async () => {
  stopAll(dirs);
  await b.close();
});

function pngSize(f) {
  const buf = fs.readFileSync(f);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function meanLuma(file) {
  const page = await b.newPage();
  const data = 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
  const v = await page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 200;
    c.height = 200;
    const x = c.getContext('2d');
    x.drawImage(img, 0, 0, 200, 200);
    const d = x.getImageData(0, 0, 200, 200).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4)
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4);
  }, data);
  await page.close();
  return v;
}

test('vc show returns light and dark screenshots of the new screen', async () => {
  const dir = project();
  dirs.push(dir);
  const t0 = Date.now();
  const r = vc(dir, [
    'show',
    write(dir, 'shot.html', screen('Shot me', OPTIONS)),
    '--port',
    String(port()),
  ]);
  const ms = Date.now() - t0;
  assert.ok(r.shots, 'shots: ' + r.shots_error);
  for (const t of ['light', 'dark']) {
    assert.ok(fs.existsSync(r.shots[t]));
    assert.equal(path.dirname(r.shots[t]), r.shots_dir);
    const { w, h } = pngSize(r.shots[t]);
    assert.equal(w, 1280);
    assert.ok(h >= 800);
  }
  const light = await meanLuma(r.shots.light);
  const dark = await meanLuma(r.shots.dark);
  assert.ok(light > 200 && dark < 40, `light ${light.toFixed(0)} / dark ${dark.toFixed(0)}`);
  assert.ok(ms < 10000, 'show with shots took ' + ms + 'ms');
});

test('a screen written straight into content/ is shot too, without chrome', async () => {
  const dir = project();
  dirs.push(dir);
  const r = vc(dir, ['start', '--port', String(port())]);
  fs.writeFileSync(path.join(r.screen_dir, 'direct.html'), screen('Written directly'));
  const f = path.join(r.shots_dir, 'direct.json');
  await waitFor(() => fs.existsSync(f), 15000);
  const status = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(status.ok, true);
  assert.ok(fs.existsSync(status.files.light) && fs.existsSync(status.files.dark));
  // Shot mode hides the chrome.
  const page = await b.newPage();
  await page.goto(r.url + '?shot&screen=direct');
  assert.equal(await page.locator('.vc-bar').count(), 0);
  await page.close();
});

test('shots are full-page for long screens', async () => {
  const dir = project();
  dirs.push(dir);
  const tall = screen('Tall', '<div style="height:2400px" class="placeholder">tall</div>');
  const r = vc(dir, ['show', write(dir, 'tall.html', tall), '--port', String(port())]);
  assert.ok(pngSize(r.shots.light).h > 2400);
});

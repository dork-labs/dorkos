import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserManager } from '../manager.mjs';
import { loadPlaywright } from '../runtime.mjs';

const runtime = await loadPlaywright({
  repoRoot: fileURLToPath(new URL('../../../', import.meta.url)),
});

async function resources(t, prefix) {
  const cleanups = [];
  t.after(async () => {
    const errors = [];
    for (const close of cleanups.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Caret test cleanup failed');
  });
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, own: (close) => cleanups.push(close) };
}

test('manager capture preserves the native caret screenshot option', async (t) => {
  // Public screenshot defaults hide the caret; an omitted option reproduces the demo bug.
  const { root, own } = await resources(t, 'manager-caret-option-');
  const manager = new BrowserManager({
    profilesDir: root,
    runtime,
    fixtureOrigin: 'http://127.0.0.1:4241',
  });
  own(() => manager.shutdown());
  let options;
  const tab = {
    browserId: 'caret-browser',
    tabId: 'caret-tab',
    navigationGeneration: 1,
    viewportVersion: 1,
    viewport: { width: 1280, height: 720 },
    pendingCaptures: 0,
    captureSequence: 0,
    captureTail: Promise.resolve(),
    page: {
      async screenshot(value) {
        options = value;
        return Buffer.from('fixture-capture');
      },
    },
  };
  manager.requireTab = () => tab;
  await manager.capture(tab.tabId);
  assert.equal(options.caret, 'initial');
});

test(
  'focused fixture native caret appears in manager pixels and disappears in hidden variant',
  { timeout: 15000 },
  async (t) => {
    // Color only identifies Chromium's native caret; no DOM/canvas caret is synthesized.
    const { root, own } = await resources(t, 'manager-caret-pixels-');
    const server = createServer((_, response) =>
      response.end(
        '<!doctype html><style>body{margin:20px;background:white}input{font:40px monospace;width:300px;height:80px;padding:10px;border:0;outline:0;color:black;background:white;caret-color:rgb(255,0,255)}</style><input id="caret" aria-label="Caret fixture">'
      )
    );
    own(() => new Promise((resolve) => server.close(resolve)));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const manager = new BrowserManager({
      profilesDir: root,
      runtime,
      fixtureOrigin: `http://127.0.0.1:${server.address().port}`,
    });
    own(() => manager.shutdown());
    const browser = await manager.openClean();
    const tab = manager.getTab(browser.tabIds[0]);
    await tab.page.goto(manager.fixtureOrigin);
    const input = tab.page.locator('#caret');
    const box = await input.boundingBox();
    assert.ok(box);
    async function caretPixels(bytes) {
      return tab.page.evaluate(
        async ({ encoded, box }) => {
          const raw = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
          const bitmap = await globalThis.createImageBitmap(
            new Blob([raw], { type: 'image/jpeg' })
          );
          const canvas = globalThis.document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const context = canvas.getContext('2d');
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const data = context.getImageData(
            Math.floor(box.x),
            Math.floor(box.y),
            Math.floor(box.width),
            Math.floor(box.height)
          ).data;
          let count = 0;
          for (let i = 0; i < data.length; i += 4)
            if (
              data[i] > 130 &&
              data[i + 2] > 130 &&
              data[i] > data[i + 1] + 40 &&
              data[i + 2] > data[i + 1] + 40
            )
              count++;
          return count;
        },
        { encoded: bytes.toString('base64'), box }
      );
    }
    await input.focus();
    const hidden = await tab.page.screenshot({
      type: 'jpeg',
      quality: 70,
      animations: 'disabled',
      caret: 'hide',
    });
    assert.equal(
      await caretPixels(hidden),
      0,
      'hidden native caret is the zero-pixel negative control'
    );
    let visible,
      count = 0,
      samples = 0;
    // Refocusing resets the native blink cycle; still bound retries for platform timing variability.
    for (; samples < 8 && count < 10; samples++) {
      await input.evaluate((node) => {
        node.blur();
        node.focus();
      });
      visible = (await manager.capture(tab.tabId)).bytes;
      count = await caretPixels(visible);
    }
    assert.ok(count >= 10, `native caret pixels observed: ${count} across ${samples} samples`);
    assert.equal(
      await input.evaluate(
        (node) =>
          node === globalThis.document.activeElement &&
          node.selectionStart === 0 &&
          node.selectionEnd === 0
      ),
      true
    );
    const artifacts = await mkdtemp(join(tmpdir(), 'manager-caret-evidence-'));
    await writeFile(join(artifacts, 'native-caret.jpg'), visible, { mode: 0o600 });
    await writeFile(join(artifacts, 'hidden-caret.jpg'), hidden, { mode: 0o600 });
    await writeFile(
      join(artifacts, 'observation.json'),
      JSON.stringify({
        samples,
        nativeCaretPixels: count,
        hiddenCaretPixels: 0,
        nativeBlink: 'reset by refocus; never overlaid',
        runtime: { ...runtime.receipt, executablePath: '[local-only]' },
      }),
      { mode: 0o600 }
    );
    t.diagnostic(`Caret artifact directory: ${artifacts}`);
  }
);

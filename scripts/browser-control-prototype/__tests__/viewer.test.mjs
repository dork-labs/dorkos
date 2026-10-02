import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { setupViewer as setup } from './viewer-test-setup.mjs';
async function pixels(page) {
  return page.locator('#screen').evaluate(async (canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (n) =>
      n.toString(16).padStart(2, '0')
    ).join('');
  });
}
async function expected(page, bytes) {
  return page.evaluate(async (base64) => {
    const data = Uint8Array.from(atob(base64), (x) => x.charCodeAt(0));
    const bitmap = await globalThis.createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), (n) =>
      n.toString(16).padStart(2, '0')
    ).join('');
  }, bytes.toString('base64'));
}

test('two actual viewers render canonical pixels, drive input and disconnect without stopping browser', async (t) => {
  const s = await setup(t);
  const a = await s.open(s.human);
  const b = await s.open(s.observer);
  // Freeze a single frame so an independent decode can compare every canonical pixel.
  await s.viewer.pauseCapture(s.tab.tabId);
  const captured = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  await s.viewer.publish(s.tab.tabId, captured);
  await a.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    captured.receipt.captureSequence
  );
  await b.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    captured.receipt.captureSequence
  );
  assert.equal(await s.tab.page.locator('#marker').textContent(), 'CANONICAL-A');
  const independent = await s.tab.page.screenshot({
    type: 'jpeg',
    quality: 70,
    animations: 'disabled',
    caret: 'initial',
  });
  assert.deepEqual(await pixels(a), await expected(a, independent));
  assert.deepEqual(await pixels(b), await expected(b, independent));
  assert.ok(s.viewer.stats().rendered >= 2);
  await a.getByRole('button', { name: 'Take control' }).click();
  await a.waitForFunction(
    () =>
      globalThis.viewer.controlState()?.status === 'ready' &&
      globalThis.viewer.controlState()?.controllerId === 'human-a'
  );
  await s.viewer.resumeCapture(s.tab.tabId);
  await a.setViewportSize({ width: 420, height: 900 });
  assert.deepEqual(s.manager.getTab(s.tab.tabId).viewport, { width: 1280, height: 720 });
  assert.equal(s.manager.getTab(s.tab.tabId).viewportVersion, 1);
  const increment = await s.tab.page.locator('#increment').boundingBox();
  const rect = await a.locator('#screen').boundingBox();
  await a.mouse.click(
    rect.x + ((increment.x + increment.width / 2) * rect.width) / 1280,
    rect.y + ((increment.y + increment.height / 2) * rect.height) / 720
  );
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#revision').textContent === '1'
  );
  await s.viewer.pauseCapture(s.tab.tabId);
  const changed = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  s.viewer.publish(s.tab.tabId, changed);
  await a.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    changed.receipt.captureSequence
  );
  await b.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    changed.receipt.captureSequence
  );
  const revisionOne = await s.tab.page.screenshot({
    type: 'jpeg',
    quality: 70,
    animations: 'disabled',
    caret: 'initial',
  });
  assert.equal(await pixels(a), await expected(a, revisionOne));
  assert.equal(await pixels(b), await expected(b, revisionOne));
  assert.equal(
    await a.evaluate(
      () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth
    ),
    true
  );
  const artifactDir = resolve(
    new URL('../../../.temp/browser-control-prototype/', import.meta.url).pathname
  );
  await mkdir(artifactDir, { recursive: true });
  await a.screenshot({ path: join(artifactDir, 'viewer-mobile.png'), fullPage: true });
  await b.screenshot({ path: join(artifactDir, 'viewer-desktop.png'), fullPage: true });
  s.viewer.resumeCapture(s.tab.tabId);
  await a.evaluate(() => globalThis.viewer.disconnect());
  await b.evaluate(() => globalThis.viewer.disconnect());
  assert.equal(s.viewer.stats().viewers, 0);
  await assert.rejects(
    () => a.evaluate(() => globalThis.viewer.send({ type: 'click', x: 2, y: 3 })),
    /current connected view/
  );
  const captures = s.viewer.stats().captures;
  await s.tab.page.evaluate(() => globalThis.fixture.increment());
  assert.equal(await s.tab.page.locator('#revision').textContent(), '2');
  await a.close();
  await b.close();
  assert.equal(s.manager.getTab(s.tab.tabId).browserId, s.tab.browserId);
  const reopened = await s.open(s.human);
  assert.equal((await reopened.evaluate(() => globalThis.viewer.current())).tabId, s.tab.tabId);
  assert.ok(s.viewer.stats().captures > captures);
});

test('real viewer transport refuses origin/token/observer/stale viewport and wrong tab captures', async (t) => {
  const s = await setup(t);
  const observer = await s.open(s.observer);
  const auth = {
    Origin: s.viewer.url,
    Authorization: `Bearer ${s.human}`,
    'Content-Type': 'application/json',
  };
  for (const headers of [
    { ...auth, Origin: 'http://evil.test' },
    { ...auth, Authorization: 'Bearer invalid' },
  ])
    assert.equal(
      (
        await fetch(s.viewer.url + '/subscribe', {
          method: 'POST',
          headers,
          body: JSON.stringify({ tabId: s.tab.tabId }),
        })
      ).status,
      403
    );
  const request = {
    requestId: 'observer-act',
    tabId: s.tab.tabId,
    navigationGeneration: s.tab.navigationGeneration,
    viewportVersion: 1,
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
    action: { type: 'click', x: 1, y: 1 },
  };
  assert.equal(
    (
      await fetch(s.viewer.url + '/actions', {
        method: 'POST',
        headers: { ...auth, Authorization: `Bearer ${s.observer}` },
        body: JSON.stringify(request),
      })
    ).status,
    403
  );
  const human = await s.open(s.human);
  await human.getByRole('button', { name: 'Take control' }).click();
  await human.waitForFunction(
    () =>
      globalThis.viewer.controlState()?.status === 'ready' &&
      globalThis.viewer.controlState()?.controllerId === 'human-a'
  );
  await s.manager.resize(s.tab.tabId, { width: 1200, height: 700 });
  request.epoch = s.viewer.control.state(s.tab.tabId).epoch;
  request.requestId = 'stale-view';
  const stale = await fetch(s.viewer.url + '/actions', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(request),
  });
  assert.equal((await stale.json()).outcome, 'rejected');
  await s.viewer.pauseCapture(s.tab.tabId);
  const capture = await s.manager.capture(s.tab.tabId);
  assert.throws(
    () =>
      s.viewer.publish(s.tab.tabId, {
        ...capture,
        receipt: { ...capture.receipt, tabId: 'wrong-page' },
      }),
    /frame-identity/
  );
  assert.equal(s.viewer.stats().wrongFrames, 1);
  assert.ok(await observer.locator('#screen').evaluate((c) => c.width > 0));
});

async function viewerPoint(page, tab, selector) {
  const target = await tab.page.locator(selector).boundingBox();
  const screen = await page.locator('#screen').boundingBox();
  const frame = await page.evaluate(() => globalThis.viewer.current());
  return {
    x: screen.x + ((target.x + target.width / 2) * screen.width) / frame.width,
    y: screen.y + ((target.y + target.height / 2) * screen.height) / frame.height,
  };
}

test('actual viewer events drive keyboard, text, chords, drag and wheel with synthetic composition and clipboard', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  await page.getByRole('button', { name: 'Take control' }).click();
  await page.waitForFunction(
    () =>
      globalThis.viewer.controlState()?.status === 'ready' &&
      globalThis.viewer.controlState()?.controllerId === 'human-a'
  );
  const chrome = await page.locator('body').ariaSnapshot();
  assert.ok(chrome.includes('button "Take control"'));
  assert.equal(
    await page.getByRole('textbox', { name: 'Text sent to the focused page field' }).count(),
    1
  );
  await page.getByRole('button', { name: 'Read page structure' }).click();

  await page.waitForFunction(() =>
    globalThis.document.querySelector('#snapshot').textContent.includes('Increment')
  );
  await page.getByRole('button', { name: 'Next page control' }).click();
  await page.waitForFunction(() =>
    globalThis.document.querySelector('#focused').textContent.includes('Increment')
  );
  await page.getByRole('button', { name: 'Activate focused control' }).click();
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#revision').textContent === '1'
  );
  const input = await viewerPoint(page, s.tab, '#text');
  await page.mouse.click(input.x, input.y);
  const local = page.getByRole('textbox', { name: 'Text sent to the focused page field' });
  await local.pressSequentially('Ab😀');
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#text').value === 'Ab😀'
  );
  await local.evaluate((node) => {
    for (const [type, data] of [
      ['compositionstart', ''],
      ['compositionupdate', '漢字'],
      ['compositionend', '漢字'],
    ])
      node.dispatchEvent(new globalThis.CompositionEvent(type, { data, bubbles: true }));
  });
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#text').value === 'Ab😀漢字'
  );
  await s.tab.page.waitForFunction(() =>
    globalThis.fixture.inputEvents.some((event) => event.type === 'compositionend')
  );
  assert.ok(
    (await s.tab.page.evaluate(() => globalThis.fixture.inputEvents)).some(
      (event) => event.type === 'compositionend'
    )
  );
  await page.locator('#screen').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#text').selectionEnd === 6
  );
  await page.getByRole('button', { name: 'Copy selected page text' }).click();
  await page.waitForFunction(
    () => globalThis.document.querySelector('#clipboard').textContent === 'Selection copied'
  );
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Ab😀漢字');
  await page.evaluate(() => globalThis.fixtureClipboard.seed('pasted-😀'));
  await page.getByRole('button', { name: 'Paste clipboard into page' }).click();
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#text').value === 'pasted-😀'
  );
  await page.evaluate(() => globalThis.fixtureClipboard.deny(true));
  await page.getByRole('button', { name: 'Paste clipboard into page' }).click();
  await page.waitForFunction(
    () => globalThis.document.querySelector('#clipboard').textContent.includes('denied'),
    null,
    { timeout: 3000 }
  );
  const drag = await viewerPoint(page, s.tab, '#drag');
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + 20, drag.y + 10, { steps: 2 });
  await page.mouse.up();
  await s.tab.page.waitForFunction(
    () => globalThis.fixture.inputState().dragMoves > 0 && !globalThis.fixture.inputState().dragging
  );
  await s.tab.page.locator('#scroll').scrollIntoViewIfNeeded();
  const scroll = await viewerPoint(page, s.tab, '#scroll');
  await page.mouse.move(scroll.x, scroll.y);
  await page.mouse.wheel(0, 80);
  await s.tab.page.waitForFunction(
    () => globalThis.document.querySelector('#scroll').scrollTop > 0
  );
  const before = await s.tab.page.locator('#scroll').evaluate((node) => node.scrollTop);
  await page.locator('#screen').evaluate((canvas, p) => {
    for (const [type, y] of [
      ['pointerdown', p.y],
      ['pointermove', p.y - 30],
      ['pointerup', p.y - 30],
    ])
      canvas.dispatchEvent(
        new globalThis.PointerEvent(type, {
          pointerId: 10,
          pointerType: 'touch',
          clientX: p.x,
          clientY: y,
          bubbles: true,
        })
      );
  }, scroll);
  await s.tab.page.waitForFunction(
    (before) => globalThis.document.querySelector('#scroll').scrollTop > before,
    before
  );
  assert.ok(s.viewer.stats().rendered > 3);
});

test('wrong Page pixels fail the named canonical marker assertion despite matching receipt metadata', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.observer);
  await s.viewer.pauseCapture(s.tab.tabId);
  assert.equal(await s.tab.page.locator('#marker').textContent(), 'CANONICAL-A');
  assert.equal(await s.tab.page.locator('#revision').textContent(), '0');
  const canonical = await s.tab.page.screenshot({
    type: 'jpeg',
    quality: 70,
    animations: 'disabled',
    caret: 'initial',
  });
  const wrongPage = await s.tab.page.context().newPage();
  await wrongPage.goto(s.fixture.url + '/?marker=WRONG-PAGE-B');
  assert.equal(await wrongPage.locator('#marker').textContent(), 'WRONG-PAGE-B');
  const wrongBytes = await wrongPage.screenshot({
    type: 'jpeg',
    quality: 70,
    animations: 'disabled',
    caret: 'initial',
  });
  const capture = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  s.viewer.publish(s.tab.tabId, {
    receipt: { ...capture.receipt, byteLength: wrongBytes.length },
    bytes: wrongBytes,
  });
  await page.waitForFunction(
    (sequence) => globalThis.viewer.current()?.captureSequence === sequence,
    capture.receipt.captureSequence
  );
  const actual = await pixels(page),
    canonicalHash = await expected(page, canonical),
    wrongHash = await expected(page, wrongBytes);
  assert.equal(actual, wrongHash, 'negative control must actually render the wrong named Page');
  assert.throws(
    () => assert.equal(actual, canonicalHash),
    assert.AssertionError,
    'canonical pixel assertion must detect substituted bytes'
  );
  const repaired = await s.manager.capture(s.tab.tabId, {
    epoch: s.viewer.control.state(s.tab.tabId).epoch,
  });
  s.viewer.publish(s.tab.tabId, repaired);
  await page.waitForFunction(
    (sequence) => globalThis.viewer.current()?.captureSequence === sequence,
    repaired.receipt.captureSequence
  );
  assert.equal(await pixels(page), canonicalHash);
});

test('one unacknowledged viewer has one bounded pending frame while another renders', async (t) => {
  const s = await setup(t);
  const fast = await s.open(s.observer);
  const headers = {
    Origin: s.viewer.url,
    Authorization: `Bearer ${s.human}`,
    'Content-Type': 'application/json',
  };
  const slow = await (
    await fetch(s.viewer.url + '/subscribe', {
      method: 'POST',
      headers,
      body: JSON.stringify({ tabId: s.tab.tabId }),
    })
  ).json();
  const response = await fetch(s.viewer.url + '/frame', {
    method: 'POST',
    headers,
    body: JSON.stringify({ viewerId: slow.viewerId }),
  });
  const receipt = JSON.parse(response.headers.get('x-frame-receipt'));
  await response.arrayBuffer();
  const before = await fast.evaluate(() => globalThis.viewer.current().captureSequence);
  await fast.waitForFunction(
    (before) => globalThis.viewer.current().captureSequence >= before + 5,
    before
  );
  assert.ok(s.viewer.stats().dropped > 0);
  assert.ok(s.viewer.stats().maxPendingBytes <= 2 * 1024 * 1024);
  assert.ok(s.viewer.stats().maxWritableBytes <= 2 * 1024 * 1024);
  assert.ok(s.viewer.stats().pendingFrames <= 2);
  assert.deepEqual(
    s.viewer.stats().viewerStates.find((v) => v.viewerId === slow.viewerId).pendingFrames,
    1
  );
  const badAck = await fetch(s.viewer.url + '/ack', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      viewerId: slow.viewerId,
      receipt: { ...receipt, captureSequence: receipt.captureSequence + 1 },
    }),
  });
  assert.equal(badAck.status, 403);
  const goodAck = await fetch(s.viewer.url + '/ack', {
    method: 'POST',
    headers,
    body: JSON.stringify({ viewerId: slow.viewerId, receipt }),
  });
  assert.equal(goodAck.status, 200);
  const fresh = await fetch(s.viewer.url + '/frame', {
    method: 'POST',
    headers,
    body: JSON.stringify({ viewerId: slow.viewerId }),
  });
  assert.ok(
    JSON.parse(fresh.headers.get('x-frame-receipt')).captureSequence > receipt.captureSequence
  );
  await fresh.arrayBuffer();
  await fetch(s.viewer.url + '/unsubscribe', {
    method: 'POST',
    headers,
    body: JSON.stringify({ viewerId: slow.viewerId }),
  });
  await s.viewer.pauseCapture(s.tab.tabId);
  const capture = await s.manager.capture(s.tab.tabId);
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  assert.throws(
    () =>
      s.viewer.publish(s.tab.tabId, {
        receipt: { ...capture.receipt, byteLength: bytes.length },
        bytes,
      }),
    /frame-size/
  );
  assert.equal(s.viewer.stats().oversizedFrames, 1);
});

test('actual pointer cancel and lost capture release the held button on the canonical Page', async (t) => {
  const s = await setup(t);
  const page = await s.open(s.human);
  const previousEpoch = (await page.evaluate(() => globalThis.viewer.controlState())).epoch;
  await page.route('**/control', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.getByRole('button', { name: 'Take control' }).click();
  await page.waitForFunction((epoch) => {
    const state = globalThis.viewer.controlState();
    return state?.status === 'ready' && state.controllerId === 'human-a' && state.epoch > epoch;
  }, previousEpoch);
  for (const cancel of ['pointercancel', 'lostpointercapture']) {
    await page.locator('#screen').scrollIntoViewIfNeeded();
    const point = await viewerPoint(page, s.tab, '#drag');
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await s.tab.page.waitForFunction(() => globalThis.fixture.inputState().dragging);
    if (cancel === 'pointercancel')
      await page
        .locator('#screen')
        .dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
    else {
      await page.mouse.move(point.x + 1, point.y);
      await page.locator('#screen').evaluate((canvas) => canvas.releasePointerCapture(1));
      await page.mouse.move(point.x + 2, point.y);
    }
    await s.tab.page.waitForFunction(() => !globalThis.fixture.inputState().dragging);
    await page.mouse.up();
    assert.equal(
      (await s.tab.page.evaluate(() => globalThis.fixture.inputState())).dragging,
      false
    );
  }
});

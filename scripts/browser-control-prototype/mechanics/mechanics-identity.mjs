import assert from 'node:assert/strict';
import { center, delay, distribution, assertObservation } from './mechanics-helpers.mjs';
import { assertCanonical } from './mechanics-pixels.mjs';
export async function probeIdentity(s) {
  let samples = 0;
  const first = await s.open(),
    second = await s.open();
  await s.viewer.pauseCapture(s.tab.tabId);
  const frame = await s.manager.capture(s.tab.tabId, { epoch: s.control.state(s.tab.tabId).epoch });
  await s.viewer.publish(s.tab.tabId, frame);
  for (const view of [first, second]) {
    await view.waitForFunction(
      (seq) => globalThis.viewer.current()?.captureSequence === seq,
      frame.receipt.captureSequence
    );
    await assertCanonical(view, s.tab);
    samples++;
  }
  // Prove a changed revision in both still-subscribed viewers, independently of supplied bytes.
  assert.equal(await s.tab.page.locator('#revision').textContent(), '0');
  assert.equal(
    (await s.submit(s.agent, { type: 'click', ...(await center(s.tab.page, '#increment')) }))
      .outcome,
    'completed'
  );
  assert.equal(await s.tab.page.locator('#revision').textContent(), '1');
  samples++;
  const changed = await s.manager.capture(s.tab.tabId, {
    epoch: s.control.state(s.tab.tabId).epoch,
  });
  await s.viewer.publish(s.tab.tabId, changed);
  for (const view of [first, second]) {
    await view.waitForFunction(
      (seq) => globalThis.viewer.current()?.captureSequence === seq,
      changed.receipt.captureSequence
    );
    await assertCanonical(view, s.tab);
    samples++;
  }
  assert.equal(s.viewer.stats().viewers, 2);
  const id = s.tab.tabId;
  await s.submit(s.agent, { type: 'navigate', url: s.fixture.url + '/?marker=NAVIGATED-A' });
  assert.equal(s.manager.getTab(id).tabId, id);
  assert.equal(await s.tab.page.locator('#marker').textContent(), 'NAVIGATED-A');
  const original = s.manager.getTab(id);
  await s.submit(s.agent, { type: 'click', ...(await center(s.tab.page, '#popup')) });
  for (let i = 0; i < 40 && s.manager.listTabs(s.browser.browserId).length < 2; i++)
    await delay(25);
  const popup = s.manager.listTabs(s.browser.browserId).find((tab) => tab.tabId !== id);
  assert.ok(popup);
  const popupPage = s.manager.getTab(popup.tabId).page;
  await popupPage.waitForLoadState();
  assert.equal(await popupPage.locator('#marker').textContent(), 'popup-B');
  await s.submit(s.agent, { type: 'click', ...(await center(s.tab.page, '#increment')) });
  assert.equal(await s.tab.page.locator('#revision').textContent(), '1');
  assert.equal(await popupPage.locator('#revision').textContent(), '0');
  samples++;
  for (const view of [first, second])
    await view.getByRole('button', { name: 'Close view' }).click();
  assert.equal(s.viewer.stats().viewers, 0);
  for (let i = 0; i < 7; i++) {
    assert.equal(
      (await s.submit(s.agent, { type: 'click', ...(await center(s.tab.page, '#increment')) }))
        .outcome,
      'completed'
    );
    samples++;
  }
  assert.equal(await s.tab.page.locator('#revision').textContent(), '8');
  await s.viewer.resumeCapture(id);
  const reopened = await s.open();
  assert.equal((await reopened.evaluate(() => globalThis.viewer.current())).tabId, id);
  await s.viewer.pauseCapture(id);
  const final = await s.manager.capture(id, { epoch: s.control.state(id).epoch });
  await s.viewer.publish(id, final);
  await reopened.waitForFunction(
    (seq) => globalThis.viewer.current()?.captureSequence === seq,
    final.receipt.captureSequence
  );
  await assertCanonical(reopened, s.manager.getTab(id));
  samples++;
  assert.ok(original.navigationGeneration > 1);
  const popupToken = s.control.issueParticipant({
    actorId: 'popup-agent',
    kind: 'agent',
    tabIds: [popup.tabId],
    canControl: true,
  });
  await s.control.acquire(popupToken, popup.tabId).barrier;
  const active = s.manager.getTab(popup.tabId);
  const outcome = await s.control.submit(popupToken, {
    requestId: 'popup-switch',
    tabId: popup.tabId,
    navigationGeneration: active.navigationGeneration,
    viewportVersion: active.viewportVersion,
    epoch: s.control.state(popup.tabId).epoch,
    action: { type: 'click', ...(await center(popupPage, '#increment')) },
  });
  assert.equal(outcome.outcome, 'completed');
  assert.equal(await popupPage.locator('#revision').textContent(), '1');
  assert.equal(await s.tab.page.locator('#revision').textContent(), '8');
  samples++;
  return { samples, subjectIds: [id, popup.tabId, s.browser.browserId], measurements: [] };
}
export async function probeDiagnostics(s) {
  await s.tab.page.locator('#diagnostics').click();
  await s.tab.page.evaluate(() => fetch('/network-unavailable').catch(() => {}));
  // Actual request abort yields requestfailed separately from fixture HTTP errors.
  await s.tab.page.route('**/network-aborted', (route) => route.abort('failed'));
  await s.tab.page.evaluate(() => fetch('/network-aborted').catch(() => {}));
  for (let i = 0; i < 40; i++) {
    const kinds = s.manager.diagnostics(s.tab.tabId).entries.map((e) => e.kind);
    if (
      ['console-log', 'console-error', 'page-error', 'http-error', 'network-error'].every((k) =>
        kinds.includes(k)
      )
    )
      break;
    await delay(25);
  }
  const before = s.manager.diagnostics(s.tab.tabId);
  for (const kind of ['console-log', 'console-error', 'page-error', 'http-error', 'network-error'])
    assert.ok(
      before.entries.some((e) => e.kind === kind),
      kind
    );
  const seq = before.entries.at(-1).sequence;
  await s.tab.page.evaluate(() => {
    for (let i = 0; i < 60; i++) console.log('fixture-bounded-log');
  });
  for (
    let i = 0;
    i < 40 && s.manager.diagnostics(s.tab.tabId).entries.at(-1).sequence < seq + 60;
    i++
  )
    await delay(25);
  const after = s.manager.diagnostics(s.tab.tabId);
  assert.equal(after.entries.length, 20);
  assert.equal(after.entries.at(-1).sequence, seq + 60);
  assertObservation(
    after.dropped === before.dropped + before.entries.length + 60 - 20,
    'diagnostic-loss-mismatch'
  );
  assert.ok(
    after.entries.every(
      (e) =>
        e.tabId === s.tab.tabId &&
        e.navigationGeneration === s.manager.getTab(s.tab.tabId).navigationGeneration
    )
  );
  return {
    samples: 60,
    subjectIds: [s.tab.tabId, s.browser.browserId],
    measurements: [
      distribution('diagnostic-emitted', 'count', [60]),
      distribution('diagnostic-retained', 'count', [after.entries.length]),
      distribution('diagnostic-dropped', 'count', [after.dropped - before.dropped]),
    ],
  };
}

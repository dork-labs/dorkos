/* global window */
import assert from 'node:assert/strict';
import { NegativeObservation } from './durability/negative-observation.mjs';
import { BrowserManager } from './manager.mjs';
import { processIdentity } from './profile-reservation.mjs';
import { bounded, delay } from './durability-helpers.mjs';
function managerFor({ runtime, profilesDir, fixture }) {
  return new BrowserManager({ runtime, profilesDir, fixtureOrigin: fixture.url });
}
async function pageFor(manager, browser, fixture, marker) {
  const tab = manager.getTab(browser.tabIds[0]);
  tab.page.setDefaultTimeout(5000);
  await tab.page.goto(`${fixture.url}/?marker=${marker}`, { timeout: 10_000 });
  return tab;
}
async function state(page) {
  return page.evaluate(() => window.fixture.readState());
}
function durableState(value, marker) {
  assert.equal(value.identity, 'fictitious-user');
  assert.equal(value.localStorage, marker);
  assert.equal(value.indexedDB, marker);
  assert.equal(value.cacheStorage, marker);
  assert.equal(value.serviceWorkers, 1);
}
function cleanState(value) {
  for (const key of ['identity', 'sessionIdentity', 'localStorage', 'indexedDB', 'cacheStorage'])
    assert.equal(value[key], null, key);
  assert.equal(value.serviceWorkers, 0);
  assert.equal(value.controlled, false);
}

/** Exactly three Chromium process restarts measure stores, never JavaScript page lifetime. */
export async function probePersistence({ runtime, profilesDir, fixture, fault = null }) {
  const manager = managerFor({ runtime, profilesDir, fixture });
  const open = () =>
    fault === 'ephemeral-persistence' ? manager.openClean() : manager.openPersistent('durable-A');
  try {
    let browser = await open();
    let tab = await pageFor(manager, browser, fixture, 'durable-tab');
    await tab.page.evaluate(() => window.fixture.seed('profile-A'));
    await tab.page.evaluate(() => fetch('/login?mode=session', { method: 'POST' }));
    const sessionBefore = (await state(tab.page)).sessionIdentity;
    assert.equal(
      (await tab.page.context().cookies()).find((cookie) => cookie.name === 'fixture_session')
        .expires,
      -1
    );
    assert.equal(sessionBefore, 'fictitious-session');
    await tab.page.evaluate(() => window.fixture.httpCache('durable-cache'));
    assert.equal(fixture.stats()['durable-cache'], 1);
    const sessionAfter = [];
    const browserIds = [browser.browserId];
    const processIds = [manager.ownedProcess(browser.browserId)];
    for (let cycle = 0; cycle < 3; cycle++) {
      await manager.closeBrowser(browser.browserId);
      assert.equal(processIdentity(processIds.at(-1).pid), null);
      browser = await open();
      browserIds.push(browser.browserId);
      processIds.push(manager.ownedProcess(browser.browserId));
      tab = await pageFor(manager, browser, fixture, 'durable-tab');
      const reopened = await state(tab.page);
      if (
        fault === 'ephemeral-persistence' &&
        reopened.identity === null &&
        reopened.localStorage === null &&
        reopened.indexedDB === null &&
        reopened.cacheStorage === null &&
        reopened.serviceWorkers === 0
      )
        throw new NegativeObservation(fault, cycle + 1);
      durableState(reopened, 'profile-A');
      // A persistent registration may acquire this new page asynchronously.
      await bounded(tab.page.waitForFunction(() => Boolean(navigator.serviceWorker.controller)));
      await tab.page.evaluate(() => window.fixture.httpCache('durable-cache'));
      assert.equal(fixture.stats()['durable-cache'], 1, 'HTTP cache must survive restart');
      sessionAfter.push((await state(tab.page)).sessionIdentity === 'fictitious-session');
    }
    assert.equal(new Set(browserIds).size, 4);
    await tab.page.evaluate(() => fetch('/login?mode=expired', { method: 'POST' }));
    assert.equal((await state(tab.page)).identity, null);
    await tab.page.evaluate(() => fetch('/login?mode=short', { method: 'POST' }));
    assert.equal((await state(tab.page)).identity, 'fictitious-user');
    await bounded(
      (async () => {
        while ((await state(tab.page)).identity !== null) await delay(50);
      })(),
      5000
    );
    assert.equal(
      await tab.page.evaluate(() => fetch('/protected').then((response) => response.status)),
      401
    );
    return { samples: 3, sessionBefore: true, sessionAfter };
  } finally {
    await manager.shutdown();
  }
}

/** Clean state is inspected before writes and returning preserves the running durable Page. */
export async function probeClean({ runtime, profilesDir, fixture, fault = null }) {
  const manager = managerFor({ runtime, profilesDir, fixture });
  try {
    const durable = await manager.openPersistent('clean-return-A');
    const a = await pageFor(manager, durable, fixture, 'persistent-tab');
    await a.page.evaluate(() => window.fixture.seed('profile-A'));
    await a.page.evaluate(() => window.fixture.httpCache('clean-cache'));
    const clean = fault === 'seeded-clean' ? durable : await manager.openClean();
    const b = fault === 'seeded-clean' ? a : await pageFor(manager, clean, fixture, 'clean-tab');
    const initial = await state(b.page);
    if (
      fault === 'seeded-clean' &&
      initial.identity === 'fictitious-user' &&
      initial.localStorage === 'profile-A' &&
      initial.indexedDB === 'profile-A' &&
      initial.cacheStorage === 'profile-A' &&
      initial.serviceWorkers === 1
    )
      throw new NegativeObservation(fault, 1);
    cleanState(initial);
    await b.page.evaluate(() => window.fixture.httpCache('clean-cache'));
    assert.equal(fixture.stats()['clean-cache'], 2, 'clean context must miss durable HTTP cache');
    await b.page.evaluate(() => window.fixture.seed('clean-B'));
    await manager.closeBrowser(clean.browserId);
    assert.equal(manager.getTab(a.tabId).tabId, a.tabId);
    durableState(await state(a.page), 'profile-A');
    await a.page.evaluate(() => window.fixture.httpCache('clean-cache'));
    assert.equal(fixture.stats()['clean-cache'], 2);
    return { samples: 1 };
  } finally {
    await manager.shutdown();
  }
}

/** Two distinct contexts each perform exactly 100 mutations with no viewer/capture subscription. */
export async function probeUnattended({ runtime, profilesDir, fixture, fault = null }) {
  const manager = managerFor({ runtime, profilesDir, fixture });
  let captures = 0;
  manager.capture = () => {
    captures++;
    throw Error('UNEXPECTED_CAPTURE');
  };
  try {
    const aBrowser = await manager.openPersistent('worker-A');
    const bBrowser =
      fault === 'shared-context' ? aBrowser : await manager.openPersistent('worker-B');
    const a = await pageFor(manager, aBrowser, fixture, 'worker-A');
    const b =
      fault === 'shared-context' ? a : await pageFor(manager, bBrowser, fixture, 'worker-B');
    await a.page.evaluate(() => window.fixture.seed('worker-A'));
    await b.page.evaluate(() => window.fixture.seed('worker-B'));
    await Promise.all(
      [a, b].map(({ page }) =>
        page.evaluate(async () => {
          for (let i = 0; i < 100; i++) {
            window.fixture.increment();
            await Promise.resolve();
          }
        })
      )
    );
    const states = await Promise.all([state(a.page), state(b.page)]);
    if (
      fault === 'shared-context' &&
      a.tabId === b.tabId &&
      states.every(
        (value) =>
          value.revision === 200 &&
          value.localStorage === 'worker-B' &&
          value.indexedDB === 'worker-B'
      )
    )
      throw new NegativeObservation(fault, 200);
    assert.deepEqual(
      states.map((value) => value.revision),
      [100, 100]
    );
    assert.deepEqual(
      states.map((value) => value.localStorage),
      ['worker-A', 'worker-B']
    );
    assert.deepEqual(
      states.map((value) => value.indexedDB),
      ['worker-A', 'worker-B']
    );
    assert.equal(new Set([aBrowser.browserId, bBrowser.browserId]).size, 2);
    assert.equal(captures, 0);
    // Reattach a trusted read observer to the same live Pages; do not restart or navigate them.
    assert.deepEqual(
      [manager.getTab(a.tabId).tabId, manager.getTab(b.tabId).tabId],
      [a.tabId, b.tabId]
    );
    assert.deepEqual(
      (await Promise.all([state(a.page), state(b.page)])).map((v) => v.revision),
      [100, 100]
    );
    return { samples: 200 };
  } finally {
    await manager.shutdown();
  }
}

/* global window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { BrowserManager } from '../manager.mjs';
import { processIdentity } from '../profile-reservation.mjs';
import { managerDeathInventory } from './resource-manager-crash.mjs';
import {
  ownedTree,
  liveOwned,
  signalOwned,
  awaitGone,
  distinctOwned,
} from './resource-process.mjs';
import { bounded, delay } from '../durability-helpers.mjs';

async function stores(page, marker) {
  const value = await page.evaluate(() => window.fixture.readState());
  assert.equal(value.identity, 'fictitious-user');
  for (const key of ['localStorage', 'indexedDB', 'cacheStorage'])
    assert.equal(value[key], marker, key);
  assert.equal(value.serviceWorkers, 1);
}
async function navigate(manager, browser, fixture) {
  const tab = manager.getTab(browser.tabIds[0]);
  tab.page.setDefaultTimeout(5000);
  await tab.page.goto(fixture.url + '/?marker=crash-subject', { timeout: 10_000 });
  return tab.page;
}
async function blocked(page, fixture, marker) {
  let requests = 0;
  const remove = fixture.onBlocked((seen) => {
    if (seen === marker) requests++;
  });
  const outcome = page
    .evaluate((id) => window.fixture.block(id), marker)
    .then(
      () => 'completed',
      () => 'failed'
    );
  await bounded(
    (async () => {
      while (!fixture.blocked().includes(marker)) await delay(20);
    })()
  );
  return { outcome, count: () => requests, remove };
}

/** Crash renderer and root browser independently, preserving committed stores and observing lost work. */
export async function crashRecovery({ repoRoot, runtime, profilesDir, fixture }) {
  const manager = new BrowserManager({ runtime, profilesDir, fixtureOrigin: fixture.url });
  const inventories = [];
  const outcomes = [];
  let rendererDeaths;
  let request;
  try {
    let browser = await manager.openPersistent('crash-integrity');
    let page = await navigate(manager, browser, fixture);
    await page.evaluate(() => window.fixture.seed('crash-A'));
    await stores(page, 'crash-A');
    // Page readback alone does not prove disk persistence: establish a clean close/reopen baseline.
    await manager.closeBrowser(browser.browserId);
    browser = await manager.openPersistent('crash-integrity');
    page = await navigate(manager, browser, fixture);
    await stores(page, 'crash-A');
    await page.evaluate(() => window.fixture.httpCache('crash-cache'));
    const root = manager.ownedProcess(browser.browserId);
    const beforeRenderer = ownedTree(root);
    inventories.push(...beforeRenderer);
    const crashEvent = new Promise((resolve) => page.once('crash', resolve));
    request = await blocked(page, fixture, 'renderer-action');
    const session = await page.context().newCDPSession(page);
    // Chromium may never answer Page.crash after terminating its renderer; the crash event is the observation.
    session.send('Page.crash').catch(() => {});
    await bounded(crashEvent);
    outcomes.push(await bounded(request.outcome));
    assert.equal(
      outcomes.at(-1),
      'failed',
      'in-flight renderer work must not be reported completed'
    );
    assert.equal(
      processIdentity(root.pid)?.birth,
      root.birth,
      'renderer crash retains browser root'
    );
    rendererDeaths = beforeRenderer.filter(
      (entry) => processIdentity(entry.pid)?.birth !== entry.birth
    ).length;
    assert.ok(rendererDeaths > 0, 'at least one owned child identity exited at renderer crash');
    const context = page.context();
    await page.close();
    page = await context.newPage();
    await page.goto(fixture.url + '/?marker=renderer-relaunch', { timeout: 10_000 });
    await stores(page, 'crash-A');
    assert.equal(request.count(), 1, 'renderer action must not replay after reload');
    request.remove();
    request = await blocked(page, fixture, 'browser-action');
    inventories.push(...ownedTree(root));
    const browserContextClosed = page
      .context()
      .waitForEvent('close', { timeout: 5000 })
      .then(
        () => true,
        () => false
      );
    assert.equal(signalOwned(root, 'SIGKILL'), true);
    await awaitGone([root]);
    assert.equal(
      await browserContextClosed,
      true,
      'Playwright must observe root death before manager closes its dead record'
    );
    outcomes.push(await bounded(request.outcome));
    assert.equal(outcomes.at(-1), 'failed', 'browser-death work must be reported lost');
    // The live owner closes its dead record and releases its own reservation before relaunch.
    await manager.closeBrowser(browser.browserId);
    browser = await manager.openPersistent('crash-integrity');
    assert.notEqual(manager.ownedProcess(browser.browserId).pid, root.pid);
    page = await navigate(manager, browser, fixture);
    await stores(page, 'crash-A');
    assert.equal(request.count(), 1, 'browser action must not replay on reopen');
    request.remove();
    request = null;
    await page.evaluate(() => window.fixture.httpCache('crash-cache'));
    const cacheRequests = fixture.stats()['crash-cache'];
    inventories.push(...ownedTree(manager.ownedProcess(browser.browserId)));
    await manager.shutdown();
    await awaitGone(inventories);
    const managerCrash = await managerDeathInventory({
      repoRoot,
      runtime,
      profilesDir: join(profilesDir, 'manager-death'),
      fixture,
    });
    inventories.push(...managerCrash.shutdownInventory);
    const distinct = distinctOwned(inventories);
    await awaitGone(distinct);
    return {
      subjectIds: ['renderer-crash-subject', 'browser-crash-subject', 'manager-crash-subject'],
      samples: 3,
      rendererDeaths,
      lostActions: outcomes.length,
      cacheRequests,
      shutdownSubjects: distinct.length,
      shutdownInventory: distinct,
      managerDeathSubjects: managerCrash.originalSubjects,
      managerRecoverySubjects: managerCrash.recoverySubjects,
      managerRootAliveSnapshot: managerCrash.rootAliveSnapshot,
      managerRefusalObserved: managerCrash.survivorObserved,
      managerRootExitedBeforeCheck: managerCrash.rootExitedBeforeCheck,
      gracefulShutdownObserved: true,
      managerSurvivor: managerCrash.survivorObserved,
    };
  } finally {
    request?.remove();
    await manager.shutdown().catch(() => {});
    for (const owned of inventories) signalOwned(owned, 'SIGKILL');
    if (inventories.length) await awaitGone(inventories);
  }
}

/** A real live child must be visible to the orphan observer, and birth mismatch must authorize no kill. */
export async function orphanControls() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exit = new Promise((resolve) => child.once('exit', resolve));
  let identity;
  try {
    await bounded(
      (async () => {
        while (!(identity = processIdentity(child.pid))) await delay(10);
      })()
    );
    assert.equal(
      liveOwned([identity]).length,
      1,
      'observer must detect a deliberately live owned child'
    );
    assert.throws(() => liveOwned([]), /EMPTY_PROCESS_INVENTORY/);
    assert.equal(signalOwned({ ...identity, birth: 'incorrect-birth' }, 'SIGKILL'), false);
    assert.equal(
      liveOwned([identity]).length,
      1,
      'wrong birth must leave owned positive control alive'
    );
    signalOwned(identity);
    await bounded(exit);
    assert.equal(liveOwned([identity]).length, 0);
    return { samples: 3 };
  } finally {
    if (identity) signalOwned(identity, 'SIGKILL');
    else child.kill('SIGKILL');
    await bounded(exit);
  }
}

/** Observe recent acknowledged site writes under abrupt death separately from clean-close disk commitment. */
export async function recentWriteCrash({ runtime, profilesDir, fixture }) {
  const manager = new BrowserManager({ runtime, profilesDir, fixtureOrigin: fixture.url });
  const inventory = [];
  try {
    let browser = await manager.openPersistent('recent-write');
    let page = await navigate(manager, browser, fixture);
    await page.evaluate(() => window.fixture.seed('recent-A'));
    await stores(page, 'recent-A');
    const root = manager.ownedProcess(browser.browserId);
    inventory.push(...ownedTree(root));
    const browserContextClosed = page
      .context()
      .waitForEvent('close', { timeout: 5000 })
      .then(
        () => true,
        () => false
      );
    assert.equal(signalOwned(root, 'SIGKILL'), true);
    await awaitGone([root]);
    assert.equal(
      await browserContextClosed,
      true,
      'Playwright must observe root death before closing the dead record'
    );
    await manager.closeBrowser(browser.browserId);
    browser = await manager.openPersistent('recent-write');
    page = await navigate(manager, browser, fixture);
    const after = await page.evaluate(() => window.fixture.readState());
    const survived = {
      login: after.identity === 'fictitious-user',
      localStorage: after.localStorage === 'recent-A',
      indexedDB: after.indexedDB === 'recent-A',
      cacheStorage: after.cacheStorage === 'recent-A',
      serviceWorker: after.serviceWorkers === 1,
    };
    inventory.push(...ownedTree(manager.ownedProcess(browser.browserId)));
    await manager.shutdown();
    await awaitGone(inventory);
    return {
      subjectIds: [browser.browserId],
      samples: 1,
      survived,
      lostStores: Object.values(survived).filter((value) => !value).length,
    };
  } finally {
    await manager.shutdown().catch(() => {});
    for (const owned of inventory) signalOwned(owned, 'SIGKILL');
    if (inventory.length) await awaitGone(inventory);
  }
}

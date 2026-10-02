/* global window */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { get } from 'node:http';
import { startFixture } from '../fixture.mjs';
import { loadPlaywright } from '../runtime.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('fixture loopback server rejects foreign origins and observes deterministic cache requests', async () => {
  // Cross-site requests cannot mutate the fake fixture, and server counters reveal cache misses.
  const fixture = await startFixture();
  try {
    assert.equal(await (await fetch(fixture.url + '/health')).text(), 'fixture-ready');
    assert.equal(
      (
        await fetch(fixture.url + '/login', {
          method: 'POST',
          headers: { origin: 'https://foreign.invalid' },
        })
      ).status,
      403
    );
    const foreignHostStatus = await new Promise((resolve, reject) => {
      get(fixture.url + '/health', { headers: { host: 'foreign.invalid' } }, (response) => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(fixture.url + '/protected')).status, 401);
    const shortLogin = await fetch(fixture.url + '/login?mode=short', { method: 'POST' });
    assert.match(shortLogin.headers.get('set-cookie'), /Max-Age=1;/);
    const sessionLogin = await fetch(fixture.url + '/login?mode=session', { method: 'POST' });
    assert.doesNotMatch(sessionLogin.headers.get('set-cookie'), /Max-Age|Expires/i);
    assert.equal(
      (await fetch(fixture.url + '/login?mode=unknown', { method: 'POST' })).status,
      400
    );
    assert.equal((await fetch(fixture.url + '/cache-resource?marker=invalid/marker')).status, 400);
    assert.equal(
      await (await fetch(fixture.url + '/cache-resource?marker=cache-A')).text(),
      'cache-A'
    );
    assert.deepEqual(fixture.stats(), { 'cache-A': 1 });
  } finally {
    await fixture.close();
    await fixture.close();
  }
});

test('fixture actual Chromium observes all seeded stores and independent context reset', async (t) => {
  // The actual Page/storage boundary proves the fixture is usable by subsequent persistence gates.
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const runtime = await loadPlaywright({ repoRoot });
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  t.after(() => browser.close());
  try {
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const a = await contextA.newPage();
    const b = await contextB.newPage();
    await a.goto(fixture.url + '/?marker=tab-A');
    await b.goto(fixture.url + '/?marker=tab-B');
    await a.evaluate(() => window.fixture.seed('profile-A'));
    await b.evaluate(() => window.fixture.seed('profile-B'));
    const stateA = await a.evaluate(() => window.fixture.readState());
    assert.deepEqual(stateA, {
      identity: 'fictitious-user',
      sessionIdentity: null,
      localStorage: 'profile-A',
      indexedDB: 'profile-A',
      cacheStorage: 'profile-A',
      serviceWorkers: 1,
      controlled: true,
      marker: 'tab-A',
      revision: 0,
    });
    assert.equal(await a.evaluate(() => fetch('/protected').then((r) => r.status)), 200);
    await a.evaluate(() => fetch('/login?mode=session', { method: 'POST' }));
    assert.equal((await contextA.cookies()).find((c) => c.name === 'fixture_session').expires, -1);
    assert.equal(
      (await a.evaluate(() => window.fixture.readState())).sessionIdentity,
      'fictitious-session'
    );
    await a.evaluate(() => fetch('/login?mode=expired', { method: 'POST' }));
    assert.equal((await a.evaluate(() => window.fixture.readState())).identity, null);
    assert.equal(await a.evaluate(() => fetch('/protected').then((r) => r.status)), 401);

    await a.evaluate(() => window.fixture.httpCache('cache-A'));
    await a.evaluate(() => window.fixture.httpCache('cache-A'));
    assert.equal(fixture.stats()['cache-A'], 1);
    await b.evaluate(() => window.fixture.httpCache('cache-A'));
    assert.equal(fixture.stats()['cache-A'], 2);
    const reset = await a.evaluate(() => window.fixture.reset());
    assert.equal(reset.identity, null);
    assert.equal(reset.localStorage, null);
    assert.equal(reset.indexedDB, null);
    assert.equal(reset.cacheStorage, null);
    assert.equal(reset.serviceWorkers, 0);
    const stateB = await b.evaluate(() => window.fixture.readState());
    assert.equal(stateB.localStorage, 'profile-B');
    assert.equal(stateB.indexedDB, 'profile-B');
    assert.equal(stateB.cacheStorage, 'profile-B');
    assert.equal(stateB.identity, 'fictitious-user');
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('fixture popup markers, input and known diagnostics are observable on the real page', async (t) => {
  // Distinct page subjects and known diagnostics prevent later tab/evidence tests passing vacuously.
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const runtime = await loadPlaywright({ repoRoot });
  const browser = await runtime.chromium.launch(runtime.launchOptions);
  t.after(() => browser.close());
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const logs = [];
    page.on('console', (message) => logs.push(message.text()));
    await page.goto(fixture.url + '/?marker=tab-A');
    assert.equal(await page.locator('#marker').textContent(), 'tab-A');
    await page.locator('#increment').click();
    assert.equal(await page.locator('#revision').textContent(), '1');
    await page.locator('#text').fill('emoji-🦋-中文');
    assert.equal(await page.locator('#text').inputValue(), 'emoji-🦋-中文');
    const popupReady = page.waitForEvent('popup');
    await page.locator('#popup').click();
    const popup = await popupReady;
    await popup.waitForLoadState();
    assert.equal(await popup.locator('#marker').textContent(), 'popup-B');
    assert.equal(await page.locator('#marker').textContent(), 'tab-A');
    const errorReady = page.waitForEvent('pageerror');
    const requestReady = page.waitForResponse(
      (response) => response.url() === fixture.url + '/known-failure'
    );
    await page.locator('#diagnostics').click();
    assert.equal((await requestReady).status(), 404);
    assert.equal((await errorReady).message, 'fixture-known-page-error');
    assert.deepEqual(
      logs.filter((message) => message.startsWith('fixture-known-')),
      ['fixture-known-log', 'fixture-known-error']
    );
    assert.ok(
      (await page.locator('body').ariaSnapshot()).includes(
        'Text, composition and clipboard fixture'
      )
    );
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test('fixture holds actions until explicit release and closes pending requests', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  let observed;
  const ready = new Promise((resolve) => {
    observed = resolve;
  });
  const unsubscribe = fixture.onBlocked(observed);
  const pending = fetch(fixture.url + '/blocked?marker=action-A');
  assert.equal(await ready, 'action-A');
  unsubscribe();
  assert.deepEqual(fixture.blocked(), ['action-A']);
  assert.equal((await fetch(fixture.url + '/blocked?marker=action-A')).status, 400);
  assert.equal(fixture.release('missing'), false);
  assert.equal(fixture.release('action-A'), true);
  assert.equal(await (await pending).text(), 'fixture-released');
  assert.deepEqual(fixture.blocked(), []);
  const closeReady = new Promise((resolve) => fixture.onBlocked(resolve));
  // Attach the failure observer immediately so intentional socket shutdown cannot leak a rejection.
  const closedRequest = fetch(fixture.url + '/blocked?marker=action-close').then(
    () => 'unexpected-response',
    () => 'closed'
  );
  assert.equal(await closeReady, 'action-close');
  await fixture.close();
  assert.equal(await closedRequest, 'closed');
});

import './native-fixture-preflight.js';
import { it, expect } from 'vitest';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { createBrowserEngine, type BrowserLifecycleEngine } from '../index.js';
import { fixture, configuration, requestId } from './lifecycle-fixture.js';

async function stop(engine: BrowserLifecycleEngine, owned: Awaited<ReturnType<typeof fixture>>) {
  const results = await engine.shutdown();
  await owned.close(results.every((result) => result.cleanup === 'observed'));
  expect(results.every((result) => result.cleanup === 'observed')).toBe(true);
}

it('fences redirect popup subrequest and native service-worker traffic to the exact fixture origin', async () => {
  let hits = 0;
  const foreign = createServer((_, response) => {
    hits++;
    response.end('FOREIGN');
  });
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
  const address = foreign.address();
  if (!address || typeof address === 'string') throw Error('FOREIGN_ADDRESS_UNAVAILABLE');
  const origin = `http://127.0.0.1:${address.port}`;
  const owned = await fixture();
  const engine = createBrowserEngine(
    await configuration(join(owned.root, 'data'), owned.origin, true)
  );
  try {
    await new Promise<void>((resolve, reject) =>
      get(origin, (response) => {
        response.resume();
        response.on('end', resolve);
      }).on('error', reject)
    );
    expect(hits).toBe(1);
    hits = 0; // A live second server, rather than an unreachable negative target.
    owned.configure({ foreign: origin });
    const opened = await engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
    await expect.poll(() => owned.workerDone).toBe(true);
    await expect.poll(() => owned.counter).toBeGreaterThan(3);
    expect(hits).toBe(0);
    const tabs = engine.listTabs(opened.browserId, opened.browserGeneration);
    expect(new Set(tabs.map((tab) => tab.tabId)).size).toBe(tabs.length); // A blocked popup may retain its offline blank/error Page.
    expect(
      await engine.close({
        kind: 'close',
        requestId,
        browserId: opened.browserId,
        browserGeneration: 0,
      })
    ).toMatchObject({ cleanup: 'observed' });
    owned.configure({ redirect: true });
    await expect(engine.open({ kind: 'open', requestId, mode: 'ephemeral' })).rejects.toMatchObject(
      { code: 'INITIAL_NAVIGATION_FAILED' }
    );
    expect(owned.redirects).toBeGreaterThanOrEqual(2);
    expect(hits).toBe(0);
  } finally {
    await stop(engine, owned);
    foreign.closeAllConnections();
    await new Promise<void>((resolve) => foreign.close(() => resolve()));
  }
}, 30_000);

it('captures distinct canonical popup bytes and detects wrong-Page bytes even with expected metadata', async () => {
  const owned = await fixture();
  const engine = createBrowserEngine(
    await configuration(join(owned.root, 'data'), owned.origin, true)
  );
  try {
    owned.configure({ popup: true });
    const opened = await engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
    await expect.poll(() => engine.listTabs(opened.browserId, 0).length).toBe(2);
    const popup = engine
      .listTabs(opened.browserId, 0)
      .find((tab) => tab.tabId !== opened.tab.tabId)!;
    expect(popup.tabId).not.toBe(opened.tab.tabId);
    const main = await engine.capture({ kind: 'capture', requestId, binding: opened.tab });
    const other = await engine.capture({ kind: 'capture', requestId, binding: popup });
    async function pixel(bytes: Uint8Array) {
      const index = owned.pixels.length;
      owned.configure({
        popup: false,
        imageSource: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,
      });
      await engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
      await expect.poll(() => owned.pixels.length).toBe(index + 1);
      return owned.pixels[index]!;
    }
    const red = await pixel(main.bytes);
    const blue = await pixel(other.bytes);
    expect(red[0]).toBeGreaterThan(180);
    expect(red[2]).toBeLessThan(60);
    expect(blue[2]).toBeGreaterThan(180);
    expect(blue[0]).toBeLessThan(60);
    const wrongPage = { receipt: main.receipt, bytes: other.bytes };
    expect(wrongPage.receipt.binding).toEqual(opened.tab); // Metadata alone would accept the wrong page.
    const wrongPixel = await pixel(wrongPage.bytes);
    expect(wrongPixel[0]! > 180 && wrongPixel[2]! < 60).toBe(false);
  } finally {
    await stop(engine, owned);
  }
}, 30_000);

it('rejects a capture whose canonical navigation generation changes during policy authorization', async () => {
  const owned = await fixture();
  const config = await configuration(join(owned.root, 'data'), owned.origin, true);
  let release!: (value: 'allowed') => void;
  let entered!: () => void;
  const pending = new Promise<'allowed'>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  config.policy.authorizeAction = () => {
    entered();
    return pending;
  };
  const engine = createBrowserEngine(config);
  try {
    const opened = await engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
    const capture = engine.capture({ kind: 'capture', requestId, binding: opened.tab });
    const rejected = expect(capture).rejects.toMatchObject({ code: 'STALE_BINDING' });
    await held;
    owned.configure({ navigation: '/second' });
    await expect
      .poll(() => engine.listTabs(opened.browserId, 0)[0]!.navigationGeneration)
      .toBeGreaterThan(opened.tab.navigationGeneration);
    release('allowed');
    await rejected;
    const binding = engine.listTabs(opened.browserId, 0)[0]!;
    expect((await engine.capture({ kind: 'capture', requestId, binding })).receipt.binding).toEqual(
      binding
    );
  } finally {
    release('allowed');
    await stop(engine, owned);
  }
}, 15_000);

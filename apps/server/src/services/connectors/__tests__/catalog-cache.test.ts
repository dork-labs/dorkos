import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectorProvider,
  ConnectorProviderInstanceId,
  ConnectorToolkit,
} from '@dorkos/shared/connector-provider';
import { ConnectorCatalogCache, DEFAULT_FRESH_FOR_MS } from '../resources/catalog-cache.js';

const DIGEST = 'digest-a';
const INSTANCE = 'provider-instance-a' as ConnectorProviderInstanceId;

function toolkits(count: number, prefix = 'app'): ConnectorToolkit[] {
  return Array.from({ length: count }, (_, index) => ({
    slug: `${prefix}-${String(index).padStart(3, '0')}`,
    displayName: `${prefix} ${index}`,
    authKind: 'oauth2' as const,
  }));
}

/** A provider whose listing is counted and replaceable mid-test. */
function countingProvider(initial: ConnectorToolkit[]) {
  const provider = new FakeConnectorProvider({ type: 'composio', instanceId: INSTANCE });
  const state = { toolkits: initial, listings: 0, pages: 0 };
  const listToolkitPage = vi.spyOn(provider, 'listToolkitPage').mockImplementation((request) => {
    if (!request.cursor) state.listings += 1;
    state.pages += 1;
    const offset = request.cursor ? Number(request.cursor) : 0;
    const page = state.toolkits.slice(offset, offset + request.limit);
    const next = offset + page.length;
    return Promise.resolve({
      status: 'ok' as const,
      toolkits: page,
      ...(next < state.toolkits.length && { nextCursor: String(next) }),
      truncated: next < state.toolkits.length,
    });
  });
  return { provider, state, listToolkitPage };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function fileFor(dir: string, instanceId: string): string {
  return path.join(dir, `${createHash('sha256').update(instanceId).digest('hex')}.json`);
}

async function fileExists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false
  );
}

describe('ConnectorCatalogCache', () => {
  let dir: string;
  let now: number;
  const clock = () => now;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-catalog-cache-'));
    now = 1_000_000;
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists a service once and answers every later read from the kept copy', async () => {
    const { provider, state } = countingProvider(toolkits(850));
    const cache = new ConnectorCatalogCache({ now: clock });

    const first = await cache.read(provider, DIGEST, signal());
    for (let i = 0; i < 5; i += 1) await cache.read(provider, DIGEST, signal());

    expect(first).toMatchObject({ status: 'ok', truncated: false });
    expect(first.status === 'ok' && first.toolkits).toHaveLength(850);
    expect(state.listings).toBe(1);
    // 850 apps at 100 a page.
    expect(state.pages).toBe(9);
  });

  it('shares one listing between concurrent readers', async () => {
    const { provider, state } = countingProvider(toolkits(250));
    const cache = new ConnectorCatalogCache({ now: clock });

    const reads = await Promise.all(
      Array.from({ length: 6 }, () => cache.read(provider, DIGEST, signal()))
    );

    expect(state.listings).toBe(1);
    expect(reads.every((read) => read.status === 'ok' && read.toolkits.length === 250)).toBe(true);
  });

  it('serves a stale copy at once and replaces it with one background refresh', async () => {
    const { provider, state } = countingProvider(toolkits(3, 'old'));
    const cache = new ConnectorCatalogCache({ now: clock });
    await cache.read(provider, DIGEST, signal());

    now += DEFAULT_FRESH_FOR_MS - 1;
    state.toolkits = toolkits(3, 'new');
    const stillFresh = await cache.read(provider, DIGEST, signal());
    expect(stillFresh.status === 'ok' && stillFresh.toolkits[0]!.slug).toBe('old-000');
    expect(state.listings).toBe(1);

    now += 1;
    const stale = await cache.read(provider, DIGEST, signal());
    await cache.read(provider, DIGEST, signal());
    // The stale copy answered without waiting; both reads started one refresh.
    expect(stale.status === 'ok' && stale.toolkits[0]!.slug).toBe('old-000');
    await vi.waitFor(async () => {
      const read = await cache.read(provider, DIGEST, signal());
      expect(read.status === 'ok' && read.toolkits[0]!.slug).toBe('new-000');
    });
    expect(state.listings).toBe(2);
  });

  it('keeps serving the old copy when a refresh fails, and waits before retrying', async () => {
    const { provider, state, listToolkitPage } = countingProvider(toolkits(2));
    const cache = new ConnectorCatalogCache({ now: clock });
    await cache.read(provider, DIGEST, signal());

    now += DEFAULT_FRESH_FOR_MS;
    listToolkitPage.mockImplementation(() => {
      state.listings += 1;
      return Promise.reject(new Error('upstream 503'));
    });
    const read = await cache.read(provider, DIGEST, signal());
    expect(read.status === 'ok' && read.toolkits).toHaveLength(2);
    await vi.waitFor(() => expect(state.listings).toBe(2));
    // Let the failed refresh settle before the next reads.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Inside the retry window the old copy answers without another attempt.
    await cache.read(provider, DIGEST, signal());
    await cache.read(provider, DIGEST, signal());
    expect(state.listings).toBe(2);

    now += 60_000;
    await cache.read(provider, DIGEST, signal());
    expect(state.listings).toBe(3);
  });

  it('propagates a failed listing when there is no copy, so the caller can warn', async () => {
    const { provider, listToolkitPage } = countingProvider([]);
    listToolkitPage.mockRejectedValue(new Error('401 wrong key'));
    const cache = new ConnectorCatalogCache({ dir, now: clock });

    await expect(cache.read(provider, DIGEST, signal())).rejects.toThrow('401 wrong key');
    expect(await fileExists(fileFor(dir, INSTANCE))).toBe(false);
  });

  it('passes an unsupported answer through without keeping it', async () => {
    const { provider, state, listToolkitPage } = countingProvider([]);
    // The fake only ever answers `ok`; the port also allows `unsupported`.
    const unsupported: ConnectorProvider['listToolkitPage'] = () => {
      state.listings += 1;
      return Promise.resolve({ status: 'unsupported', reason: 'No catalog here.' });
    };
    listToolkitPage.mockImplementation(unsupported as typeof provider.listToolkitPage);
    const cache = new ConnectorCatalogCache({ now: clock });

    await expect(cache.read(provider, DIGEST, signal())).resolves.toEqual({
      status: 'unsupported',
      reason: 'No catalog here.',
    });
    await cache.read(provider, DIGEST, signal());
    expect(state.listings).toBe(2);
  });

  it('keeps a listing that runs past the page limit as truncated', async () => {
    const { provider, state } = countingProvider(toolkits(10_050));
    const cache = new ConnectorCatalogCache({ now: clock });

    const read = await cache.read(provider, DIGEST, signal());

    expect(read).toMatchObject({ status: 'ok', truncated: true });
    expect(read.status === 'ok' && read.toolkits).toHaveLength(10_000);
    expect(state.pages).toBe(100);
  });

  it('stops one reader waiting on its own deadline without cancelling the shared listing', async () => {
    const { provider, state, listToolkitPage } = countingProvider(toolkits(2));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = listToolkitPage.getMockImplementation()!;
    listToolkitPage.mockImplementation(async (request) => {
      await gate;
      return original(request);
    });
    const cache = new ConnectorCatalogCache({ now: clock });
    const impatient = new AbortController();

    const abandoned = cache.read(provider, DIGEST, impatient.signal);
    const patient = cache.read(provider, DIGEST, signal());
    impatient.abort(new Error('reader deadline'));
    await expect(abandoned).rejects.toThrow('reader deadline');

    release();
    const read = await patient;
    expect(read.status === 'ok' && read.toolkits).toHaveLength(2);
    expect(state.listings).toBe(1);
  });

  it('never serves a copy made under a different key or setup', async () => {
    const { provider, state } = countingProvider(toolkits(2, 'old'));
    const cache = new ConnectorCatalogCache({ now: clock });
    await cache.read(provider, DIGEST, signal());

    state.toolkits = toolkits(2, 'new');
    const read = await cache.read(provider, 'digest-b', signal());

    expect(read.status === 'ok' && read.toolkits[0]!.slug).toBe('new-000');
    expect(state.listings).toBe(2);
  });

  describe('on disk', () => {
    it('writes one secret-free file per service and reads it back after a restart', async () => {
      const { provider, state } = countingProvider(toolkits(120));
      await new ConnectorCatalogCache({ dir, now: clock }).read(provider, DIGEST, signal());

      const file = fileFor(dir, INSTANCE);
      const raw = await fs.readFile(file, 'utf-8');
      expect(raw).not.toContain(DIGEST);
      expect(JSON.parse(raw)).toMatchObject({ version: 1, truncated: false, fetchedAt: now });
      // Written atomically: no temporary file is left beside it.
      expect(await fs.readdir(dir)).toEqual([path.basename(file)]);

      const restarted = new ConnectorCatalogCache({ dir, now: clock });
      const read = await restarted.read(provider, DIGEST, signal());
      expect(read.status === 'ok' && read.toolkits).toHaveLength(120);
      expect(state.listings).toBe(1);
    });

    it('shares one file read between concurrent first reads after a restart', async () => {
      const { provider, state } = countingProvider(toolkits(3));
      await new ConnectorCatalogCache({ dir, now: clock }).read(provider, DIGEST, signal());

      const restarted = new ConnectorCatalogCache({ dir, now: clock });
      await Promise.all([
        restarted.read(provider, DIGEST, signal()),
        restarted.read(provider, DIGEST, signal()),
        restarted.find(INSTANCE, DIGEST, 'app-001'),
      ]);
      expect(state.listings).toBe(1);
    });

    it.each([
      ['corrupt', 'not json {'],
      ['an unknown version', JSON.stringify({ version: 99, toolkits: [] })],
      ['a malformed entry', JSON.stringify({ version: 1, setupKey: 'x', toolkits: [{}] })],
    ])('ignores a %s file and rebuilds it', async (_label, contents) => {
      const { provider, state } = countingProvider(toolkits(2));
      await fs.writeFile(fileFor(dir, INSTANCE), contents);

      const read = await new ConnectorCatalogCache({ dir, now: clock }).read(
        provider,
        DIGEST,
        signal()
      );

      expect(read.status === 'ok' && read.toolkits).toHaveLength(2);
      expect(state.listings).toBe(1);
      await vi.waitFor(async () =>
        expect(JSON.parse(await fs.readFile(fileFor(dir, INSTANCE), 'utf-8'))).toMatchObject({
          version: 1,
        })
      );
    });

    it('ignores a file written under a different key after a restart', async () => {
      const { provider, state } = countingProvider(toolkits(2));
      await new ConnectorCatalogCache({ dir, now: clock }).read(provider, DIGEST, signal());

      await new ConnectorCatalogCache({ dir, now: clock }).read(provider, 'digest-b', signal());

      expect(state.listings).toBe(2);
    });
  });

  describe('drop', () => {
    it('forgets the copy in memory and on disk', async () => {
      const { provider, state } = countingProvider(toolkits(2));
      const cache = new ConnectorCatalogCache({ dir, now: clock });
      await cache.read(provider, DIGEST, signal());

      cache.drop(INSTANCE);

      await vi.waitFor(async () => expect(await fileExists(fileFor(dir, INSTANCE))).toBe(false));
      await cache.read(provider, DIGEST, signal());
      expect(state.listings).toBe(2);
    });

    it('discards a refresh that was still running when the service was dropped', async () => {
      const { provider, state, listToolkitPage } = countingProvider(toolkits(2, 'old'));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const original = listToolkitPage.getMockImplementation()!;
      listToolkitPage.mockImplementationOnce(async (request) => {
        await gate;
        return original(request);
      });
      const cache = new ConnectorCatalogCache({ dir, now: clock });

      const inFlight = cache.read(provider, DIGEST, signal());
      await vi.waitFor(() => expect(listToolkitPage).toHaveBeenCalled());
      cache.drop(INSTANCE);
      release();
      await inFlight;

      expect(await cache.find(INSTANCE, DIGEST, 'old-000')).toBeUndefined();
      expect(await fileExists(fileFor(dir, INSTANCE))).toBe(false);
      state.toolkits = toolkits(2, 'new');
      const read = await cache.read(provider, DIGEST, signal());
      expect(read.status === 'ok' && read.toolkits[0]!.slug).toBe('new-000');
    });
  });

  describe('find', () => {
    it('looks one app up in the kept list without listing upstream', async () => {
      const { provider, state } = countingProvider(toolkits(3));
      const cache = new ConnectorCatalogCache({ dir, now: clock });

      expect(await cache.find(INSTANCE, DIGEST, 'app-001')).toBeUndefined();
      await cache.read(provider, DIGEST, signal());

      expect(await cache.find(INSTANCE, DIGEST, 'app-001')).toEqual({
        slug: 'app-001',
        displayName: 'app 1',
        authKind: 'oauth2',
      });
      expect(await cache.find(INSTANCE, DIGEST, 'missing')).toBeUndefined();
      expect(await cache.find(INSTANCE, 'digest-b', 'app-001')).toBeUndefined();
      expect(state.listings).toBe(1);
    });
  });
});

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeConnectorProvider } from '@dorkos/test-utils';
import type {
  ConnectorProviderInstanceId,
  ConnectorToolkit,
} from '@dorkos/shared/connector-provider';

import {
  ConnectorCatalogCache,
  MANAGED_CATALOG_KEEPING,
  VENDOR_CATALOG_KEEPING,
} from '../resources/catalog-cache.js';
import { COMPOSIO_PROVIDER_TYPE } from '../providers/composio.js';
import { MANAGED_CLOUD_PROVIDER_TYPE } from '../providers/managed/managed-cloud.js';

import { RAW_MCP_PROVIDER_TYPE } from '../providers/raw-mcp.js';

/** The countingProvider below is a Composio instance: a day, on disk. */
const DAY_MS = VENDOR_CATALOG_KEEPING.kind === 'keep' ? VENDOR_CATALOG_KEEPING.freshForMs : 0;

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
function countingProvider(initial: ConnectorToolkit[], type = COMPOSIO_PROVIDER_TYPE) {
  const provider = new FakeConnectorProvider({ type, instanceId: INSTANCE });
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

  it('serves a stale copy at once and replaces it with one background refresh', async () => {
    const { provider, state } = countingProvider(toolkits(3, 'old'));
    const cache = new ConnectorCatalogCache({ now: clock });
    await cache.read(provider, DIGEST, signal());

    now += DAY_MS - 1;
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

    now += DAY_MS;
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

      expect(await fileExists(fileFor(dir, INSTANCE))).toBe(false);
      state.toolkits = toolkits(2, 'new');
      const read = await cache.read(provider, DIGEST, signal());
      expect(read.status === 'ok' && read.toolkits[0]!.slug).toBe('new-000');
    });
  });

  describe('a disk read racing a drop', () => {
    it('discards a copy whose file read finished after the drop', async () => {
      const { provider, state } = countingProvider(toolkits(2, 'old'));
      await new ConnectorCatalogCache({ dir, now: clock }).read(provider, DIGEST, signal());
      const realReadFile = fs.readFile.bind(fs);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const readFile = vi.spyOn(fs, 'readFile').mockImplementationOnce((async (
        ...args: Parameters<typeof fs.readFile>
      ) => {
        const contents = await realReadFile(...args);
        await gate;
        return contents;
      }) as typeof fs.readFile);
      try {
        const restarted = new ConnectorCatalogCache({ dir, now: clock });
        const read = restarted.read(provider, DIGEST, signal());
        await vi.waitFor(() => expect(readFile).toHaveBeenCalled());
        restarted.drop(INSTANCE);
        state.toolkits = toolkits(2, 'new');
        release();

        // The file held the pre-drop copy; serving it would undo the drop.
        const result = await read;
        expect(result.status === 'ok' && result.toolkits[0]!.slug).toBe('new-000');
        expect(state.listings).toBe(2);
      } finally {
        readFile.mockRestore();
      }
    });
  });

  describe('per service keeping', () => {
    it('refreshes the DorkOS account list after 15 minutes, and keeps it across a restart', async () => {
      const { provider, state } = countingProvider(toolkits(2, 'old'), MANAGED_CLOUD_PROVIDER_TYPE);
      await new ConnectorCatalogCache({ dir, now: clock }).read(provider, DIGEST, signal());
      const restarted = new ConnectorCatalogCache({ dir, now: clock });

      now += 15 * 60 * 1000 - 1;
      await restarted.read(provider, DIGEST, signal());
      expect(state.listings).toBe(1);

      now += 1;
      state.toolkits = toolkits(2, 'new');
      await restarted.read(provider, DIGEST, signal());
      await vi.waitFor(async () => {
        const read = await restarted.read(provider, DIGEST, signal());
        expect(read.status === 'ok' && read.toolkits[0]!.slug).toBe('new-000');
      });
      expect(MANAGED_CATALOG_KEEPING).toMatchObject({ onDisk: true });
    });

    it('never keeps a raw MCP list, and reads it under the caller signal', async () => {
      const { provider, state, listToolkitPage } = countingProvider(
        toolkits(2),
        RAW_MCP_PROVIDER_TYPE
      );
      const cache = new ConnectorCatalogCache({ dir, now: clock });
      const reader = signal();

      await cache.read(provider, DIGEST, reader);
      await cache.read(provider, DIGEST, reader);

      expect(state.listings).toBe(2);
      expect(listToolkitPage.mock.calls[0]![0].signal).toBe(reader);
      expect(await fs.readdir(dir)).toEqual([]);
    });
  });
});

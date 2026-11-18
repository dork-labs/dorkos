/**
 * A new package source is a new place code can come from, so adding one waits
 * for the owner to confirm it's them (DOR-4355). Removing one stays immediate,
 * and both still happen only at this computer.
 *
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMarketplaceRoutes, type MarketplaceRouteDeps } from '../marketplace.js';
import { MarketplaceSourceManager } from '../../services/marketplace/sources/marketplace-source-manager.js';
import { MarketplaceCache } from '../../services/marketplace/cache/marketplace-cache.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const SOURCE = 'https://northwind.example.test/packages';

describe('package source confirmation', () => {
  const dorkHome = mkdtempSync(join(tmpdir(), 'marketplace-source-step-up-'));
  const sourceManager = new MarketplaceSourceManager(dorkHome);
  const add = vi.spyOn(sourceManager, 'add');
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/marketplace',
      routes: createMarketplaceRoutes({
        dorkHome,
        sourceManager,
        cache: new MarketplaceCache(dorkHome),
        fetcher: { fetchMarketplaceJson: vi.fn(async () => ({ name: 'northwind', plugins: [] })) },
        updateFlow: { clearMemos: vi.fn() },
        capabilityRegistry: () => undefined,
        onPluginsChanged: vi.fn(),
      } as unknown as MarketplaceRouteDeps),
    },
  ]);
  afterAll(() => rmSync(dorkHome, { recursive: true, force: true }));
  beforeEach(() => {
    add.mockClear();
  });

  const names = async (): Promise<string[]> =>
    (await owner.call('get', '/api/marketplace/sources')).body.sources.map(
      (s: { name: string }) => s.name
    );

  it('holds adding a source', async () => {
    const held = await owner
      .call('post', '/api/marketplace/sources')
      .send({ name: 'northwind', source: SOURCE, enabled: false });
    expect(held.status).toBe(428);
    expect(add).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, 'direct', true)).body.code).toBe(
      'not-your-action'
    );
    expect(add).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId)).body).toMatchObject({
      ok: true,
      status: 201,
    });
    expect(add).toHaveBeenCalledOnce();
    expect(await names()).toContain('northwind');
  });

  it('answers a name already taken before asking anyone', async () => {
    await sourceManager.add({ name: 'northwind-taken', source: SOURCE, enabled: false });
    const res = await owner
      .call('post', '/api/marketplace/sources')
      .send({ name: 'northwind-taken', source: SOURCE });
    expect(res.status).toBe(409);
    expect(res.body.heldActionId).toBeUndefined();
  });

  it('keeps adding one away from this computer refused', async () => {
    const res = await owner
      .call('post', '/api/marketplace/sources', 'own-tunnel')
      .send({ name: 'northwind-remote', source: SOURCE });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
  });

  it('removes a source at once', async () => {
    await sourceManager.add({ name: 'northwind-old', source: SOURCE, enabled: false });
    const res = await owner.call('delete', '/api/marketplace/sources/northwind-old');
    expect(res.status).toBe(204);
    expect(await names()).not.toContain('northwind-old');
  });
});

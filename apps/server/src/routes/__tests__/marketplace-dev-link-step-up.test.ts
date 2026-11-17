/**
 * A person's dev link runs code from a folder on this computer, so it waits for
 * the owner to confirm it's them (DOR-4355). Unlinking stays immediate.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import { createMarketplaceRoutes, type MarketplaceRouteDeps } from '../marketplace.js';
import { ApprovalService } from '../../services/core/approvals/index.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../services/core/capabilities/index.js';
import { marketplaceDomain } from '../../services/marketplace-mcp/marketplace-capabilities.js';
import type { MarketplaceMcpDeps } from '../../services/marketplace-mcp/marketplace-mcp-tools.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const FOLDER = '/made-up/work/northwind-pack';
const STATUS = { name: 'northwind-pack', state: 'active', path: FOLDER };

describe('dev link confirmation', () => {
  const devLinks = {
    list: vi.fn(async () => ({ links: [] })),
    preview: vi.fn(),
    describeApproval: vi.fn(async () => 'Runs northwind-pack from its folder.'),
    link: vi.fn(async () => STATUS),
    unlink: vi.fn(async () => STATUS),
  };
  const registry = composeRegistry([marketplaceDomain], {
    logger: noopLogger,
    marketplaceDeps: {} as MarketplaceMcpDeps,
  });
  const approvals = new ApprovalService(createTestDb());
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/marketplace',
      routes: createMarketplaceRoutes({
        dorkHome: '/made-up/dork-home',
        capabilityRegistry: () => registry,
        onPluginsChanged: vi.fn(),
        devLinks,
      } as unknown as MarketplaceRouteDeps),
    },
  ]);
  beforeAll(() => initCapabilityTierGate({ approvals }));
  afterAll(() => resetCapabilityTierGate());
  beforeEach(() => {
    devLinks.link.mockClear();
    devLinks.unlink.mockClear();
  });

  it.each(['direct', 'own-tunnel'] as const)('holds a person’s link from %s', async (via) => {
    const held = await owner.call('post', '/api/marketplace/dev-links', via).send({
      path: FOLDER,
      scope: 'global',
      expectedChange: 'Runs northwind-pack from its folder.',
    });
    expect(held.status).toBe(428);
    expect(devLinks.link).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(devLinks.link).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      ok: true,
      status: 201,
    });
    expect(devLinks.link).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ path: FOLDER, scope: 'global', via: 'app' })
    );
  });

  it('unlinks at once', async () => {
    const res = await owner
      .call('post', '/api/marketplace/dev-links/northwind-pack/unlink', 'own-tunnel')
      .send({ scope: 'global' });
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(devLinks.unlink).toHaveBeenCalledOnce();
  });
});

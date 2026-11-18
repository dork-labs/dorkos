import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiEnv } from '../../http/api-chain.js';
import type { ExtensionManager } from '../../services/extensions/extension-manager.js';
import { registerTrustedSourceRoutes } from '../extensions-trusted-sources.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('trusted source confirmation', () => {
  const trustSource = vi.fn(async () => 'added' as const);
  const untrustSource = vi.fn(async () => true);
  const owner = frontDoorStepUpHarness(() => {
    const routes = new Hono<ApiEnv>();
    registerTrustedSourceRoutes(routes, {
      trustSource,
      untrustSource,
    } as unknown as ExtensionManager);
    return [{ path: '/api/extensions', routes }];
  });
  beforeEach(() => vi.clearAllMocks());

  it.each(['direct', 'own-tunnel', 'managed'] as const)('holds trusting from %s', async (via) => {
    const held = await owner
      .call('post', '/api/extensions/trusted-sources', via)
      .send({ source: 'northwind/tools' });
    expect(held.status).toBe(428);
    expect(trustSource).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(trustSource).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(trustSource).toHaveBeenCalledWith('northwind/tools');
  });
  it('keeps the Wi-Fi refusal', async () => {
    expect(
      (
        await owner
          .call('post', '/api/extensions/trusted-sources', 'wifi')
          .send({ source: 'northwind/tools' })
      ).status
    ).toBe(403);
    expect(trustSource).not.toHaveBeenCalled();
  });
  it('does not hold removing trust', async () => {
    expect(
      (
        await owner
          .call('delete', '/api/extensions/trusted-sources', 'own-tunnel')
          .send({ source: 'northwind/tools' })
      ).status
    ).toBe(200);
    expect(untrustSource).toHaveBeenCalledWith('northwind/tools');
  });
});

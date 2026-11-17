/**
 * Security S7 on DOR-4355 M3: turning a chat connection back on lets its people
 * reach your agents again, so the owner confirms it's them first, and no agent
 * turns one on over HTTP. One that is already on answers at once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterManager } from '../../services/relay/adapter-manager.js';
import { createAdapterRoutes } from '../relay-adapters.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const adapter = vi.hoisted(() => ({ enabled: false }));
const manager = {
  enable: vi.fn(async () => undefined),
  resolveAdapterName: vi.fn(() => 'Northwind Telegram'),
  getAdapter: vi.fn(() => ({
    config: { id: 'tg', type: 'telegram', enabled: adapter.enabled, config: {} },
    status: { state: adapter.enabled ? 'connected' : 'disabled' },
  })),
  getManifest: vi.fn(() => undefined),
};
const owner = frontDoorStepUpHarness(() => [
  {
    path: '/api/relay',
    routes: createAdapterRoutes({ adapterManager: manager as unknown as AdapterManager }),
  },
]);

beforeEach(() => {
  adapter.enabled = false;
  manager.enable.mockClear();
});

describe('turning a chat connection back on', () => {
  it('holds the owner’s enable, names the connection, and runs it once confirmed', async () => {
    const held = await owner.call('post', '/api/relay/adapters/tg/enable', 'own-tunnel');
    expect(held.status).toBe(428);
    expect(manager.enable).not.toHaveBeenCalled();
    const view = await owner.call('get', `/api/step-up/${held.body.heldActionId}`, 'own-tunnel');
    expect(view.body.reason).toBe(
      'Turn “Northwind Telegram” back on, so its people can reach your agents again.'
    );
    const done = await owner.confirm(held.body.heldActionId, 'own-tunnel');
    expect(done.body).toMatchObject({ ok: true, status: 200 });
    expect(manager.enable).toHaveBeenCalledExactlyOnceWith('tg');
  });

  it('refuses an agent it cannot identify, and turns nothing on', async () => {
    const res = await owner
      .call('post', '/api/relay/adapters/tg/enable', 'own-tunnel')
      .set('X-DorkOS-Agent', 'made-up-unknown-token');
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(manager.enable).not.toHaveBeenCalled();
  });

  it('answers at once for a connection that is already on', async () => {
    adapter.enabled = true;
    const res = await owner.call('post', '/api/relay/adapters/tg/enable', 'own-tunnel');
    expect(res.status).toBe(200);
    expect(manager.enable).toHaveBeenCalledExactlyOnceWith('tg');
  });
});

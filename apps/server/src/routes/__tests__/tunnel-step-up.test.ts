import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import tunnelRouter from '../tunnel.js';
import { tunnelManager } from '../../services/core/tunnel-manager.js';
import { configManager } from '../../services/core/config-manager.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

describe('tunnel confirmation', () => {
  const owner = frontDoorStepUpHarness(() => [{ path: '/api/tunnel', routes: tunnelRouter }]);
  beforeEach(() => {
    configManager.set('tunnel', {
      ...configManager.get('tunnel'),
      enabled: false,
      authtoken: 'made-up-ngrok-token',
    });
    vi.spyOn(tunnelManager, 'start').mockResolvedValue('https://northwind.example.test');
    vi.spyOn(tunnelManager, 'stopOwnTunnel').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['direct', 'own-tunnel', 'managed'] as const)('holds opening from %s', async (via) => {
    const held = await owner.call('post', '/api/tunnel/start', via).send({});
    expect(held.status).toBe(428);
    expect(tunnelManager.start).not.toHaveBeenCalled();
    expect(configManager.get('tunnel').enabled).toBe(false);
    expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
      'not-your-action'
    );
    expect(tunnelManager.start).not.toHaveBeenCalled();
    expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
      ok: true,
      status: 200,
    });
    expect(tunnelManager.start).toHaveBeenCalledOnce();
    expect(configManager.get('tunnel').enabled).toBe(true);
  });
  it('refuses a tunnel whose settings changed while held', async () => {
    const held = await owner.call('post', '/api/tunnel/start').send({});
    expect(held.status).toBe(428);
    configManager.set('tunnel', { ...configManager.get('tunnel'), authtoken: 'made-up-new-token' });
    const confirmed = await owner.confirm(held.body.heldActionId);
    expect(confirmed.body).toMatchObject({
      status: 409,
      result: { code: 'TUNNEL_SETTINGS_CHANGED' },
    });
    expect(tunnelManager.start).not.toHaveBeenCalled();
    expect(configManager.get('tunnel').enabled).toBe(false);
  });
  it('keeps the Wi-Fi refusal', async () => {
    expect((await owner.call('post', '/api/tunnel/start', 'wifi').send({})).status).toBe(403);
    expect(tunnelManager.start).not.toHaveBeenCalled();
  });
  it('does not hold stopping the tunnel', async () => {
    expect((await owner.call('post', '/api/tunnel/stop', 'own-tunnel').send({})).status).toBe(200);
    expect(tunnelManager.stopOwnTunnel).toHaveBeenCalledOnce();
  });
});

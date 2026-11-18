/**
 * Saving a key DorkOS uses to reach apps waits for the owner to confirm it's
 * them (DOR-4355). Removing one stays immediate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorProviderBootstrapper } from '../../services/connectors/bootstrap.js';
import type { CredentialStore } from '../../services/core/credential-provider.js';
import { createConnectorProvidersRoutes } from '../connector-providers.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const SECRET = 'made-up-northwind-composio-key';
const PATH = '/api/connectors/providers/composio/credential';

describe('provider key confirmation', () => {
  const bootstrapper = {
    migrationHealth: () => ({ status: 'ready', migrated: false }),
    credentialNameFor: (provider: string) =>
      provider === 'composio' ? 'composio.apiKey' : undefined,
    reload: vi.fn(async (provider: string) => ({ type: provider, configured: true })),
    listStatuses: async () => [],
    appConnections: async () => ({ ways: [] }),
  };
  const store = {
    put: vi.fn(async (name: string) => `file:${name}`),
    get: vi.fn(async () => null),
    delete: vi.fn(async () => undefined),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/connectors/providers',
      routes: createConnectorProvidersRoutes({
        bootstrapper: bootstrapper as unknown as ConnectorProviderBootstrapper,
        credentialStore: store as unknown as CredentialStore,
      }),
    },
  ]);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds saving one from %s, without the key in what it holds',
    async (via) => {
      const held = await owner.call('put', PATH, via).send({ secret: SECRET });
      expect(held.status).toBe(428);
      expect(JSON.stringify(held.body)).not.toContain(SECRET);
      expect(store.put).not.toHaveBeenCalled();
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(store.put).not.toHaveBeenCalled();
      const confirmed = await owner.confirm(held.body.heldActionId, via);
      expect(confirmed.body).toMatchObject({
        ok: true,
        status: 200,
        result: { type: 'composio', configured: true },
      });
      expect(JSON.stringify(confirmed.body)).not.toContain(SECRET);
      expect(store.put).toHaveBeenCalledExactlyOnceWith('composio.apiKey', SECRET);
      expect(bootstrapper.reload).toHaveBeenCalledExactlyOnceWith('composio');
    }
  );

  it('keeps saving one from Wi-Fi refused', async () => {
    const res = await owner.call('put', PATH, 'wifi').send({ secret: SECRET });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('answers an unknown provider before holding anything', async () => {
    const res = await owner
      .call('put', '/api/connectors/providers/gmail/credential', 'own-tunnel')
      .send({ secret: SECRET });
    expect(res.status).toBe(400);
    expect(res.body.heldActionId).toBeUndefined();
  });

  it('removes one at once', async () => {
    const res = await owner.call('delete', PATH, 'own-tunnel');
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(store.delete).toHaveBeenCalledExactlyOnceWith('composio.apiKey');
  });
});

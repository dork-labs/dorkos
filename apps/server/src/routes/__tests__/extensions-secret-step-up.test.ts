/**
 * A person saving an extension's secret waits for the owner to confirm it's
 * them (DOR-4355). Removing one stays immediate, and the value never rides in
 * the held action.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { createExtensionsRoutes } from '../extensions.js';
import { resetHeldStepUpsForTests } from '../../services/core/auth/step-up/step-up-holds.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const SECRET = 'made-up-northwind-key-0001';
const RECORD = {
  id: 'northwind-tool',
  manifest: {
    id: 'northwind-tool',
    name: 'Northwind Tool',
    version: '1.0.0',
    serverCapabilities: { secrets: [{ key: 'api_key', label: 'API key' }] },
  },
  status: 'compiled',
  scope: 'global',
  origin: 'user',
  path: '/made-up/extensions/northwind-tool',
  bundleReady: true,
  hasServerEntry: true,
  hasDataProxy: false,
};

describe('extension secret confirmation', () => {
  const dorkHome = mkdtempSync(path.join(tmpdir(), 'extension-secret-step-up-'));
  const secrets = () => new ExtensionSecretStore('northwind-tool', dorkHome);
  const manager = {
    get: vi.fn(() => RECORD),
    listPublic: vi.fn(() => []),
    listShadowedPublic: vi.fn(() => []),
  };
  const owner = frontDoorStepUpHarness(() => [
    {
      path: '/api/extensions',
      routes: createExtensionsRoutes({
        manager: manager as unknown as Parameters<typeof createExtensionsRoutes>[0]['manager'],
        dorkHome,
        getCwd: () => null,
      }),
    },
  ]);
  afterAll(() => rmSync(dorkHome, { recursive: true, force: true }));
  beforeEach(async () => {
    resetHeldStepUpsForTests();
    await secrets().delete('api_key');
  });

  it.each(['direct', 'own-tunnel', 'managed'] as const)(
    'holds saving a secret from %s until the owner confirms it',
    async (via) => {
      const url = '/api/extensions/northwind-tool/secrets/api_key';
      const held = await owner.call('put', url, via).send({ value: SECRET });
      expect(held.status).toBe(428);
      expect(JSON.stringify(held.body)).not.toContain(SECRET);
      expect(await secrets().has('api_key')).toBe(false);
      expect((await owner.confirm(held.body.heldActionId, via, true)).body.code).toBe(
        'not-your-action'
      );
      expect(await secrets().has('api_key')).toBe(false);
      expect((await owner.confirm(held.body.heldActionId, via)).body).toMatchObject({
        ok: true,
        status: 200,
      });
      expect(await secrets().get('api_key')).toBe(SECRET);
    }
  );

  it('keeps saving a secret from Wi-Fi refused', async () => {
    const res = await owner
      .call('put', '/api/extensions/northwind-tool/secrets/api_key', 'wifi')
      .send({ value: SECRET });
    expect(res.status).toBe(403);
    expect(res.body.heldActionId).toBeUndefined();
    expect(await secrets().has('api_key')).toBe(false);
  });

  it('removes a secret at once', async () => {
    await secrets().set('api_key', SECRET);
    const res = await owner
      .call('delete', '/api/extensions/northwind-tool/secrets/api_key', 'own-tunnel')
      .send();
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(await secrets().has('api_key')).toBe(false);
  });
});

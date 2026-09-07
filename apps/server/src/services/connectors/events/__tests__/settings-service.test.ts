import { createHmac } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations } from '@dorkos/db';
import {
  EncryptedFileCredentialStore,
  type CredentialProvider,
} from '../../../core/credential-provider.js';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorRegistry } from '../../registry.js';
import { ConnectorProviderBootstrapper } from '../../bootstrap.js';
import { COMPOSIO_API_KEY_REF } from '../../providers/composio.js';
import type { ComposioHttpClient } from '../../providers/composio-client.js';
import { legacyDefaultProviderInstanceId } from '../../legacy-connection-migration.js';
import { ConnectorEventSettingsService } from '../settings-service.js';

const owner = { kind: 'local_install', installationId: 'owner-event-settings' } as const;
const providerId = legacyDefaultProviderInstanceId('composio');
const disposers: Array<() => void> = [];
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dork-event-settings-'));
  const db = createDb(':memory:');
  runMigrations(db);
  disposers.push(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const secrets = new EncryptedFileCredentialStore(dir);
  const credentials: CredentialProvider = {
    async resolve(ref) {
      const value = ref.startsWith('file:') ? await secrets.get(ref.slice(5)) : null;
      return value
        ? { ok: true, secret: value }
        : { ok: false, reason: 'unresolved', ref, message: 'Absent' };
    },
  };
  await secrets.put(COMPOSIO_API_KEY_REF.slice(5), 'synthetic-project-key-no-network');
  const registry = new ConnectorRegistry({
    db,
    configuredOwner: { ownerKind: owner.kind, ownerId: owner.installationId },
  });
  const listConnectedAccounts = vi.fn(async () => []);
  const client: ComposioHttpClient = {
    keyKind: () => 'project',
    listConnectedAccounts,
    listToolkits: async () => [],
    initiateConnection: async () => {
      throw new Error('unused');
    },
    getConnectionState: async () => {
      throw new Error('unused');
    },
    deleteConnectedAccount: async () => {},
  };
  const settings = new ConnectorEventSettingsService(db, credentials, secrets, async () => {
    await bootstrap.reload('composio');
  });
  const bootstrap = new ConnectorProviderBootstrapper({
    registry,
    credentials,
    nangoEnv: () => ({}),
    rawMcpServers: () => [],
    makeComposioClient: () => client,
    composioWebhookSecretRef: () => settings.webhookSecretRef(providerId),
  });
  await bootstrap.registerBootProviders();
  return { db, dir, registry, bootstrap, settings, secrets, credentials, listConnectedAccounts };
}
function signature(secret: string) {
  const raw =
    '{"trigger_name":"GMAIL_NEW_MESSAGE","connection_id":"ca_exact","trigger_id":"tr_exact","payload":{"subject":"private"},"log_id":"log"}';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const id = 'msg_settings';
  return {
    rawBody: Buffer.from(raw),
    webhookId: id,
    webhookTimestamp: timestamp,
    webhookSignature: `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${raw}`).digest('base64')}`,
  };
}
describe('production BYO signing and separate payload settings', () => {
  it('derives setup mode from private provider type without advertising delivery readiness', async () => {
    const f = await fixture();
    expect(
      f.registry
        .resolveProviderInstance(ConnectorProviderInstanceIdSchema.parse(providerId))
        ?.getCapabilities().capabilities.triggers
    ).toEqual({ status: 'available' });
    expect(f.settings.describe(owner, providerId)).toEqual({
      setupMode: 'byo_webhook',
      configured: false,
      endpoint: null,
      reason: null,
    });
    f.db.$client.prepare("UPDATE connector_provider_instances SET type = 'nango'").run();
    expect(f.settings.describe(owner, providerId)).toEqual({
      setupMode: 'unavailable',
      configured: false,
      endpoint: null,
      reason: 'Notifications are not available for this service.',
    });
    await expect(
      f.settings.configure(owner, providerId, {
        webhookSecret: 'synthetic-secret-value',
        publicOrigin: 'https://instance.example',
      })
    ).rejects.toMatchObject({ code: 'events_unavailable' });
    f.db.$client
      .prepare("UPDATE connector_provider_instances SET type = 'dorkos-managed', mode = 'managed'")
      .run();
    expect(f.settings.describe(owner, providerId)).toEqual({
      setupMode: 'managed',
      configured: false,
      endpoint: null,
      reason: null,
    });
  });
  it('reloads the actual registered verifier from the encrypted owner setting without changing execution generation', async () => {
    const f = await fixture();
    const secret = 'synthetic-signing-secret-one';
    const generation = f.db.$client
      .prepare('SELECT execution_config_generation FROM connector_provider_instances WHERE id = ?')
      .get(providerId);
    expect(
      (await f.registry.resolveProvider('composio')!.events!.verifyWebhook(signature(secret)))
        .status
    ).toBe('rejected');
    expect(
      await f.settings.configure(owner, providerId, {
        webhookSecret: secret,
        publicOrigin: 'https://event-instance.example',
      })
    ).toEqual({
      setupMode: 'byo_webhook',
      reason: null,
      configured: true,
      endpoint: `https://event-instance.example/api/connectors/webhooks/${providerId}`,
    });
    expect(
      (await f.registry.resolveProvider('composio')!.events!.verifyWebhook(signature(secret)))
        .status
    ).toBe('verified');
    expect(
      f.db.$client
        .prepare(
          'SELECT execution_config_generation FROM connector_provider_instances WHERE id = ?'
        )
        .get(providerId)
    ).toEqual(generation);
    const second = 'synthetic-signing-secret-two';
    await f.settings.configure(owner, providerId, {
      webhookSecret: second,
      publicOrigin: 'https://event-instance.example',
    });
    expect(
      (await f.registry.resolveProvider('composio')!.events!.verifyWebhook(signature(secret)))
        .status
    ).toBe('rejected');
    expect(
      (await f.registry.resolveProvider('composio')!.events!.verifyWebhook(signature(second)))
        .status
    ).toBe('verified');
    expect(f.listConnectedAccounts).toHaveBeenCalledTimes(3);
    const files = readdirSync(f.dir, { recursive: true, withFileTypes: true }).filter((item) =>
      item.isFile()
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(readFileSync(join(file.parentPath, file.name), 'utf8')).not.toContain(second);
  });
  it('retains independent payload keys across signing rotation and service restart', async () => {
    const f = await fixture();
    const first = await f.settings.resolve(providerId);
    expect(first).toBeDefined();
    const scope = {
      providerInstanceId: providerId,
      subscriptionId: 'sub',
      providerEventId: 'event',
      expiresAt: '2026-09-14T12:00:00.000Z',
    };
    const content = { version: 1 as const, title: 'Notice', text: 'protected content' };
    const encrypted = first!.protect(content, scope);
    await f.settings.configure(owner, providerId, {
      webhookSecret: 'synthetic-signing-secret',
      publicOrigin: 'https://event-instance.example',
    });
    const restarted = new ConnectorEventSettingsService(
      f.db,
      f.credentials,
      f.secrets,
      async () => {}
    );
    expect(
      (await restarted.resolve(providerId))!.reveal(
        encrypted,
        scope,
        Date.parse('2026-09-07T12:00:00.000Z')
      )
    ).toEqual(content);
    expect(JSON.stringify(restarted.describe(owner, providerId))).not.toContain('file:');
  });
  it('refuses a different owner before a credential write and drops old-owner references on replacement', async () => {
    const f = await fixture();
    const put = vi.spyOn(f.secrets, 'put');
    await expect(
      f.settings.configure({ kind: 'local_install', installationId: 'other' }, providerId, {
        webhookSecret: 'synthetic-signing-secret',
        publicOrigin: 'https://event-instance.example',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(put).not.toHaveBeenCalled();
    await f.settings.configure(owner, providerId, {
      webhookSecret: 'synthetic-signing-secret',
      publicOrigin: 'https://event-instance.example',
    });
    f.db.$client
      .prepare("UPDATE connector_provider_instances SET owner_id = 'replacement' WHERE id = ?")
      .run(providerId);
    expect(f.settings.webhookSecretRef(providerId)).toBeUndefined();
    expect(
      f.settings.describe({ kind: 'local_install', installationId: 'replacement' }, providerId)
    ).toEqual({ setupMode: 'byo_webhook', configured: false, endpoint: null, reason: null });
  });
  it.each([
    'http://event-instance.example',
    'https://event-instance.example/not-origin',
    'https://event-instance.example?secret=yes',
  ])('refuses unsafe callback origin %s before secret storage', async (publicOrigin) => {
    const f = await fixture();
    const put = vi.spyOn(f.secrets, 'put');
    await expect(
      f.settings.configure(owner, providerId, {
        webhookSecret: 'synthetic-signing-secret',
        publicOrigin,
      })
    ).rejects.toMatchObject({ code: 'events_unavailable' });
    expect(put).not.toHaveBeenCalled();
  });
});

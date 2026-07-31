import { describe, it, expect, beforeEach } from 'vitest';
import type { AdapterConfig } from '@dorkos/relay';
import { TELEGRAM_MANIFEST, SLACK_MANIFEST, WEBHOOK_MANIFEST } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  CredentialProvider,
  CredentialResolution,
  CredentialStore,
} from '../../core/credential-provider.js';
import {
  materializeAdapterSecrets,
  resolveAdapterSecrets,
  deleteAdapterSecrets,
  secretFieldKeys,
} from '../adapter-secrets.js';
import { maskSensitiveFields } from '../adapter-config.js';

/** In-memory {@link CredentialStore} that mimics the `file:` scheme. */
class FakeCredentialStore implements CredentialStore {
  readonly secrets = new Map<string, string>();
  async put(name: string, secret: string): Promise<string> {
    this.secrets.set(name, secret);
    return `file:${name}`;
  }
  async get(name: string): Promise<string | null> {
    return this.secrets.get(name) ?? null;
  }
  async delete(name: string): Promise<void> {
    this.secrets.delete(name);
  }
}

/** {@link CredentialProvider} backed by a {@link FakeCredentialStore}'s `file:` entries. */
class FakeCredentialProvider implements CredentialProvider {
  constructor(private readonly store: FakeCredentialStore) {}
  async resolve(ref: string): Promise<CredentialResolution> {
    const [scheme, value] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    if (scheme !== 'file') {
      return { ok: false, reason: 'unavailable', ref, message: `unsupported scheme ${scheme}` };
    }
    const secret = await this.store.get(value);
    if (secret == null) {
      return { ok: false, reason: 'unresolved', ref, message: `no secret named ${value}` };
    }
    return { ok: true, secret };
  }
}

const manifests = new Map<string, AdapterManifest>([
  ['telegram', TELEGRAM_MANIFEST],
  ['slack', SLACK_MANIFEST],
]);

function telegramConfig(token: string): AdapterConfig {
  return { id: 'telegram-1', type: 'telegram', enabled: true, config: { token } } as AdapterConfig;
}

describe('secretFieldKeys', () => {
  it('returns the password field keys for a known adapter type', () => {
    expect(secretFieldKeys(TELEGRAM_MANIFEST)).toContain('token');
  });

  it('returns an empty list for an unknown manifest', () => {
    expect(secretFieldKeys(undefined)).toEqual([]);
  });
});

describe('materializeAdapterSecrets — migration', () => {
  let store: FakeCredentialStore;
  beforeEach(() => {
    store = new FakeCredentialStore();
  });

  it('moves a cleartext bot token into the store and rewrites it as a file: reference', async () => {
    const configs = [telegramConfig('123:SECRET-BOT-TOKEN')];

    const changed = await materializeAdapterSecrets(configs, { store, manifests });

    expect(changed).toBe(true);
    const token = (configs[0].config as { token: string }).token;
    // The on-disk value is now a reference, not the raw token.
    expect(token).toBe('file:relay-adapter-telegram-1-token');
    // The real secret lives only in the encrypted store.
    expect(store.secrets.get('relay-adapter-telegram-1-token')).toBe('123:SECRET-BOT-TOKEN');
  });

  it('is idempotent — a value that is already a reference is left untouched', async () => {
    const configs = [telegramConfig('file:relay-adapter-telegram-1-token')];

    const changed = await materializeAdapterSecrets(configs, { store, manifests });

    expect(changed).toBe(false);
    expect(store.secrets.size).toBe(0);
  });

  it('leaves a user-supplied env: reference in place (power-user opt-in)', async () => {
    const configs = [telegramConfig('env:TELEGRAM_BOT_TOKEN')];

    const changed = await materializeAdapterSecrets(configs, { store, manifests });

    expect(changed).toBe(false);
    expect((configs[0].config as { token: string }).token).toBe('env:TELEGRAM_BOT_TOKEN');
  });

  it('materializes every password field on a multi-secret adapter (Slack)', async () => {
    const configs = [
      {
        id: 'slack-1',
        type: 'slack',
        enabled: true,
        config: { botToken: 'xoxb-raw', appToken: 'xapp-raw', signingSecret: 'sign-raw' },
      } as AdapterConfig,
    ];

    await materializeAdapterSecrets(configs, { store, manifests });

    const cfg = configs[0].config as Record<string, string>;
    expect(cfg.botToken).toBe('file:relay-adapter-slack-1-botToken');
    expect(cfg.appToken).toBe('file:relay-adapter-slack-1-appToken');
    expect(cfg.signingSecret).toBe('file:relay-adapter-slack-1-signingSecret');
    expect(store.secrets.get('relay-adapter-slack-1-botToken')).toBe('xoxb-raw');
  });

  it('does nothing for an adapter type with no secret fields', async () => {
    const configs = [
      {
        id: 'cc',
        type: 'claude-code',
        enabled: true,
        config: { maxConcurrent: 3 },
      } as AdapterConfig,
    ];

    const changed = await materializeAdapterSecrets(configs, { store, manifests });

    expect(changed).toBe(false);
  });
});

describe('resolveAdapterSecrets — point of use', () => {
  let store: FakeCredentialStore;
  let provider: FakeCredentialProvider;
  beforeEach(() => {
    store = new FakeCredentialStore();
    provider = new FakeCredentialProvider(store);
  });

  it('resolves a file: reference back to the real token without persisting it', async () => {
    await store.put('relay-adapter-telegram-1-token', '123:SECRET-BOT-TOKEN');
    const stored = telegramConfig('file:relay-adapter-telegram-1-token');

    const resolved = await resolveAdapterSecrets(stored, { provider, manifests });

    expect((resolved.config as { token: string }).token).toBe('123:SECRET-BOT-TOKEN');
    // The input config is not mutated — the reference stays on the stored copy.
    expect((stored.config as { token: string }).token).toBe('file:relay-adapter-telegram-1-token');
  });

  it('passes a cleartext value through unchanged (transient test config)', async () => {
    const resolved = await resolveAdapterSecrets(telegramConfig('123:raw'), {
      provider,
      manifests,
    });
    expect((resolved.config as { token: string }).token).toBe('123:raw');
  });

  it('throws a descriptive, secret-free error for a dangling reference', async () => {
    const stored = telegramConfig('file:relay-adapter-telegram-1-token');
    await expect(resolveAdapterSecrets(stored, { provider, manifests })).rejects.toThrow(
      /Failed to resolve credential for adapter 'telegram-1' field 'token'/
    );
  });
});

describe('deleteAdapterSecrets — cleanup', () => {
  it('deletes only file: secrets, leaving user-owned env:/keychain: references alone', async () => {
    const store = new FakeCredentialStore();
    await store.put('relay-adapter-telegram-1-token', '123:SECRET');

    await deleteAdapterSecrets(telegramConfig('file:relay-adapter-telegram-1-token'), {
      store,
      manifests,
    });
    expect(store.secrets.has('relay-adapter-telegram-1-token')).toBe(false);

    // An env: reference is not ours to delete — no throw, nothing removed.
    await expect(
      deleteAdapterSecrets(telegramConfig('env:TELEGRAM_BOT_TOKEN'), { store, manifests })
    ).resolves.toBeUndefined();
  });
});

describe('a secret field that holds a MAP of secrets (webhook outbound headers)', () => {
  // `outbound.headers` is where an `Authorization: Bearer …` goes. Declared as
  // a plain textarea it was excluded from every secret-handling rule, so an API
  // key sat in `adapters.json` in the clear and came back on every read.

  let store: FakeCredentialStore;
  let webhookManifests: Map<string, AdapterManifest>;

  /** A webhook config with the given outbound headers. */
  function webhookConfig(headers: Record<string, string>): AdapterConfig {
    return {
      id: 'wh-1',
      type: 'webhook',
      enabled: true,
      config: {
        inbound: { subject: 'relay.webhook.wh-1', secret: 'inbound-secret-16-chars' },
        outbound: { url: 'https://example.com/hook', secret: 'outbound-secret-16-ch', headers },
      },
    } as AdapterConfig;
  }

  /** The headers block of a config, as stored. */
  function storedHeaders(config: AdapterConfig): Record<string, string> {
    return (config.config as { outbound: { headers: Record<string, string> } }).outbound.headers;
  }

  beforeEach(() => {
    store = new FakeCredentialStore();
    webhookManifests = new Map<string, AdapterManifest>([['webhook', WEBHOOK_MANIFEST]]);
  });

  it('is declared a secret field by the manifest', () => {
    expect(secretFieldKeys(WEBHOOK_MANIFEST)).toContain('outbound.headers');
  });

  it('moves every header value into the credential store', async () => {
    const config = webhookConfig({ Authorization: 'Bearer sk-live-abc', 'X-Trace': 'on' });

    const changed = await materializeAdapterSecrets([config], {
      store,
      manifests: webhookManifests,
    });

    expect(changed).toBe(true);
    expect(storedHeaders(config)).toEqual({
      Authorization: 'file:relay-adapter-wh-1-outbound-headers-Authorization',
      'X-Trace': 'file:relay-adapter-wh-1-outbound-headers-X-Trace',
    });
    // The value is in the encrypted store, not in the file.
    expect(store.secrets.get('relay-adapter-wh-1-outbound-headers-Authorization')).toBe(
      'Bearer sk-live-abc'
    );
    expect(JSON.stringify(config)).not.toContain('sk-live-abc');
  });

  it('resolves the references back for the adapter, in memory only', async () => {
    const config = webhookConfig({ Authorization: 'Bearer sk-live-abc' });
    await materializeAdapterSecrets([config], { store, manifests: webhookManifests });

    const resolved = await resolveAdapterSecrets(config, {
      provider: new FakeCredentialProvider(store),
      manifests: webhookManifests,
    });

    expect(storedHeaders(resolved)).toEqual({ Authorization: 'Bearer sk-live-abc' });
    // The stored config still holds only the reference.
    expect(storedHeaders(config).Authorization).toMatch(/^file:/);
  });

  it('leaves an already-migrated header alone', async () => {
    const config = webhookConfig({ Authorization: 'Bearer sk-live-abc' });
    await materializeAdapterSecrets([config], { store, manifests: webhookManifests });

    const changed = await materializeAdapterSecrets([config], {
      store,
      manifests: webhookManifests,
    });

    expect(changed).toBe(false);
  });

  it('deletes the stored header secrets when the adapter is removed', async () => {
    const config = webhookConfig({ Authorization: 'Bearer sk-live-abc', 'X-Key': 'k' });
    await materializeAdapterSecrets([config], { store, manifests: webhookManifests });

    await deleteAdapterSecrets(config, { store, manifests: webhookManifests });

    expect(store.secrets.size).toBe(0);
  });

  it('is masked out of an API read, like any other secret field', () => {
    const masked = maskSensitiveFields(
      {
        inbound: { subject: 's', secret: 'inbound-secret-16-chars' },
        outbound: { url: 'u', secret: 'x', headers: { Authorization: 'Bearer sk-live-abc' } },
      },
      WEBHOOK_MANIFEST
    );

    expect(JSON.stringify(masked)).not.toContain('sk-live-abc');
  });
});

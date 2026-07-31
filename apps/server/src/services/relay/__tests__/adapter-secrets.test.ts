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
import {
  maskSensitiveFields,
  mergeWithPasswordPreservation,
  parseAdapterConfigForPersist,
} from '../adapter-config.js';

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

describe('editing a webhook adapter without touching its headers', () => {
  // The wizard sends `'***'` back for any password field the person did not
  // retype. `updateConfig` merges BEFORE it validates, so the sentinel is
  // swapped for the stored value and never reaches the schema — which matters
  // here because the stored value is an object and `'***'` is a string.

  const stored = {
    inbound: { subject: 'relay.webhook.wh-1', secret: 'file:inbound-ref' },
    outbound: {
      url: 'https://example.com/hook',
      secret: 'file:outbound-ref',
      headers: { Authorization: 'file:relay-adapter-wh-1-outbound-headers-Authorization' },
    },
  };

  it('keeps the stored header references when the form sends the mask back', () => {
    const merged = mergeWithPasswordPreservation(
      stored,
      {
        inbound: { subject: 'relay.webhook.wh-1', secret: '***' },
        outbound: { url: 'https://example.com/hook', secret: '***', headers: '***' },
      },
      WEBHOOK_MANIFEST
    );

    expect(merged).toMatchObject({
      outbound: {
        headers: { Authorization: 'file:relay-adapter-wh-1-outbound-headers-Authorization' },
      },
    });
  });

  it('produces a config the webhook schema still accepts', () => {
    // The check that matters: after the merge, the entry validates. If the
    // sentinel survived to here the save would be refused.
    const merged = mergeWithPasswordPreservation(
      stored,
      { outbound: { url: 'https://example.com/hook', secret: '***', headers: '***' } },
      WEBHOOK_MANIFEST
    );

    const parsed = parseAdapterConfigForPersist(
      { id: 'wh-1', type: 'webhook', enabled: true, config: merged },
      WEBHOOK_MANIFEST
    );

    expect(parsed.config).toMatchObject({
      outbound: {
        headers: { Authorization: 'file:relay-adapter-wh-1-outbound-headers-Authorization' },
      },
    });
  });

  it('replaces them when the person actually types new headers', () => {
    const merged = mergeWithPasswordPreservation(
      stored,
      { outbound: { ...stored.outbound, headers: { Authorization: 'Bearer replaced' } } },
      WEBHOOK_MANIFEST
    );

    expect(merged).toMatchObject({ outbound: { headers: { Authorization: 'Bearer replaced' } } });
  });
});

describe('setting webhook custom headers through the form (DOR-796, server half)', () => {
  // A manifest field's key is a PATH (`outbound.headers`) while the config is
  // nested, and the form normalizer only ever matched top-level keys. So the
  // declared `valueShape` did nothing: the textarea's text reached the schema
  // as a string, failed it, and the save was refused. The field could not be
  // set at all — on create or on edit.

  /** What the wizard sends for a webhook: flat keys, textarea values as text. */
  function formEntry(config: Record<string, unknown>) {
    return { id: 'wh-1', type: 'webhook', enabled: true, builtin: false, config };
  }

  it('accepts headers typed as JSON text and stores them as an object', () => {
    const parsed = parseAdapterConfigForPersist(
      formEntry({
        inbound: { subject: 'relay.webhook.wh-1', secret: 'inbound-secret-16ch' },
        outbound: {
          url: 'https://example.com/hook',
          secret: 'outbound-secret-16c',
          headers: '{"Authorization": "Bearer sk-live-abc", "X-Trace": "on"}',
        },
      }),
      WEBHOOK_MANIFEST
    );

    expect(parsed.config).toMatchObject({
      outbound: { headers: { Authorization: 'Bearer sk-live-abc', 'X-Trace': 'on' } },
    });
  });

  it('refuses unparseable header text instead of silently dropping it', () => {
    expect(() =>
      parseAdapterConfigForPersist(
        formEntry({
          inbound: { subject: 's', secret: 'inbound-secret-16ch' },
          outbound: {
            url: 'https://example.com/hook',
            secret: 'outbound-secret-16c',
            headers: '{oops',
          },
        }),
        WEBHOOK_MANIFEST
      )
    ).toThrow(/expected JSON/);
  });

  it('treats a cleared field as no headers', () => {
    const parsed = parseAdapterConfigForPersist(
      formEntry({
        inbound: { subject: 's', secret: 'inbound-secret-16ch' },
        outbound: { url: 'https://example.com/hook', secret: 'outbound-secret-16c', headers: '' },
      }),
      WEBHOOK_MANIFEST
    );

    expect((parsed.config as { outbound: { headers: unknown } }).outbound.headers).toEqual({});
  });

  it('leaves the caller’s own object unmutated', () => {
    // The normalizer writes through copies; mutating the request body would
    // surprise every caller downstream of the route.
    const config = {
      inbound: { subject: 's', secret: 'inbound-secret-16ch' },
      outbound: {
        url: 'https://example.com/hook',
        secret: 'outbound-secret-16c',
        headers: '{"Authorization": "Bearer x"}',
      },
    };
    parseAdapterConfigForPersist(formEntry(config), WEBHOOK_MANIFEST);

    expect(config.outbound.headers).toBe('{"Authorization": "Bearer x"}');
  });

  it('round-trips: typed headers survive validation, encryption, and resolution', async () => {
    const store = new FakeCredentialStore();
    const manifests = new Map<string, AdapterManifest>([['webhook', WEBHOOK_MANIFEST]]);

    const parsed = parseAdapterConfigForPersist(
      formEntry({
        inbound: { subject: 'relay.webhook.wh-1', secret: 'inbound-secret-16ch' },
        outbound: {
          url: 'https://example.com/hook',
          secret: 'outbound-secret-16c',
          headers: '{"Authorization": "Bearer sk-live-abc"}',
        },
      }),
      WEBHOOK_MANIFEST
    );

    await materializeAdapterSecrets([parsed], { store, manifests });
    // At rest: a reference, not the key.
    expect(JSON.stringify(parsed)).not.toContain('sk-live-abc');

    const resolved = await resolveAdapterSecrets(parsed, {
      provider: new FakeCredentialProvider(store),
      manifests,
    });
    // In the adapter's hands: the real value.
    expect(resolved.config).toMatchObject({
      outbound: { headers: { Authorization: 'Bearer sk-live-abc' } },
    });
  });

  it('masks each header value, keeping the shape the schema declares', () => {
    // Replacing the whole object with the string '***' made GET
    // /api/relay/adapters lie about its own type. The header NAMES stay
    // readable — they are not secret, and they are what lets someone see which
    // headers are configured without being shown a value.
    const masked = maskSensitiveFields(
      {
        inbound: { subject: 's', secret: 'file:in' },
        outbound: {
          url: 'u',
          secret: 'file:out',
          headers: { Authorization: 'file:auth', 'X-Trace': 'file:trace' },
        },
      },
      WEBHOOK_MANIFEST
    );

    expect(masked).toMatchObject({
      outbound: { headers: { Authorization: '***', 'X-Trace': '***' } },
    });
  });

  it('treats a fully masked header object as untouched on save', () => {
    // A client echoing back a masked GET must not overwrite the real values
    // with the mask.
    const stored = {
      inbound: { subject: 's', secret: 'file:in' },
      outbound: { url: 'u', secret: 'file:out', headers: { Authorization: 'file:auth' } },
    };

    const merged = mergeWithPasswordPreservation(
      stored,
      { outbound: { url: 'u', secret: '***', headers: { Authorization: '***' } } },
      WEBHOOK_MANIFEST
    );

    expect(merged).toMatchObject({ outbound: { headers: { Authorization: 'file:auth' } } });
  });
});

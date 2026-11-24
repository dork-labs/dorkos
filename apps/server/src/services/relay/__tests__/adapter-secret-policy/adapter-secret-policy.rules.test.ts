/** DOR-3271, the rules themselves: assert, merge, resolve, delete. */
import {
  FakeProvider,
  FakeStore,
  freshCredentials,
  manifests,
  webhook,
  URL_A,
  URL_B,
} from './adapter-secret-policy.fixtures.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { TELEGRAM_MANIFEST, WEBHOOK_MANIFEST, type AdapterConfig } from '@dorkos/relay';
import { deleteAdapterSecrets, resolveAdapterSecrets } from '../../adapter-secrets.js';
import {
  assertSecretReferences,
  legacySecretKeyFor,
  mergeSecretUpdate,
  secretKeyFor,
} from '../../adapter-secret-policy.js';

let store: FakeStore;
let provider: FakeProvider;
beforeEach(() => {
  ({ store, provider } = freshCredentials());
});

describe('1. an adapter naming file:anthropic', () => {
  it('is refused at save, for a person too', () => {
    const config = webhook('wh', { secret: 'file:anthropic' }).config;
    for (const writer of ['person', 'agent'] as const) {
      expect(() => assertSecretReferences('wh', config, WEBHOOK_MANIFEST, writer)).toThrow(
        /outbound\.secret' names a stored secret\. Enter the secret itself/
      );
      // The form marks the field by its key (DOR-4979).
      expect(() => assertSecretReferences('wh', config, WEBHOOK_MANIFEST, writer)).toThrow(
        expect.objectContaining({ fields: ['outbound.secret'] })
      );
    }
  });

  it('is refused at resolve, before the store is read, in a header too', async () => {
    const config = webhook('wh', {
      secret: 'outbound-secret-16chars',
      headers: { Authorization: 'file:community:space-1:token' },
    });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, approved: 'any' })
    ).rejects.toThrow(/field 'outbound\.headers\.Authorization'.*belongs to something else/);
    expect(provider.asked).toEqual([]);
  });
});

describe('1b. names are exact, not prefixes', () => {
  it("adapter 'w-outbound' cannot resolve adapter 'w''s header entry", async () => {
    await store.put('relay-adapter:w:outbound.headers.Authorization', 'w-header');
    const config = webhook('w-outbound', {
      secret: 'outbound-secret-16chars',
      headers: { X: 'file:relay-adapter:w:outbound.headers.Authorization' },
    });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, approved: 'any' })
    ).rejects.toThrow(/belongs to something else/);
    await deleteAdapterSecrets(config, { store, manifests });
    expect(store.secrets.get('relay-adapter:w:outbound.headers.Authorization')).toBe('w-header');
  });

  it('a stored name sent back on a new address is refused, not carried', () => {
    const existing = webhook('w', {
      secret: 'file:relay-adapter:w:outbound.secret',
      headers: { Authorization: 'file:relay-adapter:w:outbound.headers.Authorization' },
    }).config;
    expect(() =>
      mergeSecretUpdate(
        'w',
        existing,
        {
          inbound: { subject: 'relay.webhook.w', secret: 'new-inbound-secret-16' },
          outbound: {
            url: URL_B,
            secret: 'new-outbound-secret-16',
            headers: { Authorization: 'file:relay-adapter:w:outbound.headers.Authorization' },
          },
        },
        WEBHOOK_MANIFEST,
        'person'
      )
    ).toThrow(/names a stored secret/);
  });
});

describe('2. an agent-written env: reference', () => {
  it('is refused when the headers arrive as JSON text', () => {
    const existing = webhook('w', { secret: 'file:relay-adapter:w:outbound.secret' }).config;
    for (const url of [URL_A, URL_B]) {
      expect(() =>
        mergeSecretUpdate(
          'w',
          existing,
          {
            outbound: {
              url,
              secret: 'new-outbound-secret-16',
              headers: '{"Authorization":"env:ANTHROPIC_API_KEY"}',
            },
          },
          WEBHOOK_MANIFEST,
          'agent'
        )
      ).toThrow(/outbound\.headers\.Authorization' uses an env: reference/);
    }
  });

  it('is refused at save', () => {
    const config = webhook('wh', { secret: 'env:ANTHROPIC_API_KEY' }).config;
    expect(() => assertSecretReferences('wh', config, WEBHOOK_MANIFEST, 'agent')).toThrow(
      /uses an env: reference, which only a person can set/
    );
    expect(() =>
      assertSecretReferences(
        'wh',
        { outbound: { headers: { 'X-Key': 'keychain:anything' } } },
        WEBHOOK_MANIFEST,
        'agent'
      )
    ).toThrow(/keychain: reference/);
  });

  it('is refused when an agent asks to test a connection with one', async () => {
    const config = webhook('wh', { secret: 'env:ANTHROPIC_API_KEY' });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, approved: new Map() })
    ).rejects.toThrow(/only a person can set/);
    expect(provider.asked).toEqual([]);
  });
});

describe('3. removing an adapter that names another entry', () => {
  it('leaves that entry alone and deletes only its own', async () => {
    await store.put('relay-adapter:wh:outbound.secret', 'own-secret');
    const config = webhook('wh', {
      secret: 'file:relay-adapter:wh:outbound.secret',
      headers: { Authorization: 'file:anthropic' },
    });
    await deleteAdapterSecrets(config, { store, manifests });
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
    expect(store.secrets.has('relay-adapter:wh:outbound.secret')).toBe(false);
  });
});

describe('4. a masked secret with a new URL', () => {
  const existing = webhook('wh', {
    secret: 'file:relay-adapter:wh:outbound.secret',
    headers: { Authorization: 'file:relay-adapter:wh:outbound.headers.Authorization' },
  }).config as Record<string, Record<string, unknown>>;

  it('is refused for everyone, a person included', () => {
    for (const writer of ['person', 'agent'] as const) {
      expect(() =>
        mergeSecretUpdate(
          'wh',
          existing,
          { outbound: { url: URL_B, secret: '***', headers: { Authorization: '***' } } },
          WEBHOOK_MANIFEST,
          writer
        )
      ).toThrow(/A new address needs its secrets entered again: Inbound Secret, Outbound Secret/);
    }
  });

  it('carries nothing stored to the new address, and keeps what was entered', () => {
    const merged = mergeSecretUpdate(
      'wh',
      existing,
      {
        inbound: { subject: 'relay.webhook.wh', secret: 'new-inbound-secret-16' },
        outbound: {
          url: URL_B,
          secret: 'new-outbound-secret-16',
          headers: { Authorization: '***' },
        },
      },
      WEBHOOK_MANIFEST,
      'person'
    );
    expect(merged.outbound).toEqual({ url: URL_B, secret: 'new-outbound-secret-16' });
    expect(JSON.stringify(merged)).not.toContain('file:');
    expect(existing.outbound).toMatchObject({ headers: { Authorization: expect.any(String) } });
  });

  it('keeps stored secrets when the address does not change', () => {
    const merged = mergeSecretUpdate(
      'wh',
      existing,
      { outbound: { url: URL_A, secret: '***', headers: { Authorization: '***' } } },
      WEBHOOK_MANIFEST,
      'agent'
    );
    expect(merged.outbound).toEqual(existing.outbound);
  });
});

describe('5 and 6. what still works', () => {
  it('editing a polling Telegram bot keeps its token (a blank webhook URL is no address)', () => {
    const existing = { token: 'file:relay-adapter:tg:token', mode: 'polling' };
    const merged = mergeSecretUpdate(
      'tg',
      existing,
      { token: '***', mode: 'polling', webhookUrl: '', respondMode: 'always' },
      TELEGRAM_MANIFEST,
      'person'
    );
    expect(merged.token).toBe('file:relay-adapter:tg:token');
  });

  it("resolves an existing adapter's own secrets", async () => {
    await store.put('relay-adapter:wh:outbound.secret', 'own-secret');
    const resolved = await resolveAdapterSecrets(
      webhook('wh', { secret: 'file:relay-adapter:wh:outbound.secret' }),
      { provider, manifests, approved: 'any' }
    );
    expect(resolved.config).toMatchObject({ outbound: { secret: 'own-secret' } });
  });

  it('saves and resolves a person-written env: or keychain: reference', async () => {
    const config = webhook('wh', {
      secret: 'env:ANTHROPIC_API_KEY',
      headers: { 'X-Key': 'keychain:my-key' },
    });
    expect(() =>
      assertSecretReferences('wh', config.config, WEBHOOK_MANIFEST, 'person')
    ).not.toThrow();
    const only = webhook('wh', { secret: 'env:ANTHROPIC_API_KEY' });
    const resolved = await resolveAdapterSecrets(only, {
      provider,
      manifests,
      approved: 'any',
    });
    expect(resolved.config).toMatchObject({ outbound: { secret: 'sk-ant-FROM-ENV' } });
  });
});

describe('S1: stored names cannot collide across connections', () => {
  it('names differ where the old hyphen form collided', () => {
    const a = secretKeyFor('hooks', 'outbound.headers.x-auth-token');
    const b = secretKeyFor('hooks-outbound-headers-x-auth', 'token');
    expect(a).not.toBe(b);
    expect(legacySecretKeyFor('hooks', 'outbound.headers.x-auth-token')).toBe(
      legacySecretKeyFor('hooks-outbound-headers-x-auth', 'token')
    );
  });

  it("connection 'hooks-outbound-headers-x-auth' cannot resolve 'hooks''s header", async () => {
    const victim = secretKeyFor('hooks', 'outbound.headers.x-auth-token');
    await store.put(victim, 'victim-token');
    const config = {
      id: 'hooks-outbound-headers-x-auth',
      type: 'telegram',
      enabled: true,
      config: { token: `file:${victim}`, mode: 'polling' },
    } as AdapterConfig;
    await expect(
      resolveAdapterSecrets(config, {
        provider,
        manifests: new Map([['telegram', TELEGRAM_MANIFEST]]),
        approved: 'any',
      })
    ).rejects.toThrow(/belongs to something else/);
  });
});

/**
 * DOR-3271: an adapter's secret references resolve only for the adapter that
 * owns them, `env:`/`keychain:` only when a person wrote them, removal deletes
 * only the adapter's own entries, and a new address needs its secrets entered
 * again. These are the six tests the ticket names as part of done.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AdapterRegistry,
  TELEGRAM_MANIFEST,
  WEBHOOK_MANIFEST,
  type AdapterConfig,
} from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import type {
  CredentialProvider,
  CredentialResolution,
  CredentialStore,
} from '../../core/credential-provider.js';
import { AdapterManager } from '../adapter-manager.js';
import { deleteAdapterSecrets, resolveAdapterSecrets } from '../adapter-secrets.js';
import { assertSecretReferences, mergeSecretUpdate } from '../adapter-secret-policy.js';

vi.mock('chokidar', () => ({
  default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: vi.fn(async () => {}) }) },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createTaggedLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

/** An in-memory `file:` store that also holds secrets other parts of DorkOS own. */
class FakeStore implements CredentialStore {
  readonly secrets = new Map<string, string>([
    ['anthropic', 'sk-ant-THE-REAL-KEY'],
    ['community:space-1:token', 'community-token'],
  ]);
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

/** Resolves `file:` from the store and `env:` from a fixed map; records every ask. */
class FakeProvider implements CredentialProvider {
  readonly asked: string[] = [];
  constructor(private readonly store: FakeStore) {}
  async resolve(ref: string): Promise<CredentialResolution> {
    this.asked.push(ref);
    const [scheme, value] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    const secret =
      scheme === 'file'
        ? await this.store.get(value)
        : scheme === 'env'
          ? ({ ANTHROPIC_API_KEY: 'sk-ant-FROM-ENV' } as Record<string, string>)[value]
          : undefined;
    return secret == null
      ? { ok: false, reason: 'unresolved', ref, message: `nothing at ${scheme}` }
      : { ok: true, secret };
  }
}

const manifests = new Map<string, AdapterManifest>([['webhook', WEBHOOK_MANIFEST]]);
const URL_A = 'https://example.com/hook';
const URL_B = 'https://attacker.example/collect';

function webhook(
  id: string,
  outbound: Record<string, unknown>,
  inboundSecret = 'inbound-secret-16chars'
): AdapterConfig {
  return {
    id,
    type: 'webhook',
    enabled: false,
    config: {
      inbound: { subject: `relay.webhook.${id}`, secret: inboundSecret },
      outbound: { url: URL_A, ...outbound },
    },
  } as AdapterConfig;
}

let store: FakeStore;
let provider: FakeProvider;
beforeEach(() => {
  store = new FakeStore();
  provider = new FakeProvider(store);
});

describe('1. an adapter naming file:anthropic', () => {
  it('is refused at save, for a person too', () => {
    const config = webhook('wh', { secret: 'file:anthropic' }).config;
    for (const writer of ['person', 'agent'] as const) {
      expect(() => assertSecretReferences('wh', config, WEBHOOK_MANIFEST, writer)).toThrow(
        /outbound\.secret' names a stored secret\. Enter the secret itself/
      );
    }
  });

  it('is refused at resolve, before the store is read, in a header too', async () => {
    const config = webhook('wh', {
      secret: 'outbound-secret-16chars',
      headers: { Authorization: 'file:community:space-1:token' },
    });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, allowPersonReferences: true })
    ).rejects.toThrow(/field 'outbound\.headers\.Authorization'.*belongs to something else/);
    expect(provider.asked).toEqual([]);
  });

  it("is refused for another adapter's own entry", async () => {
    await store.put('relay-adapter-other-outbound-secret', 'other-secret');
    const config = webhook('wh', { secret: 'file:relay-adapter-other-outbound-secret' });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, allowPersonReferences: true })
    ).rejects.toThrow(/belongs to something else/);
  });
});

describe('1b. names are exact, not prefixes', () => {
  it("adapter 'w-outbound' cannot resolve adapter 'w''s header entry", async () => {
    await store.put('relay-adapter-w-outbound-headers-Authorization', 'w-header');
    const config = webhook('w-outbound', {
      secret: 'outbound-secret-16chars',
      headers: { X: 'file:relay-adapter-w-outbound-headers-Authorization' },
    });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, allowPersonReferences: true })
    ).rejects.toThrow(/belongs to something else/);
    await deleteAdapterSecrets(config, { store, manifests });
    expect(store.secrets.get('relay-adapter-w-outbound-headers-Authorization')).toBe('w-header');
  });

  it('a stored name sent back on a new address is refused, not carried', () => {
    const existing = webhook('w', {
      secret: 'file:relay-adapter-w-outbound-secret',
      headers: { Authorization: 'file:relay-adapter-w-outbound-headers-Authorization' },
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
            headers: { Authorization: 'file:relay-adapter-w-outbound-headers-Authorization' },
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
    const existing = webhook('w', { secret: 'file:relay-adapter-w-outbound-secret' }).config;
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
      resolveAdapterSecrets(config, { provider, manifests, allowPersonReferences: false })
    ).rejects.toThrow(/only a person can set/);
    expect(provider.asked).toEqual([]);
  });
});

describe('3. removing an adapter that names another entry', () => {
  it('leaves that entry alone and deletes only its own', async () => {
    await store.put('relay-adapter-wh-outbound-secret', 'own-secret');
    const config = webhook('wh', {
      secret: 'file:relay-adapter-wh-outbound-secret',
      headers: { Authorization: 'file:anthropic' },
    });
    await deleteAdapterSecrets(config, { store, manifests });
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
    expect(store.secrets.has('relay-adapter-wh-outbound-secret')).toBe(false);
  });
});

describe('4. a masked secret with a new URL', () => {
  const existing = webhook('wh', {
    secret: 'file:relay-adapter-wh-outbound-secret',
    headers: { Authorization: 'file:relay-adapter-wh-outbound-headers-Authorization' },
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
    const existing = { token: 'file:relay-adapter-tg-token', mode: 'polling' };
    const merged = mergeSecretUpdate(
      'tg',
      existing,
      { token: '***', mode: 'polling', webhookUrl: '', respondMode: 'always' },
      TELEGRAM_MANIFEST,
      'person'
    );
    expect(merged.token).toBe('file:relay-adapter-tg-token');
  });

  it("resolves an existing adapter's own secrets", async () => {
    await store.put('relay-adapter-wh-outbound-secret', 'own-secret');
    const resolved = await resolveAdapterSecrets(
      webhook('wh', { secret: 'file:relay-adapter-wh-outbound-secret' }),
      { provider, manifests, allowPersonReferences: true }
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
      allowPersonReferences: true,
    });
    expect(resolved.config).toMatchObject({ outbound: { secret: 'sk-ant-FROM-ENV' } });
  });
});

describe('through AdapterManager', () => {
  let directory: string;
  let manager: AdapterManager;
  let file: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'relay-secret-policy-'));
    file = join(directory, 'adapters.json');
    await writeFile(
      file,
      JSON.stringify({
        adapters: [
          { id: 'claude-code', type: 'claude-code', enabled: false, builtin: true, config: {} },
        ],
      })
    );
    manager = new AdapterManager(new AdapterRegistry(), file, {
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
      credentialStore: store,
      credentialProvider: provider,
    });
    await manager.initialize();
    await manager.adaptersStarted();
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  const fresh = () => webhook('wh', { secret: 'outbound-secret-16chars' }).config;

  it("refuses another owner's file: entry and an agent-written env: reference, writing nothing", async () => {
    const before = await readFile(file, 'utf8');
    // Long enough to pass the field's own 16-character rule, so the refusal
    // seen is the reference rule's (`file:anthropic` alone fails that rule first).
    const planted = {
      ...fresh(),
      outbound: { url: URL_B, secret: 'file:community:space-1:token' },
    };
    await expect(
      manager.addAdapter('webhook', 'wh', planted, false, undefined, 'person')
    ).rejects.toThrow(/names a stored secret/);
    const fromEnv = { ...fresh(), outbound: { url: URL_B, secret: 'env:ANTHROPIC_API_KEY' } };
    await expect(manager.addAdapter('webhook', 'wh', fromEnv, false)).rejects.toThrow(
      /only a person can set/
    );
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('a new URL with entered secrets drops the old header entry from the store', async () => {
    const withHeader = {
      ...fresh(),
      outbound: { url: URL_A, secret: 'outbound-secret-16chars', headers: { 'X-Key': 'k-1' } },
    };
    await manager.addAdapter('webhook', 'wh', withHeader, false, undefined, 'person');
    expect(store.secrets.get('relay-adapter-wh-outbound-headers-X-Key')).toBe('k-1');

    await expect(
      manager.updateConfig('wh', {
        outbound: { url: URL_B, secret: '***', headers: { 'X-Key': '***' } },
      })
    ).rejects.toThrow(/entered again/);
    await manager.updateConfig(
      'wh',
      {
        inbound: { subject: 'relay.webhook.wh', secret: 'new-inbound-secret-16' },
        outbound: { url: URL_B, secret: 'new-outbound-secret-16', headers: { 'X-Key': '***' } },
      },
      'person'
    );

    const saved = JSON.parse(await readFile(file, 'utf8')).adapters.find(
      (a: { id: string }) => a.id === 'wh'
    );
    expect(saved.config.outbound.url).toBe(URL_B);
    expect(saved.config.outbound.headers).toBeUndefined();
    expect(store.secrets.has('relay-adapter-wh-outbound-headers-X-Key')).toBe(false);
    expect(store.secrets.get('relay-adapter-wh-outbound-secret')).toBe('new-outbound-secret-16');
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
  });

  it('removing an adapter never deletes an entry it does not own', async () => {
    await manager.addAdapter('webhook', 'wh', fresh(), false, undefined, 'person');
    await manager.removeAdapter('wh');
    expect(store.secrets.has('relay-adapter-wh-outbound-secret')).toBe(false);
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
    expect(store.secrets.get('community:space-1:token')).toBe('community-token');
  });
});

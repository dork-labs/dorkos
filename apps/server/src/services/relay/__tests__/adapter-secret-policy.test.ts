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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import { PausedAdapter } from '../adapter-factory.js';
import { deleteAdapterSecrets, resolveAdapterSecrets } from '../adapter-secrets.js';
import {
  assertSecretReferences,
  legacySecretKeyFor,
  mergeSecretUpdate,
  secretKeyFor,
} from '../adapter-secret-policy.js';

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
      resolveAdapterSecrets(config, { provider, manifests, approved: 'any' })
    ).rejects.toThrow(/field 'outbound\.headers\.Authorization'.*belongs to something else/);
    expect(provider.asked).toEqual([]);
  });

  it("is refused for another adapter's own entry", async () => {
    await store.put('relay-adapter:other:outbound.secret', 'other-secret');
    const config = webhook('wh', { secret: 'file:relay-adapter:other:outbound.secret' });
    await expect(
      resolveAdapterSecrets(config, { provider, manifests, approved: 'any' })
    ).rejects.toThrow(/belongs to something else/);
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
    expect(store.secrets.get('relay-adapter:wh:outbound.headers.X-Key')).toBe('k-1');

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
    expect(store.secrets.has('relay-adapter:wh:outbound.headers.X-Key')).toBe(false);
    expect(store.secrets.get('relay-adapter:wh:outbound.secret')).toBe('new-outbound-secret-16');
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
  });

  it('removing an adapter never deletes an entry it does not own', async () => {
    await manager.addAdapter('webhook', 'wh', fresh(), false, undefined, 'person');
    await manager.removeAdapter('wh');
    expect(store.secrets.has('relay-adapter:wh:outbound.secret')).toBe(false);
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
    expect(store.secrets.get('community:space-1:token')).toBe('community-token');
  });
});

describe("Security's five, against a real adapters.json", () => {
  let directory: string;
  let manager: AdapterManager;
  let registry: AdapterRegistry;
  let file: string;

  /** Boot a manager over a hand-written adapters.json holding these entries. */
  async function boot(entries: unknown[]): Promise<void> {
    directory = await mkdtemp(join(tmpdir(), 'relay-secret-five-'));
    file = join(directory, 'adapters.json');
    const builtin = {
      id: 'claude-code',
      type: 'claude-code',
      enabled: false,
      builtin: true,
      config: {},
    };
    await writeFile(file, JSON.stringify({ adapters: [builtin, ...entries] }));
    registry = new AdapterRegistry();
    registry.setRelay({
      publish: vi.fn(async () => ({ messageId: 'fixture', deliveredTo: 1 })),
      subscribe: () => () => {},
      onSignal: () => () => {},
    } as never);
    manager = new AdapterManager(registry, file, {
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
      credentialStore: store,
      credentialProvider: provider,
    });
    await manager.initialize();
    await manager.adaptersStarted();
  }

  afterEach(async () => {
    await manager.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  /** A hand-edited webhook entry whose own secret is real and whose header names `ref`. */
  async function handEdited(
    ref: string,
    extra: Record<string, unknown> = {},
    url = URL_B
  ): Promise<void> {
    await store.put('relay-adapter:wh:outbound.secret', 'own-outbound-secret');
    await store.put('relay-adapter:wh:inbound.secret', 'own-inbound-secret');
    await boot([
      {
        id: 'wh',
        type: 'webhook',
        enabled: true,
        ...extra,
        config: {
          inbound: { subject: 'relay.webhook.wh', secret: 'file:relay-adapter:wh:inbound.secret' },
          outbound: {
            url,
            secret: 'file:relay-adapter:wh:outbound.secret',
            headers: { Authorization: ref },
          },
        },
      },
    ]);
  }

  it("1. adapter A naming B's file: entry fails to resolve", async () => {
    await store.put('relay-adapter:other:outbound.secret', 'b-secret');
    await handEdited('file:relay-adapter:other:outbound.secret');
    expect(registry.get('wh')).toBeUndefined();
    expect(provider.asked).not.toContain('file:relay-adapter:other:outbound.secret');
  });

  it('2. an agent PATCH carrying env:ANTHROPIC_API_KEY is refused', async () => {
    await boot([]);
    await manager.addAdapter(
      'webhook',
      'wh',
      webhook('wh', { secret: 'outbound-secret-16chars' }).config,
      false,
      undefined,
      'person'
    );
    const before = await readFile(file, 'utf8');
    await expect(
      manager.updateConfig(
        'wh',
        { outbound: { url: URL_A, secret: 'env:ANTHROPIC_API_KEY' } },
        'agent'
      )
    ).rejects.toThrow(/only a person can set/);
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('3. a new outbound.url with masked secrets clears nothing it should keep and requires the secret', async () => {
    await boot([]);
    await manager.addAdapter(
      'webhook',
      'wh',
      webhook('wh', { secret: 'outbound-secret-16chars' }).config,
      false,
      undefined,
      'person'
    );
    await expect(
      manager.updateConfig('wh', { outbound: { url: URL_B, secret: '***' } }, 'person')
    ).rejects.toThrow(/entered again: Inbound Secret, Outbound Secret/);
    const saved = JSON.parse(await readFile(file, 'utf8')).adapters.find(
      (a: { id: string }) => a.id === 'wh'
    );
    expect(saved.config.outbound.url).toBe(URL_A);
  });

  it('4. DELETE of an adapter naming file:anthropic leaves the key file', async () => {
    await handEdited('file:anthropic');
    await manager.removeAdapter('wh');
    expect(store.secrets.get('anthropic')).toBe('sk-ant-THE-REAL-KEY');
    expect(store.secrets.has('relay-adapter:wh:outbound.secret')).toBe(false);
  });

  it('5. a hand-edited adapters.json naming file:anthropic is refused at resolve', async () => {
    await handEdited('file:anthropic');
    expect(registry.get('wh')).toBeUndefined();
    expect(provider.asked).not.toContain('file:anthropic');
  });

  /** The connection's catalog instance, as the Connections page reads it. */
  const instance = () =>
    manager
      .getCatalog()
      .flatMap((entry) => entry.instances)
      .find((i) => i.id === 'wh');
  const fileText = () => readFile(file, 'utf8');

  /** The fingerprint the owner was shown. */
  const shown = () => instance()?.confirmation?.fingerprint ?? '';

  it('M1 / AC-1: a hand-edited env: reference never resolves; the connection is paused and listed', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    expect(registry.get('wh')).toBeInstanceOf(PausedAdapter);
    expect(provider.asked).not.toContain('env:ANTHROPIC_API_KEY');
    expect(instance()?.confirmation).toMatchObject({
      references: [{ field: 'outbound.headers.Authorization', ref: 'env:ANTHROPIC_API_KEY' }],
      host: 'attacker.example',
      notSent: 0,
    });
  });

  it('AC-2: confirming what was shown records it in the store, clears the pause, and resolves', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    await manager.confirmReferences('wh', shown());
    expect(registry.get('wh')).not.toBeInstanceOf(PausedAdapter);
    expect(registry.get('wh')).toBeDefined();
    expect(provider.asked).toContain('env:ANTHROPIC_API_KEY');
    expect(instance()?.confirmation).toBeUndefined();
    // The record is in the encrypted store, never in adapters.json.
    expect(store.secrets.get('relay-adapter-approved:wh')).toContain('env:ANTHROPIC_API_KEY');
    expect(await fileText()).not.toMatch(/approved|personWrote/);
  });

  it('a confirm of anything but what was shown is refused (409), and approves nothing', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    await expect(manager.confirmReferences('wh', 'stale')).rejects.toMatchObject({
      code: 'CONFIRMATION_STALE',
    });
    expect(store.secrets.has('relay-adapter-approved:wh')).toBe(false);
    expect(registry.get('wh')).toBeInstanceOf(PausedAdapter);
  });

  it('an approval is tied to where it sends: a hand-edited destination pauses it again', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    await manager.confirmReferences('wh', shown());
    await manager.shutdown();
    // Same reference, new address, written straight into adapters.json.
    const text = (await fileText()).replace(URL_B, 'https://elsewhere.example/x');
    await writeFile(file, text);
    registry = new AdapterRegistry();
    registry.setRelay({
      publish: vi.fn(async () => ({ messageId: 'fixture', deliveredTo: 1 })),
      subscribe: () => () => {},
      onSignal: () => () => {},
    } as never);
    manager = new AdapterManager(registry, file, {
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
      credentialStore: store,
      credentialProvider: provider,
    });
    await manager.initialize();
    await manager.adaptersStarted();
    expect(registry.get('wh')).toBeInstanceOf(PausedAdapter);
    expect(instance()?.confirmation?.host).toBe('elsewhere.example');
  });

  it('Undo takes the confirmation back and pauses it again', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    await manager.confirmReferences('wh', shown());
    await manager.confirmReferences('wh', null, true);
    expect(store.secrets.has('relay-adapter-approved:wh')).toBe(false);
    expect(registry.get('wh')).toBeInstanceOf(PausedAdapter);
  });

  it('confirming a connection the person turned off keeps it off', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    const fingerprint = shown();
    await manager.disable('wh');
    expect(instance()?.confirmation).toBeUndefined();
    await manager.confirmReferences('wh', fingerprint);
    expect(registry.get('wh')).toBeUndefined();
    expect(manager.getAdapter('wh')?.config.enabled).toBe(false);
  });

  it('AC-4: a file: connection is never paused', async () => {
    await store.put('relay-adapter:wh:outbound.headers.Authorization', 'own-header');
    await handEdited('file:relay-adapter:wh:outbound.headers.Authorization');
    expect(registry.get('wh')).toBeDefined();
    expect(registry.get('wh')).not.toBeInstanceOf(PausedAdapter);
    expect(instance()?.confirmation).toBeUndefined();
  });

  it('AC-7: a Unicode look-alike host (Cyrillic о) is listed in its ASCII (xn--) form', async () => {
    await handEdited('env:ANTHROPIC_API_KEY', {}, 'https://hооks.example.dev/hook');
    const host = instance()?.confirmation?.host ?? '';
    expect(host.startsWith('xn--')).toBe(true);
    expect(host.endsWith('.example.dev')).toBe(true);
    expect([...host].every((char) => char.charCodeAt(0) < 128)).toBe(true);
  });

  it("a person's save records the reference in the store; an agent's later edit keeps it; the body cannot add one", async () => {
    await boot([]);
    const config = webhook('wh', { secret: 'env:ANTHROPIC_API_KEY' }).config;
    await expect(
      manager.addAdapter('webhook', 'wh', config, false, undefined, 'agent')
    ).rejects.toThrow(/only a person can set/);
    await manager.addAdapter('webhook', 'wh', config, false, undefined, 'person');
    expect(JSON.parse(store.secrets.get('relay-adapter-approved:wh')!)).toEqual({
      refs: { 'outbound.secret': 'env:ANTHROPIC_API_KEY' },
      to: [URL_A],
    });

    await manager.updateConfig('wh', { outbound: { url: URL_A, secret: '***' } }, 'agent');
    expect(store.secrets.get('relay-adapter-approved:wh')).toContain('env:ANTHROPIC_API_KEY');
    await manager.enable('wh');
    expect(registry.get('wh')).not.toBeInstanceOf(PausedAdapter);
  });

  it('a person saving for another reason does not vouch for an old unrecorded env: reference', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    await manager.updateConfig('wh', { label: 'Renamed' }, 'person');
    expect(store.secrets.has('relay-adapter-approved:wh')).toBe(false);
    expect(registry.get('wh')).toBeInstanceOf(PausedAdapter);

    await manager.updateConfig(
      'wh',
      {
        outbound: {
          url: URL_B,
          secret: '***',
          headers: { Authorization: 'env:ANTHROPIC_API_KEY' },
        },
      },
      'person'
    );
    expect(store.secrets.get('relay-adapter-approved:wh')).toContain('env:ANTHROPIC_API_KEY');
    expect(registry.get('wh')).not.toBeInstanceOf(PausedAdapter);
  });

  it('removing a connection deletes its approvals record', async () => {
    await handEdited('env:ANTHROPIC_API_KEY');
    await manager.confirmReferences('wh', shown());
    await manager.removeAdapter('wh');
    expect(store.secrets.has('relay-adapter-approved:wh')).toBe(false);
  });

  it('AC-6: while paused it drops and counts; after Confirm only new messages send, once each', async () => {
    const received: string[] = [];
    const listener = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        received.push(body);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
    const port = (listener.address() as AddressInfo).port;
    try {
      await handEdited('env:ANTHROPIC_API_KEY', {}, `http://127.0.0.1:${port}/hook`);
      const send = (n: number) =>
        registry.deliver('relay.webhook.wh', {
          id: `env-${n}`,
          subject: 'relay.webhook.wh',
          from: 'relay.agent.backend',
          budget: {
            hopCount: 0,
            maxHops: 5,
            ancestorChain: [],
            ttl: Date.now() + 3_600_000,
            callBudgetRemaining: 10,
          },
          createdAt: new Date().toISOString(),
          payload: { n },
        } as never);
      for (const n of [1, 2, 3]) {
        expect(await send(n)).toMatchObject({ success: true, skipped: true });
      }
      expect(instance()?.confirmation?.notSent).toBe(3);
      expect(received).toHaveLength(0);

      await manager.confirmReferences('wh', shown());
      expect(instance()?.confirmation).toBeUndefined();
      expect(received).toHaveLength(0);
      await send(4);
      expect(received).toEqual([JSON.stringify({ n: 4 })]);
    } finally {
      await new Promise<void>((done) => listener.close(() => done()));
    }
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

  describe('through AdapterManager', () => {
    let directory: string;
    let manager: AdapterManager;
    let file: string;

    async function boot(entries: unknown[]): Promise<void> {
      directory = await mkdtemp(join(tmpdir(), 'relay-secret-names-'));
      file = join(directory, 'adapters.json');
      const builtin = {
        id: 'claude-code',
        type: 'claude-code',
        enabled: false,
        builtin: true,
        config: {},
      };
      await writeFile(file, JSON.stringify({ adapters: [builtin, ...entries] }));
      manager = new AdapterManager(new AdapterRegistry(), file, {
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
        credentialStore: store,
        credentialProvider: provider,
      });
      await manager.initialize();
      await manager.adaptersStarted();
    }

    afterEach(async () => {
      await manager.shutdown();
      await rm(directory, { recursive: true, force: true });
    });

    it('refuses a new connection whose names are already in the store', async () => {
      await boot([]);
      await store.put(secretKeyFor('wh', 'outbound.secret'), 'leftover');
      await expect(
        manager.addAdapter(
          'webhook',
          'wh',
          webhook('wh', { secret: 'outbound-secret-16chars' }).config,
          false,
          undefined,
          'person'
        )
      ).rejects.toThrow(/still exist/);
      expect(store.secrets.get(secretKeyFor('wh', 'outbound.secret'))).toBe('leftover');
    });

    it('finishes a move cut short: points at the current entry, never overwrites it', async () => {
      await store.put(legacySecretKeyFor('wh', 'outbound.secret'), 'old-outbound');
      await store.put(secretKeyFor('wh', 'outbound.secret'), 'current-outbound');
      await store.put(secretKeyFor('wh', 'inbound.secret'), 'current-inbound');
      await boot([
        {
          id: 'wh',
          type: 'webhook',
          enabled: false,
          config: {
            inbound: {
              subject: 'relay.webhook.wh',
              secret: `file:${secretKeyFor('wh', 'inbound.secret')}`,
            },
            outbound: { url: URL_A, secret: `file:${legacySecretKeyFor('wh', 'outbound.secret')}` },
          },
        },
      ]);
      const saved = JSON.parse(await readFile(file, 'utf8')).adapters.find(
        (a: { id: string }) => a.id === 'wh'
      );
      expect(saved.config.outbound.secret).toBe(`file:${secretKeyFor('wh', 'outbound.secret')}`);
      expect(store.secrets.get(secretKeyFor('wh', 'outbound.secret'))).toBe('current-outbound');
      expect(store.secrets.has(legacySecretKeyFor('wh', 'outbound.secret'))).toBe(false);
    });

    it('migrates an existing connection from its old names on load', async () => {
      await store.put(legacySecretKeyFor('wh', 'outbound.secret'), 'old-outbound');
      await store.put(legacySecretKeyFor('wh', 'inbound.secret'), 'old-inbound');
      await boot([
        {
          id: 'wh',
          type: 'webhook',
          enabled: false,
          config: {
            inbound: {
              subject: 'relay.webhook.wh',
              secret: `file:${legacySecretKeyFor('wh', 'inbound.secret')}`,
            },
            outbound: { url: URL_A, secret: `file:${legacySecretKeyFor('wh', 'outbound.secret')}` },
          },
        },
      ]);
      const saved = JSON.parse(await readFile(file, 'utf8')).adapters.find(
        (a: { id: string }) => a.id === 'wh'
      );
      expect(saved.config.outbound.secret).toBe(`file:${secretKeyFor('wh', 'outbound.secret')}`);
      expect(store.secrets.get(secretKeyFor('wh', 'outbound.secret'))).toBe('old-outbound');
      expect(store.secrets.has(legacySecretKeyFor('wh', 'outbound.secret'))).toBe(false);
      const resolved = await resolveAdapterSecrets(saved, {
        provider,
        manifests,
        approved: new Map(),
      });
      expect(resolved.config).toMatchObject({ outbound: { secret: 'old-outbound' } });
    });
  });
});

/** DOR-3271 through AdapterManager, against a real adapters.json. */
import {
  FakeProvider,
  FakeStore,
  bootManager,
  freshCredentials,
  handEditedEntry,
  manifests,
  shutdownBooted,
  webhook,
  URL_A,
  URL_B,
} from './adapter-secret-policy.fixtures.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { AdapterRegistry } from '@dorkos/relay';
import { resolveAdapterSecrets } from '../../adapter-secrets.js';
import { legacySecretKeyFor, secretKeyFor } from '../../adapter-secret-policy.js';
import type { AdapterManager } from '../../adapter-manager.js';

let store: FakeStore;
let provider: FakeProvider;
let manager: AdapterManager;
let registry: AdapterRegistry;
let file: string;

beforeEach(() => {
  ({ store, provider } = freshCredentials());
});
afterEach(shutdownBooted);

/** Boot a manager over a hand-written adapters.json holding these entries. */
async function boot(entries: unknown[] = []): Promise<void> {
  ({ file, registry, manager } = await bootManager({ store, provider }, entries));
}

/** Boot over a hand-edited webhook whose header names `ref`. */
async function handEdited(ref: string): Promise<void> {
  await boot([await handEditedEntry(store, ref)]);
}

describe('through AdapterManager', () => {
  beforeEach(() => boot());

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
});

describe("Security's five, against a real adapters.json", () => {
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
});

describe('S1: stored names cannot collide, through AdapterManager', () => {
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

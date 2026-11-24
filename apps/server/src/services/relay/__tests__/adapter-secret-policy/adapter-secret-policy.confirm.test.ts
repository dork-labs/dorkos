/**
 * DOR-3271: a hand-edited `env:` reference pauses its connection until the
 * owner confirms exactly what was shown.
 */
import {
  FakeProvider,
  FakeStore,
  bootManager,
  freshCredentials,
  handEditedEntry,
  shutdownBooted,
  webhook,
  URL_A,
  URL_B,
} from './adapter-secret-policy.fixtures.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdapterRegistry } from '@dorkos/relay';
import type { AdapterManager } from '../../adapter-manager.js';
import { PausedAdapter } from '../../adapter-factory.js';

let store: FakeStore;
let provider: FakeProvider;
let manager: AdapterManager;
let registry: AdapterRegistry;
let file: string;

beforeEach(() => {
  ({ store, provider } = freshCredentials());
});
afterEach(shutdownBooted);

async function boot(entries: unknown[] = []): Promise<void> {
  ({ file, registry, manager } = await bootManager({ store, provider }, entries));
}

/** Boot over a hand-edited webhook whose header names `ref`. */
async function handEdited(ref: string, extra: Record<string, unknown> = {}, url = URL_B) {
  await boot([await handEditedEntry(store, ref, extra, url)]);
}

describe('confirming a hand-edited reference', () => {
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
    ({ registry, manager } = await bootManager({ store, provider }, [], file));
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

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelayCore } from '../relay-core.js';
import { AdapterRegistry } from '../adapter-registry.js';
import type { RelayAdapter, PrivateNotificationResult } from '../types.js';

const text = 'private-event-payload-that-must-never-be-persisted';
const subject = 'relay.human.telegram.telegram-one.123';
const options = {
  adapterId: 'telegram-one',
  from: 'relay.agent.ns.agent-one',
  authorizeDispatch: () => true,
};
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-private-event-'));
  const registry = new AdapterRegistry();
  const relay = new RelayCore({
    dataDir: dir,
    adapterRegistry: registry,
    reliability: { rateLimit: { enabled: true, maxPerWindow: 1, windowSecs: 60 } },
  });
  relay.setInitiateConsentGate(() => ({ allowed: true }));
  const send = vi.fn<NonNullable<RelayAdapter['deliverPrivateNotification']>>(
    async (_subject, _text, guard): Promise<PrivateNotificationResult> =>
      guard() ? { state: 'delivered', receiptId: 'telegram:123:7' } : { state: 'refused' }
  );
  const adapter: RelayAdapter = {
    id: 'telegram-one',
    subjectPrefix: 'relay.human.telegram.telegram-one',
    displayName: 'Telegram',
    start: async () => {},
    stop: async () => {},
    getStatus: () => ({
      state: 'connected',
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    }),
    deliver: vi.fn(async () => ({ success: true })),
    deliverPrivateNotification: send,
  };
  await registry.register(adapter);
  disposers.push(async () => {
    await relay.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, registry, relay, adapter, send };
}
async function persistedText(dir: string): Promise<string> {
  let content = '';
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    content += entry.isDirectory()
      ? await persistedText(path)
      : (await readFile(path)).toString('utf8');
  }
  return content;
}
describe('private native delivery through real RelayCore and AdapterRegistry', () => {
  it('bypasses Maildir, subscribers, pending buffer and dead letters while retaining only metadata', async () => {
    const f = await fixture();
    await f.relay.registerEndpoint(subject);
    const subscriber = vi.fn();
    f.relay.subscribe(subject, subscriber);
    expect(await f.relay.deliverPrivateNotification(subject, text, options)).toEqual({
      state: 'delivered',
      receiptId: 'telegram:123:7',
    });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.adapter.deliver).not.toHaveBeenCalled();
    expect(subscriber).not.toHaveBeenCalled();
    const late = vi.fn();
    f.relay.subscribe(subject, late);
    await Promise.resolve();
    expect(late).not.toHaveBeenCalled();
    expect(await f.relay.getDeadLetters()).toEqual([]);
    expect(await persistedText(f.dir)).not.toContain(text);
  });
  it('keeps ordinary initiate consent, budget and rate limits on the private path without persisting refused content', async () => {
    const f = await fixture();
    f.relay.setInitiateConsentGate(() => ({ allowed: false, code: 'INITIATE_NOT_ALLOWED' }));
    expect(await f.relay.deliverPrivateNotification(subject, text, options)).toEqual({
      state: 'refused',
    });
    f.relay.setInitiateConsentGate(() => ({ allowed: true }));
    expect(
      await f.relay.deliverPrivateNotification(subject, text, {
        ...options,
        budget: { ttl: Date.now() - 1 },
      })
    ).toEqual({ state: 'refused' });
    expect(f.send).not.toHaveBeenCalled();
    expect((await f.relay.deliverPrivateNotification(subject, text, options)).state).toBe(
      'delivered'
    );
    expect((await f.relay.deliverPrivateNotification(subject, text, options)).state).toBe(
      'refused'
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await persistedText(f.dir)).not.toContain(text);
    expect((await f.relay.getDeadLetters()).every((row) => row.envelope === null)).toBe(true);
  });
  it('refuses a different adapter and invalidates a replaced adapter after asynchronous preparation', async () => {
    const f = await fixture();
    expect(
      await f.relay.deliverPrivateNotification(subject, text, {
        ...options,
        adapterId: 'another-adapter',
      })
    ).toEqual({ state: 'refused' });
    expect(f.send).not.toHaveBeenCalled();
    // Use another sender so this distinct scenario has its own rate allowance.
    f.send.mockImplementation(async (_subject, _text, guard) => {
      await f.registry.unregister('telegram-one');
      return guard() ? { state: 'delivered', receiptId: 'wrong' } : { state: 'refused' };
    });
    expect(
      await f.relay.deliverPrivateNotification(subject, text, {
        ...options,
        from: 'relay.agent.ns.agent-two',
      })
    ).toEqual({ state: 'refused' });
    expect(await persistedText(f.dir)).not.toContain(text);
  });
  it('refuses a source revoked during native preparation and quarantines uncertain native results', async () => {
    const f = await fixture();
    let active = true;
    f.send.mockImplementation(async (_subject, _text, guard) => {
      await Promise.resolve();
      active = false;
      return guard() ? { state: 'delivered', receiptId: 'wrong' } : { state: 'refused' };
    });
    expect(
      await f.relay.deliverPrivateNotification(subject, text, {
        ...options,
        authorizeDispatch: () => active,
      })
    ).toEqual({ state: 'refused' });
    f.send.mockRejectedValue(new Error('synthetic network uncertainty'));
    expect(
      await f.relay.deliverPrivateNotification(subject, text, {
        ...options,
        from: 'relay.agent.ns.agent-two',
      })
    ).toEqual({ state: 'outcome_unknown' });
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(await persistedText(f.dir)).not.toContain(text);
    expect((await f.relay.getDeadLetters()).every((row) => row.envelope === null)).toBe(true);
  });
});

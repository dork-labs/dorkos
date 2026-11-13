import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { TabBroker } from '../tab-broker.js';
import type { TabAuditEvent, TabOwnershipRecord } from '../types.js';

function page(address = 'https://made-up.example/') {
  const events = new EventEmitter();
  let closed = false;
  let url = address;
  const value = {
    on: events.on.bind(events),
    off: events.off.bind(events),
    isClosed: () => closed,
    url: () => url,
  } as unknown as Page;
  return {
    value,
    events,
    navigate(next: string) {
      url = next;
      events.emit('framenavigated', { url: () => next });
    },
    close() {
      closed = true;
      events.emit('close');
    },
  };
}

function fixture(options: { maxPagesPerOwner?: number; maxPages?: number; idleMs?: number } = {}) {
  const events: TabAuditEvent[] = [];
  const rows = new Map<string, TabOwnershipRecord>();
  const store = {
    get: (id: string) => rows.get(id),
    save: (row: TabOwnershipRecord) => {
      rows.set(row.pageId, { ...row });
    },
    delete: (id: string) => {
      rows.delete(id);
    },
  };
  const broker = new TabBroker({
    ...options,
    store,
    audit: (event) => {
      events.push(event);
    },
  });
  return { broker, store, events, rows };
}
const atlas = { ownerId: 'chat-atlas', agentId: 'agent-atlas' };
const nova = { ownerId: 'chat-nova', agentId: 'agent-nova' };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('tab ownership', () => {
  it('lists and resolves only the requesting owner’s pages', () => {
    const { broker } = fixture();
    const first = broker.bind(page().value, atlas);
    const second = broker.bind(page().value, nova);
    expect(broker.list(atlas)).toEqual([first]);
    expect(broker.list(nova)).toEqual([second]);
    expect(() => broker.leaseFor(atlas, second.pageId)).toThrow(
      expect.objectContaining({ code: 'tab_locked' })
    );
    expect(() => broker.leaseFor(nova, first.pageId)).toThrow(
      expect.objectContaining({ code: 'tab_locked' })
    );
    expect(() => broker.leaseFor({ ...atlas, agentId: 'another-agent' }, first.pageId)).toThrow(
      expect.objectContaining({ code: 'tab_locked' })
    );
  });

  it('refuses rebinding another owner’s page', () => {
    const { broker } = fixture();
    const tab = page();
    const lease = broker.bind(tab.value, atlas);
    expect(() => broker.bind(tab.value, nova)).toThrow(
      expect.objectContaining({ code: 'tab_locked' })
    );
    expect(broker.leaseFor(atlas, lease.pageId)).toBe(lease);
  });

  it('adopts only the server-stamped owner after reconnecting a known page', () => {
    const { broker, store } = fixture();
    const tab = page();
    const first = broker.bind(tab.value, atlas);
    const restarted = new TabBroker({ store, audit: () => undefined });
    restarted.register(tab.value, first.pageId);
    expect(restarted.adopt(nova)).toEqual([]);
    expect(restarted.adopt(atlas)).toEqual([
      expect.objectContaining({ pageId: first.pageId, ...atlas }),
    ]);
  });

  it('closes only the affected lease and gives tab_gone for a closed page', () => {
    const { broker, rows, events } = fixture();
    const first = page();
    const lease = broker.bind(first.value, atlas);
    const other = broker.bind(page().value, nova);
    first.close();
    expect(() => broker.leaseFor(atlas, lease.pageId)).toThrow(
      expect.objectContaining({ code: 'tab_gone' })
    );
    expect(broker.list(nova)).toEqual([other]);
    expect(rows.has(lease.pageId)).toBe(false);
    expect(events.at(-1)).toMatchObject({ kind: 'close', pageId: lease.pageId, ...atlas });
  });

  it('makes released pages the person’s and invalidates old lease handles', async () => {
    const { broker } = fixture();
    const tab = page();
    const lease = broker.bind(tab.value, atlas);
    broker.release(lease);
    expect(broker.list(atlas)).toEqual([]);
    expect(broker.adopt(atlas)).toEqual([]);
    const read = vi.fn(async () => 'private');
    await expect(broker.run(lease, read)).rejects.toMatchObject({ code: 'tab_locked' });
    expect(read).not.toHaveBeenCalled();
    // A new grant by the person cannot revive a stale queued action.
    broker.bind(tab.value, atlas);
    await expect(broker.run(lease, read)).rejects.toMatchObject({ code: 'tab_locked' });
  });

  it('binds popups to the opener but leaves a person’s tabs unowned', () => {
    const { broker } = fixture();
    const first = page();
    broker.bind(first.value, atlas);
    const popup = page();
    first.events.emit('popup', popup.value);
    const personal = broker.register(page().value);
    expect(broker.list(atlas)).toHaveLength(2);
    const child = broker.list(atlas)[1];
    expect(child.pageId).not.toBe(broker.list(atlas)[0].pageId);
    expect(broker.leaseFor(atlas, child.pageId)).toBe(child);
    expect(broker.list(nova)).toEqual([]);
    expect(() => broker.leaseFor(atlas, personal)).toThrow(
      expect.objectContaining({ code: 'tab_locked' })
    );
  });

  it('caps pages per owner and across the browser', () => {
    const { broker } = fixture({ maxPagesPerOwner: 1, maxPages: 2 });
    broker.bind(page().value, atlas);
    expect(() => broker.bind(page().value, atlas)).toThrow(
      expect.objectContaining({ code: 'tab_limit' })
    );
    broker.bind(page().value, nova);
    expect(() => broker.register(page().value)).toThrow(
      expect.objectContaining({ code: 'tab_limit' })
    );
  });
});

describe('page queues and takeover', () => {
  it('serializes one page while allowing another chat to progress', async () => {
    const { broker } = fixture();
    const first = broker.bind(page().value, atlas);
    const second = broker.bind(page().value, nova);
    let finish!: () => void;
    const started = deferred<void>();
    const order: string[] = [];
    const pending = broker.run(first, async () => {
      order.push('first');
      started.resolve();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await started.promise;
    const queued = broker.run(first, async () => {
      order.push('queued');
    });
    await broker.run(second, async () => {
      order.push('other-chat');
    });
    expect(order).toEqual(['first', 'other-chat']);
    finish();
    await Promise.all([pending, queued]);
    expect(order).toEqual(['first', 'other-chat', 'queued']);
  });

  it('keeps the queue usable after a failed action', async () => {
    const { broker } = fixture();
    const lease = broker.bind(page().value, atlas);
    await expect(
      broker.run(lease, async () => {
        throw new Error('made-up failure');
      })
    ).rejects.toThrow('made-up failure');
    await expect(broker.run(lease, async () => 'next')).resolves.toBe('next');
  });

  it('does not let a fabricated lease bypass ownership', async () => {
    const { broker } = fixture();
    const lease = broker.bind(page().value, atlas);
    const read = vi.fn(async () => 'private');
    await expect(broker.run({ ...lease }, read)).rejects.toMatchObject({ code: 'tab_locked' });
    expect(read).not.toHaveBeenCalled();
  });

  it('blocks every agent read during takeover, without stopping another chat', async () => {
    const { broker } = fixture();
    const first = broker.bind(page().value, atlas);
    const second = broker.bind(page().value, nova);
    const hold = broker.hold(first);
    const screenshot = vi.fn(async () => 'private pixels');
    expect(broker.list(atlas)).toEqual([]);
    expect(() => broker.leaseFor(atlas, first.pageId)).toThrow(
      expect.objectContaining({ code: 'page_held' })
    );
    await expect(broker.run(first, screenshot)).rejects.toMatchObject({ code: 'page_held' });
    expect(screenshot).not.toHaveBeenCalled();
    await expect(broker.run(second, async () => 'nova’s page')).resolves.toBe('nova’s page');
    expect(() => broker.hold(second)).toThrow(expect.objectContaining({ code: 'handoff_active' }));
    hold.handBack();
    await expect(broker.run(first, async () => 'returned')).resolves.toBe('returned');
  });

  it('discards an in-flight read and queued reads when the person takes over', async () => {
    const { broker } = fixture();
    const lease = broker.bind(page().value, atlas);
    const started = deferred<void>();
    const finish = deferred<string>();
    const read = broker.run(lease, async () => {
      started.resolve();
      return finish.promise;
    });
    await started.promise;
    const queuedRead = vi.fn(async () => 'more private text');
    const queued = broker.run(lease, queuedRead);
    broker.hold(lease);
    finish.resolve('private text');
    await expect(read).rejects.toMatchObject({ code: 'page_held' });
    await expect(queued).rejects.toMatchObject({ code: 'page_held' });
    expect(queuedRead).not.toHaveBeenCalled();
  });

  it('does not revive an old read when hand-back overtakes its completion', async () => {
    const { broker } = fixture();
    const lease = broker.bind(page().value, atlas);
    const started = deferred<void>();
    const finish = deferred<string>();
    const read = broker.run(lease, async () => {
      started.resolve();
      return finish.promise;
    });
    await started.promise;
    const hold = broker.hold(lease);
    hold.handBack();
    finish.resolve('text from before takeover');
    await expect(read).rejects.toMatchObject({ code: 'tab_locked' });
    await expect(broker.run(lease, async () => 'fresh')).resolves.toBe('fresh');
  });

  it('invalidates all leases on window close and removes listeners', async () => {
    const { broker } = fixture();
    const first = page();
    const second = page();
    const lease = broker.bind(first.value, atlas);
    broker.bind(second.value, nova);
    broker.close();
    expect(broker.list(atlas)).toEqual([]);
    expect(broker.list(nova)).toEqual([]);
    expect(first.events.listenerCount('popup')).toBe(0);
    expect(second.events.listenerCount('framenavigated')).toBe(0);
    await expect(broker.run(lease, async () => 'private')).rejects.toMatchObject({
      code: 'tab_gone',
    });
  });

  it('never auto-returns a held page after idle, disconnect, or restart', async () => {
    const { broker, store } = fixture({ idleMs: 50 });
    const tab = page();
    const first = broker.bind(tab.value, atlas);
    const hold = broker.hold(first);
    broker.sweepIdle(Date.now() + 100);
    expect(() => hold.handBack()).toThrow(expect.objectContaining({ code: 'tab_locked' }));
    expect(broker.adopt(atlas)).toEqual([]);
    const restarted = new TabBroker({ store, audit: () => undefined });
    restarted.register(tab.value, first.pageId);
    expect(restarted.adopt(atlas)).toEqual([]);
    const second = broker.bind(page().value, nova);
    broker.hold(second);
    broker.disconnect(nova);
    expect(broker.adopt(nova)).toEqual([]);
    await expect(broker.run(second, async () => 'private')).rejects.toMatchObject({
      code: 'tab_locked',
    });
  });

  it('keeps a persisted takeover unowned on a broker restart', () => {
    const { broker, store, rows } = fixture();
    const tab = page();
    const first = broker.bind(tab.value, atlas);
    broker.hold(first);
    const restarted = new TabBroker({ store, audit: () => undefined });
    restarted.register(tab.value, first.pageId);
    expect(restarted.adopt(atlas)).toEqual([]);
    expect(rows.get(first.pageId)).toMatchObject({ ownerId: null, agentId: null, held: false });
  });

  it('does not grant popups opened during takeover to the agent', () => {
    const { broker } = fixture();
    const first = page();
    const lease = broker.bind(first.value, atlas);
    broker.hold(lease);
    const popup = page();
    first.events.emit('popup', popup.value);
    expect(() => broker.bind(first.value, nova)).toThrow(
      expect.objectContaining({ code: 'page_held' })
    );
    expect(broker.list(atlas)).toEqual([]);
    expect(broker.adopt(nova)).toEqual([]);
  });
});

describe('page audit', () => {
  it('records identity, page, origins, lifecycle and handoff without URL secrets', () => {
    const { broker, events } = fixture();
    const first = page(
      'https://person:made-up-password@made-up.example/private?token=made-up-token#secret'
    );
    const lease = broker.bind(first.value, atlas);
    first.navigate('https://other.example/reset?token=another-token');
    const hold = broker.hold(lease);
    hold.handBack();
    first.close();
    expect(events.filter((event) => event.kind === 'origin')).toEqual([
      expect.objectContaining({
        ...atlas,
        pageId: lease.pageId,
        origin: 'https://made-up.example',
      }),
      expect.objectContaining({ ...atlas, pageId: lease.pageId, origin: 'https://other.example' }),
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      'open',
      'bind',
      'origin',
      'origin',
      'hold',
      'hand_back',
      'close',
    ]);
    const raw = JSON.stringify(events);
    for (const secret of ['password', '/private', 'token', 'secret', '/reset'])
      expect(raw).not.toContain(secret);
  });
});

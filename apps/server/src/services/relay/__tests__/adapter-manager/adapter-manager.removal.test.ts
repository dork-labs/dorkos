import {
  CONFIG_PATH,
  VALID_CONFIG,
  deferred,
  flushMicrotasks,
  freshHarness,
  initAndStart,
  lastSaved,
  mockCredentialStore,
  mockDeps,
  secretStore,
  withConfig,
} from './adapter-manager.fixtures.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { readFile, writeFile } from 'node:fs/promises';
import { TRACE_PRUNE_BATCH } from '@dorkos/relay';
import type { AdapterRegistry, RelayAdapter } from '@dorkos/relay';
import { AdapterManager } from '../../adapter-manager.js';
import type { AdapterManagerDeps } from '../../adapter-manager.js';
import { TraceStore } from '../../trace-store.js';
import { UnclaimedChatStore } from '../../unclaimed-chat-store.js';

/** An entry whose saved settings fail the schema, so it is held aside unstarted. */
const UNREADABLE = { id: 'broken', type: 'telegram', enabled: 'yes please', config: null };

describe('AdapterManager removal', () => {
  let manager: AdapterManager;
  let registry: AdapterRegistry;

  beforeEach(() => {
    ({ manager, registry } = freshHarness());
  });

  /** A started manager over VALID_CONFIG with extra deps. */
  async function startedWith(extra: Partial<AdapterManagerDeps>): Promise<AdapterManager> {
    withConfig(VALID_CONFIG);
    const m = new AdapterManager(registry, CONFIG_PATH, { ...mockDeps, ...extra });
    await initAndStart(m);
    return m;
  }

  it('stops, removes from config and persists', async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);

    await manager.removeAdapter('tg-main');

    expect(registry.unregister).toHaveBeenCalledWith('tg-main');
    expect(lastSaved().map((a) => a.id)).toEqual(['wh-github']);
    expect(manager.getAdapter('tg-main')).toBeUndefined();
  });

  // Held aside rather than started, such an entry was undeletable from every
  // surface, and deleting it is the only way to clear a cleartext credential
  // stuck inside it.
  it('deletes an entry whose saved settings could not be read, and only that id', async () => {
    withConfig(JSON.stringify({ adapters: [JSON.parse(VALID_CONFIG).adapters[0], UNREADABLE] }));
    await initAndStart(manager);

    await expect(manager.removeAdapter('never-existed')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await manager.removeAdapter('broken');

    expect(lastSaved().map((a) => a.id)).toEqual(['tg-main']);
  });

  it('refuses to remove the built-in claude-code adapter', async () => {
    withConfig(
      JSON.stringify({
        adapters: [
          { id: 'claude-code', type: 'claude-code', builtin: true, enabled: true, config: {} },
        ],
      })
    );
    await initAndStart(manager);

    await expect(manager.removeAdapter('claude-code')).rejects.toMatchObject({
      code: 'REMOVE_BUILTIN_DENIED',
    });
    expect(manager.getAdapter('claude-code')).toBeDefined();
  });

  it("deletes the removed adapter's bindings and no one else's", async () => {
    withConfig(VALID_CONFIG);
    await initAndStart(manager);
    const store = {
      getAll: vi.fn().mockReturnValue([
        { id: 'b1', adapterId: 'tg-main', agentId: 'agent-1' },
        { id: 'b2', adapterId: 'tg-main', agentId: 'agent-2' },
        { id: 'b3', adapterId: 'wh-github', agentId: 'agent-3' },
      ]),
      delete: vi.fn().mockResolvedValue(true),
    };
    (manager as unknown as { bindingSubsystem: unknown }).bindingSubsystem = {
      getBindingStore: () => store,
    };

    await manager.removeAdapter('tg-main');

    expect(store.delete.mock.calls).toEqual([['b1'], ['b2']]);
  });

  describe('delivery history (DOR-2604)', () => {
    /** A real trace store holding one chat on `tg-main` and one on `tg-main-2`. */
    function seededTraceStore(): TraceStore {
      const traces = new TraceStore(createTestDb());
      for (const adapterId of ['tg-main', 'tg-main-2']) {
        traces.insertSpan({
          messageId: `in-${adapterId}`,
          traceId: `in-${adapterId}`,
          subject: `relay.human.telegram.${adapterId}.111`,
          status: 'delivered',
          metadata: { from: `relay.human.telegram.${adapterId}.bot`, chatName: 'Ada' },
        });
        traces.insertAdapterEvent(adapterId, 'adapter.connected', 'Connected to relay');
      }
      return traces;
    }

    // A package update and an install rollback both remove without the flag;
    // neither may erase a history nobody asked to lose.
    it('keeps the history when the removal is internal, not a person removing it', async () => {
      const traces = seededTraceStore();
      const m = await startedWith({ traceEraser: traces });

      await m.removeAdapter('tg-main');

      expect(m.getAdapter('tg-main')).toBeUndefined();
      expect(traces.getObservedChats('tg-main')).toHaveLength(1);
      expect(traces.getAdapterEvents('tg-main')).toHaveLength(1);
    });

    it("deletes the removed connection's chats, names and events, and no one else's", async () => {
      const traces = seededTraceStore();
      const m = await startedWith({ traceEraser: traces });

      await m.removeAdapter('tg-main', { forgetHistory: true });

      expect(traces.getObservedChats('tg-main')).toEqual([]);
      expect(traces.getAdapterEvents('tg-main')).toEqual([]);
      expect(traces.getSpanByMessageId('in-tg-main')).toBeNull();
      // `tg-main-2` starts with `tg-main` and is a different connection.
      expect(traces.getObservedChats('tg-main-2')).toEqual([
        expect.objectContaining({ chatId: '111', displayName: 'Ada' }),
      ]);
      expect(traces.getAdapterEvents('tg-main-2')).toHaveLength(1);
    });

    it('keeps the history when the removal could not be saved', async () => {
      const traces = seededTraceStore();
      const m = await startedWith({ traceEraser: traces });
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      await expect(m.removeAdapter('tg-main', { forgetHistory: true })).rejects.toThrow(
        'disk full'
      );

      expect(traces.getObservedChats('tg-main')).toHaveLength(1);
      expect(traces.getAdapterEvents('tg-main')).toHaveLength(1);
    });

    it('deletes a long history in batches until none is left', async () => {
      // Two full batches, then a short one: the loop must keep going past a full batch.
      const sizes = [TRACE_PRUNE_BATCH, TRACE_PRUNE_BATCH, 7];
      const traceEraser = { deleteConnectionTraces: vi.fn(() => sizes.shift() ?? 0) };
      const m = await startedWith({ traceEraser });

      await m.removeAdapter('tg-main', { forgetHistory: true });

      expect(traceEraser.deleteConnectionTraces).toHaveBeenCalledTimes(3);
      expect(traceEraser.deleteConnectionTraces).toHaveBeenCalledWith('tg-main', TRACE_PRUNE_BATCH);
    });
  });

  describe('unclaimed chats (DOR-2608)', () => {
    /**
     * A real claim feed holding one chat in every status on `tg-main`, and one
     * pending chat on `tg-main-2`, whose id starts with `tg-main`.
     */
    function seededUnclaimedChats(): UnclaimedChatStore {
      const chats = new UnclaimedChatStore(createTestDb());
      const decisions = { p: null, c: 'claim', i: 'ignore', b: 'block' } as const;
      for (const [chatId, decision] of Object.entries(decisions)) {
        const { chat } = chats.recordSighting({
          adapterId: 'tg-main',
          chatId,
          chatKind: 'dm',
          senderName: 'Miguel',
        });
        if (decision === 'claim') chats.claim(chat.id, 'agent-1');
        else if (decision) chats[decision](chat.id);
      }
      chats.recordSighting({
        adapterId: 'tg-main-2',
        chatId: 'p',
        chatKind: 'dm',
        senderName: 'Ada',
      });
      return chats;
    }

    /** Every row still on file for `adapterId`, across all four statuses. */
    function rowsFor(chats: UnclaimedChatStore, adapterId: string) {
      return (['pending', 'claimed', 'ignored', 'blocked'] as const)
        .flatMap((status) => chats.list(status))
        .filter((chat) => chat.adapterId === adapterId);
    }

    it("deletes every chat the removed connection recorded, blocked and ignored too, and no one else's", async () => {
      const chats = seededUnclaimedChats();
      expect(rowsFor(chats, 'tg-main')).toHaveLength(4);
      const m = await startedWith({ unclaimedChats: chats });

      await m.removeAdapter('tg-main', { forgetHistory: true });

      expect(rowsFor(chats, 'tg-main')).toEqual([]);
      expect(chats.isBlocked('tg-main', 'b')).toBe(false);
      expect(rowsFor(chats, 'tg-main-2')).toEqual([
        expect.objectContaining({ chatId: 'p', senderName: 'Ada', status: 'pending' }),
      ]);
    });

    it('keeps them when the removal is internal, not a person removing it', async () => {
      const chats = seededUnclaimedChats();
      const m = await startedWith({ unclaimedChats: chats });

      await m.removeAdapter('tg-main');

      expect(rowsFor(chats, 'tg-main')).toHaveLength(4);
      expect(chats.isBlocked('tg-main', 'b')).toBe(true);
    });

    it('keeps them when the removal could not be saved', async () => {
      const chats = seededUnclaimedChats();
      const m = await startedWith({ unclaimedChats: chats });
      vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));

      await expect(m.removeAdapter('tg-main', { forgetHistory: true })).rejects.toThrow(
        'disk full'
      );

      expect(rowsFor(chats, 'tg-main')).toHaveLength(4);
    });
  });

  describe('registry serialization under concurrency', () => {
    const TWO_ENABLED_CONFIG = JSON.stringify({
      adapters: ['tg-first', 'tg-second'].map((id) => ({
        id,
        type: 'telegram',
        enabled: true,
        config: { token: `tok-${id}`, mode: 'polling' },
      })),
    });

    const NEW_HOOK = {
      inbound: { subject: 'relay.webhook.racing', secret: 'secret-16-chars!!' },
      outbound: { url: 'https://example.com', secret: 'secret-16-chars!!' },
    };

    afterEach(() => {
      vi.mocked(writeFile).mockResolvedValue(undefined);
    });

    /**
     * Gate one adapter id's registry.register behind an explicit release.
     * `reached` resolves once register(id) has been CALLED, the deterministic
     * hook the race tests pivot on (no sleeps).
     */
    function gateRegister(id: string): { reached: Promise<void>; release: () => void } {
      const original = vi.mocked(registry.register).getMockImplementation()!;
      const reached = deferred();
      const gate = deferred();
      vi.mocked(registry.register).mockImplementation(async (adapter: RelayAdapter) => {
        if (adapter.id === id) {
          reached.resolve();
          await gate.promise;
        }
        return original(adapter);
      });
      return { reached: reached.promise, release: gate.resolve };
    }

    /** Park the next config read (a hot-reload's) until released, handing back `contents`. */
    function gateNextRead(contents: string): { release: () => void } {
      const gate = deferred();
      vi.mocked(readFile).mockImplementationOnce(async () => {
        await gate.promise;
        return contents;
      });
      return { release: gate.resolve };
    }

    /**
     * From here on the mocked fs behaves like one file: a read returns the last
     * write that succeeded, and writes are refused while `refuse.on` is set.
     */
    function useDisk(initial: string): { ids: () => string[]; refuse: { on: boolean } } {
      // initialize() moves the fixture's cleartext secrets out and saves.
      const saved = vi.mocked(writeFile).mock.calls.at(-1)?.[1];
      let content = typeof saved === 'string' ? saved : initial;
      const refuse = { on: false };
      vi.mocked(readFile).mockImplementation(async () => content);
      vi.mocked(writeFile).mockImplementation(async (_path, data) => {
        if (refuse.on) throw new Error('disk full');
        content = String(data);
      });
      const ids = () =>
        (JSON.parse(content) as { adapters: { id: string }[] }).adapters.map((a) => a.id);
      return { ids, refuse };
    }

    /** Park the next secret move into the credential store until released. */
    function gateNextSecretMove(): { release: () => void } {
      const gate = deferred();
      mockCredentialStore.put.mockImplementationOnce(async (name: string, secret: string) => {
        await gate.promise;
        secretStore.set(name, secret);
        return `file:${name}`;
      });
      return { release: gate.resolve };
    }

    it('enable() while the start pass is mid-register of the same adapter registers it exactly once', async () => {
      withConfig(TWO_ENABLED_CONFIG);
      const { reached, release } = gateRegister('tg-second');
      await manager.initialize();
      await reached;

      const enabling = manager.enable('tg-second');
      await flushMicrotasks(); // an unserialized enable would double-register here
      release();
      await enabling;
      await manager.adaptersStarted();

      const calls = vi.mocked(registry.register).mock.calls.filter(([a]) => a.id === 'tg-second');
      expect(calls).toHaveLength(1);
      expect(registry.get('tg-second')).toBeDefined();
    });

    it('disable() during the background start pass leaves the adapter unregistered', async () => {
      withConfig(TWO_ENABLED_CONFIG);
      const { reached, release } = gateRegister('tg-second');
      await manager.initialize();
      await reached;

      const disabling = manager.disable('tg-second');
      await flushMicrotasks(); // an unserialized disable completes its no-op unregister here
      release();
      await disabling;
      await manager.adaptersStarted();

      expect(registry.get('tg-second')).toBeUndefined();
      expect(manager.getAdapter('tg-second')!.config.enabled).toBe(false);
    });

    it('shutdown() mid-pass stops the pass from registering further adapters', async () => {
      withConfig(TWO_ENABLED_CONFIG);
      const { reached, release } = gateRegister('tg-first');
      await manager.initialize();
      await reached;

      await manager.shutdown();
      release();
      await manager.adaptersStarted();

      expect(vi.mocked(registry.register).mock.calls.map(([a]) => a.id)).toEqual(['tg-first']);
    });

    // The server's own save sets off the file watcher, so a hot-reload can be
    // mid-read when a person adds the next connection. The reload used to
    // assign the file from before the add over the in-memory list.
    it('addAdapter() while a hot-reload is reading the file keeps the new connection', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);
      useDisk(VALID_CONFIG);

      const { release } = gateNextRead(VALID_CONFIG);
      const reloading = manager.reload();
      await flushMicrotasks();
      const adding = manager.addAdapter('webhook', 'wh-racing', NEW_HOOK);
      await flushMicrotasks();
      release();
      await Promise.all([reloading, adding]);

      expect(manager.getAdapter('wh-racing')).toBeDefined();
      expect(registry.get('wh-racing')).toBeDefined();
      await expect(manager.removeAdapter('wh-racing')).resolves.toBeUndefined();
    });

    it('removeAdapter() across a hot-reload removes the connection it was asked to', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);
      useDisk(VALID_CONFIG);
      // Same connections, other order: an index taken before the reload names another one.
      const reordered = JSON.stringify({
        adapters: [...JSON.parse(VALID_CONFIG).adapters].reverse(),
      });

      const { release } = gateNextRead(reordered);
      const reloading = manager.reload();
      await flushMicrotasks();
      const removing = manager.removeAdapter('tg-main');
      await flushMicrotasks();
      release();
      await Promise.all([reloading, removing]);

      expect(manager.getAdapter('tg-main')).toBeUndefined();
      expect(manager.getAdapter('wh-github')).toBeDefined();
    });

    // A save moves secrets into the credential store before it writes, so an
    // add's slow save holding the old list used to land after a remove's save
    // and put the removed connection back on disk.
    it('a slow earlier save never lands on top of a later one', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);
      const disk = useDisk(VALID_CONFIG);

      const { release } = gateNextSecretMove();
      const adding = manager.addAdapter('webhook', 'wh-slow', NEW_HOOK);
      await flushMicrotasks();
      const removing = manager.removeAdapter('wh-github');
      await flushMicrotasks();
      release();
      await Promise.all([adding, removing]);

      expect(disk.ids()).toContain('wh-slow');
      expect(disk.ids()).not.toContain('wh-github');
    });

    // removeAdapter stopped the adapter, announced it, and only then dropped
    // the config; a reload in that gap started it again with no config left.
    it('a reload while a removal is finishing never starts the removed connection again', async () => {
      const disconnected = deferred();
      const emit = vi.fn(async (event: { eventType: string; resourceId?: string | null }) => {
        if (event.eventType === 'relay.adapter_disconnected' && event.resourceId === 'tg-main') {
          await disconnected.promise;
        }
      });
      const m = await startedWith({ activityService: { emit } });
      useDisk(VALID_CONFIG);

      const removing = m.removeAdapter('tg-main');
      await flushMicrotasks(); // stopped, and parked announcing it
      await m.reload();
      disconnected.resolve();
      await removing;

      expect(m.getAdapter('tg-main')).toBeUndefined();
      expect(registry.get('tg-main')).toBeUndefined();
    });

    // A failed save used to count as finished while an earlier save was still
    // writing, so a reload read the file from before that earlier save.
    it('a failed save does not let a reload read past an earlier save still running', async () => {
      withConfig(VALID_CONFIG);
      await initAndStart(manager);
      const disk = useDisk(VALID_CONFIG);

      const { release } = gateNextSecretMove();
      const adding = manager.addAdapter('webhook', 'wh-slow', NEW_HOOK);
      await flushMicrotasks();
      disk.refuse.on = true;
      const relabel = manager.updateAdapterLabel('tg-main', 'renamed').catch(() => undefined);
      await flushMicrotasks();
      const reloading = manager.reload();
      await flushMicrotasks();
      disk.refuse.on = false;
      release();
      await Promise.all([adding, relabel, reloading]);

      expect(manager.getAdapter('wh-slow')).toBeDefined();
    });
  });
});

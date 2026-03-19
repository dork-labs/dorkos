import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { TraceStore } from '../trace-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

describe('TraceStore', () => {
  let store: TraceStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TraceStore(db);
  });

  it('inserts a span and retrieves by messageId', () => {
    store.insertSpan({
      messageId: 'msg-001',
      traceId: 'trace-001',
      subject: 'relay.agent.session-1',
    });

    const result = store.getSpanByMessageId('msg-001');
    expect(result).not.toBeNull();
    expect(result!.messageId).toBe('msg-001');
    expect(result!.traceId).toBe('trace-001');
    expect(result!.subject).toBe('relay.agent.session-1');
    expect(result!.status).toBe('sent');
    // sentAt should be an ISO 8601 string
    expect(typeof result!.sentAt).toBe('string');
    expect(new Date(result!.sentAt).toISOString()).toBe(result!.sentAt);
  });

  it('returns null for non-existent messageId', () => {
    const result = store.getSpanByMessageId('nonexistent');
    expect(result).toBeNull();
  });

  it('updates span status and deliveredAt', () => {
    store.insertSpan({
      messageId: 'msg-001',
      traceId: 'trace-001',
      subject: 'relay.agent.session-1',
    });

    const deliveredAt = new Date().toISOString();
    store.updateSpan('msg-001', {
      status: 'delivered',
      deliveredAt,
    });

    const result = store.getSpanByMessageId('msg-001');
    expect(result?.status).toBe('delivered');
    expect(result?.deliveredAt).toBe(deliveredAt);
  });

  it('converts numeric timestamps to ISO 8601 on update', () => {
    store.insertSpan({
      messageId: 'msg-001',
      traceId: 'trace-001',
      subject: 'relay.agent.session-1',
    });

    const now = Date.now();
    store.updateSpan('msg-001', {
      status: 'delivered',
      deliveredAt: now,
    });

    const result = store.getSpanByMessageId('msg-001');
    expect(result?.deliveredAt).toBe(new Date(now).toISOString());
  });

  it('retrieves multiple spans by traceId', () => {
    store.insertSpan({ messageId: 'msg-001', traceId: 'trace-A', subject: 'relay.agent.s1' });
    store.insertSpan({ messageId: 'msg-002', traceId: 'trace-A', subject: 'relay.agent.s1' });
    store.insertSpan({ messageId: 'msg-003', traceId: 'trace-B', subject: 'relay.agent.s2' });

    const trace = store.getTrace('trace-A');
    expect(trace).toHaveLength(2);
    expect(trace.map((s) => s.messageId).sort()).toEqual(['msg-001', 'msg-002']);
  });

  it('returns correct metrics with counts', () => {
    store.insertSpan({ messageId: 'msg-001', traceId: 't1', subject: 's1', status: 'delivered' });
    store.insertSpan({ messageId: 'msg-002', traceId: 't2', subject: 's1', status: 'delivered' });
    store.insertSpan({ messageId: 'msg-003', traceId: 't3', subject: 's1', status: 'failed' });
    store.insertSpan({ messageId: 'msg-004', traceId: 't4', subject: 's1', status: 'timeout' });

    const metrics = store.getMetrics();
    expect(metrics.totalMessages).toBe(4);
    expect(metrics.deliveredCount).toBe(2);
    expect(metrics.failedCount).toBe(1);
    expect(metrics.deadLetteredCount).toBe(1);
    expect(metrics.activeEndpoints).toBe(1);
  });

  it('returns empty metrics with no data', () => {
    const metrics = store.getMetrics();
    expect(metrics.totalMessages).toBe(0);
    expect(metrics.deliveredCount).toBe(0);
    expect(metrics.avgDeliveryLatencyMs).toBeNull();
    expect(metrics.p95DeliveryLatencyMs).toBeNull();
  });

  describe('getMetrics date filter', () => {
    it('excludes spans older than 24 hours by default', () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      store.insertSpan({
        messageId: 'old-msg',
        traceId: 'old-trace',
        subject: 'test.old',
        status: 'delivered',
      });
      // Manually backdate sentAt to 25 hours ago via raw SQL
      db.run(sql`UPDATE relay_traces SET sent_at = ${oldDate} WHERE message_id = 'old-msg'`);

      // Insert a recent span
      store.insertSpan({
        messageId: 'new-msg',
        traceId: 'new-trace',
        subject: 'test.new',
        status: 'delivered',
      });

      const metrics = store.getMetrics();
      expect(metrics.totalMessages).toBe(1);
      expect(metrics.deliveredCount).toBe(1);
    });

    it('includes spans within the provided since window', () => {
      store.insertSpan({
        messageId: 'recent-msg',
        traceId: 'recent-trace',
        subject: 'test.recent',
        status: 'failed',
      });

      const metrics = store.getMetrics({ since: new Date(Date.now() - 60_000).toISOString() });
      expect(metrics.totalMessages).toBe(1);
      expect(metrics.failedCount).toBe(1);
    });

    it('applies date filter to latency and endpoint queries', () => {
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      store.insertSpan({
        messageId: 'old-ep',
        traceId: 'old-trace-ep',
        subject: 'test.old-endpoint',
        status: 'delivered',
      });
      db.run(sql`UPDATE relay_traces SET sent_at = ${oldDate} WHERE message_id = 'old-ep'`);

      store.insertSpan({
        messageId: 'new-ep',
        traceId: 'new-trace-ep',
        subject: 'test.new-endpoint',
        status: 'delivered',
      });

      const metrics = store.getMetrics();
      // Only the recent span's subject should count
      expect(metrics.activeEndpoints).toBe(1);
    });
  });

  it('handles updateSpan with no fields gracefully', () => {
    store.insertSpan({ messageId: 'msg-001', traceId: 't1', subject: 's1' });
    store.updateSpan('msg-001', {});
    const result = store.getSpanByMessageId('msg-001');
    expect(result?.status).toBe('sent');
  });

  it('maps legacy status values on insert', () => {
    store.insertSpan({
      messageId: 'msg-001',
      traceId: 't1',
      subject: 's1',
      status: 'pending' as never,
    });
    const result = store.getSpanByMessageId('msg-001');
    expect(result?.status).toBe('sent');
  });

  it('maps legacy status values on update', () => {
    store.insertSpan({ messageId: 'msg-001', traceId: 't1', subject: 's1' });
    store.updateSpan('msg-001', { status: 'processed' });
    const result = store.getSpanByMessageId('msg-001');
    expect(result?.status).toBe('delivered');
  });

  it('stores and retrieves metadata as JSON', () => {
    store.insertSpan({
      messageId: 'msg-001',
      traceId: 't1',
      subject: 's1',
      metadata: { key: 'value', num: 42 },
    });
    const result = store.getSpanByMessageId('msg-001');
    expect(JSON.parse(result!.metadata!)).toEqual({ key: 'value', num: 42 });
  });

  it('close is a no-op and does not throw', () => {
    expect(() => store.close()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Adapter events
  // -------------------------------------------------------------------------

  describe('adapter events', () => {
    it('insertAdapterEvent persists an event with correct metadata', () => {
      store.insertAdapterEvent('telegram-1', 'adapter.connected', 'Connected to relay');
      const events = store.getAdapterEvents('telegram-1');
      expect(events).toHaveLength(1);
      expect(events[0].subject).toBe('adapter.connected');
      const metadata = JSON.parse(events[0].metadata!);
      expect(metadata.adapterId).toBe('telegram-1');
      expect(metadata.eventType).toBe('adapter.connected');
      expect(metadata.message).toBe('Connected to relay');
    });

    it('getAdapterEvents filters by adapterId', () => {
      store.insertAdapterEvent('telegram-1', 'adapter.connected', 'Connected');
      store.insertAdapterEvent('webhook-1', 'adapter.connected', 'Connected');
      store.insertAdapterEvent('telegram-1', 'adapter.error', 'Error occurred');

      const telegramEvents = store.getAdapterEvents('telegram-1');
      expect(telegramEvents).toHaveLength(2);
      expect(
        telegramEvents.every((e) => {
          const m = JSON.parse(e.metadata!);
          return m.adapterId === 'telegram-1';
        }),
      ).toBe(true);
    });

    it('getAdapterEvents returns events ordered most-recent first', () => {
      // Use fake timers with distinct timestamps to guarantee stable ordering
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      store.insertAdapterEvent('telegram-1', 'adapter.connected', 'First');

      vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
      store.insertAdapterEvent('telegram-1', 'adapter.error', 'Second');

      vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'));
      store.insertAdapterEvent('telegram-1', 'adapter.disconnected', 'Third');

      vi.useRealTimers();

      const events = store.getAdapterEvents('telegram-1');
      expect(events[0].subject).toBe('adapter.disconnected'); // Most recent first
      expect(events[1].subject).toBe('adapter.error');
      expect(events[2].subject).toBe('adapter.connected');
    });

    it('getAdapterEvents respects limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        store.insertAdapterEvent('telegram-1', 'adapter.connected', `Event ${i}`);
      }
      const events = store.getAdapterEvents('telegram-1', 3);
      expect(events).toHaveLength(3);
    });

    it('getAdapterEvents returns empty array for unknown adapterId', () => {
      const events = store.getAdapterEvents('nonexistent');
      expect(events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Observed chats
  // -------------------------------------------------------------------------

  describe('getObservedChats', () => {
    it('returns empty array when no traces exist for adapter', () => {
      const chats = store.getObservedChats('telegram-1');
      expect(chats).toEqual([]);
    });

    it('returns empty array for unknown adapterId', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '111', channelType: 'dm' },
      });
      const chats = store.getObservedChats('unknown-adapter');
      expect(chats).toEqual([]);
    });

    it('returns aggregated chat from a single trace', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: {
          adapterId: 'telegram-1',
          chatId: '111',
          channelType: 'dm',
          displayName: 'Alice',
        },
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('111');
      expect(chats[0].channelType).toBe('dm');
      expect(chats[0].displayName).toBe('Alice');
      expect(chats[0].messageCount).toBe(1);
      expect(typeof chats[0].lastMessageAt).toBe('string');
    });

    it('groups multiple traces by chatId with correct message count', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '111', channelType: 'dm', displayName: 'Alice' },
      });
      store.insertSpan({
        messageId: 'msg-002',
        traceId: 'trace-002',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '111', channelType: 'dm', displayName: 'Alice' },
      });
      store.insertSpan({
        messageId: 'msg-003',
        traceId: 'trace-003',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '222', channelType: 'group', displayName: 'Dev Team' },
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(2);

      const chat111 = chats.find((c) => c.chatId === '111');
      expect(chat111?.messageCount).toBe(2);
      expect(chat111?.displayName).toBe('Alice');
      expect(chat111?.channelType).toBe('dm');

      const chat222 = chats.find((c) => c.chatId === '222');
      expect(chat222?.messageCount).toBe(1);
      expect(chat222?.channelType).toBe('group');
    });

    it('filters by adapterId and excludes other adapters', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '111' },
      });
      store.insertSpan({
        messageId: 'msg-002',
        traceId: 'trace-002',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-2', chatId: '999' },
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('111');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        store.insertSpan({
          messageId: `msg-${i}`,
          traceId: `trace-${i}`,
          subject: 'relay.human.telegram',
          metadata: { adapterId: 'telegram-1', chatId: String(i) },
        });
      }

      const chats = store.getObservedChats('telegram-1', 3);
      expect(chats).toHaveLength(3);
    });

    it('sorts by lastMessageAt descending', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: 'older-chat' },
      });

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-002',
        traceId: 'trace-002',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: 'newer-chat' },
      });

      vi.useRealTimers();

      const chats = store.getObservedChats('telegram-1');
      expect(chats[0].chatId).toBe('newer-chat');
      expect(chats[1].chatId).toBe('older-chat');
    });

    it('skips rows with missing chatId in metadata', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1' }, // no chatId
      });
      store.insertSpan({
        messageId: 'msg-002',
        traceId: 'trace-002',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '111' },
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('111');
    });

    it('handles rows with null metadata gracefully', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        // no metadata field
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toEqual([]);
    });

    it('ignores unknown channelType values', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'trace-001',
        subject: 'relay.human.telegram',
        metadata: { adapterId: 'telegram-1', chatId: '111', channelType: 'invalid-type' },
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0].channelType).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Anti-regression: ISO 8601 timestamps (not INTEGER Unix ms)
  // -------------------------------------------------------------------------

  describe('anti-regression: ISO 8601 timestamps', () => {
    it('stores sentAt as ISO 8601 string (not INTEGER Unix ms)', () => {
      store.insertSpan({
        messageId: 'ts-check',
        traceId: 'trace-ts',
        subject: 'relay.agent.ts',
      });

      const rows = db.all<{ sent_at: string }>(
        sql`SELECT sent_at FROM relay_traces WHERE message_id = 'ts-check'`,
      );
      expect(rows).toHaveLength(1);

      const sentAt = rows[0].sent_at;
      // Must be a valid ISO 8601 string, not a numeric timestamp
      expect(typeof sentAt).toBe('string');
      expect(Number.isNaN(Number(sentAt))).toBe(true); // not a bare number
      expect(new Date(sentAt).toISOString()).toBe(sentAt);
    });

    it('stores deliveredAt as ISO 8601 string (not INTEGER Unix ms)', () => {
      store.insertSpan({
        messageId: 'ts-deliver',
        traceId: 'trace-ts2',
        subject: 'relay.agent.ts2',
      });

      const deliveredAt = new Date().toISOString();
      store.updateSpan('ts-deliver', { status: 'delivered', deliveredAt });

      const rows = db.all<{ delivered_at: string }>(
        sql`SELECT delivered_at FROM relay_traces WHERE message_id = 'ts-deliver'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].delivered_at).toBe(deliveredAt);
      expect(new Date(rows[0].delivered_at).toISOString()).toBe(deliveredAt);
    });

    it('columns are named sent_at and delivered_at (not sentAt/deliveredAt)', () => {
      store.insertSpan({
        messageId: 'col-check',
        traceId: 'trace-col',
        subject: 'relay.agent.col',
      });

      // These queries use the actual column names — would fail if columns used camelCase
      const rows = db.all<{ sent_at: string; delivered_at: string | null }>(
        sql`SELECT sent_at, delivered_at FROM relay_traces WHERE message_id = 'col-check'`,
      );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].sent_at).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // Observed chats
  // -------------------------------------------------------------------------

  describe('getObservedChats', () => {
    it('returns aggregated chats grouped by chatId', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-oc-1',
        traceId: 'trace-oc-1',
        subject: 'relay.agent.session-1',
        metadata: { adapterId: 'telegram-1', chatId: '111', channelType: 'dm', displayName: 'Alice' },
      });

      vi.setSystemTime(new Date('2026-03-10T11:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-oc-2',
        traceId: 'trace-oc-2',
        subject: 'relay.agent.session-2',
        metadata: { adapterId: 'telegram-1', chatId: '111', channelType: 'dm', displayName: 'Alice' },
      });

      vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-oc-3',
        traceId: 'trace-oc-3',
        subject: 'relay.agent.session-3',
        metadata: { adapterId: 'telegram-1', chatId: '222', channelType: 'group', displayName: 'Dev Team' },
      });

      vi.useRealTimers();

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(2);

      const chat111 = chats.find((c) => c.chatId === '111');
      expect(chat111).toBeDefined();
      expect(chat111!.messageCount).toBe(2);
      expect(chat111!.displayName).toBe('Alice');
      expect(chat111!.channelType).toBe('dm');

      const chat222 = chats.find((c) => c.chatId === '222');
      expect(chat222).toBeDefined();
      expect(chat222!.messageCount).toBe(1);
      expect(chat222!.displayName).toBe('Dev Team');
      expect(chat222!.channelType).toBe('group');
    });

    it('returns empty array when no traces exist for the adapter', () => {
      const chats = store.getObservedChats('nonexistent');
      expect(chats).toEqual([]);
    });

    it('sorts by lastMessageAt descending', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-03-10T08:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-sort-1',
        traceId: 'trace-sort-1',
        subject: 'relay.agent.s1',
        metadata: { adapterId: 'tg-1', chatId: 'old-chat' },
      });

      vi.setSystemTime(new Date('2026-03-10T12:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-sort-2',
        traceId: 'trace-sort-2',
        subject: 'relay.agent.s2',
        metadata: { adapterId: 'tg-1', chatId: 'new-chat' },
      });

      vi.useRealTimers();

      const chats = store.getObservedChats('tg-1');
      expect(chats[0].chatId).toBe('new-chat');
      expect(chats[1].chatId).toBe('old-chat');
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        store.insertSpan({
          messageId: `msg-lim-${i}`,
          traceId: `trace-lim-${i}`,
          subject: 'relay.agent.s1',
          metadata: { adapterId: 'tg-limit', chatId: `chat-${i}` },
        });
      }

      const chats = store.getObservedChats('tg-limit', 3);
      expect(chats).toHaveLength(3);
    });

    it('filters by adapterId and ignores other adapters', () => {
      store.insertSpan({
        messageId: 'msg-filter-1',
        traceId: 'trace-f1',
        subject: 'relay.agent.s1',
        metadata: { adapterId: 'telegram-1', chatId: '111' },
      });
      store.insertSpan({
        messageId: 'msg-filter-2',
        traceId: 'trace-f2',
        subject: 'relay.agent.s2',
        metadata: { adapterId: 'webhook-1', chatId: '222' },
      });

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0].chatId).toBe('111');
    });

    it('skips traces without chatId in metadata', () => {
      store.insertSpan({
        messageId: 'msg-no-chat',
        traceId: 'trace-nc',
        subject: 'relay.agent.s1',
        metadata: { adapterId: 'tg-nc', eventType: 'adapter.connected', message: 'ok' },
      });

      const chats = store.getObservedChats('tg-nc');
      expect(chats).toEqual([]);
    });

    it('updates lastMessageAt to most recent for grouped chats', () => {
      vi.useFakeTimers();

      vi.setSystemTime(new Date('2026-03-10T08:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-ts-1',
        traceId: 'trace-ts-1',
        subject: 'relay.agent.s1',
        metadata: { adapterId: 'tg-ts', chatId: '111' },
      });

      vi.setSystemTime(new Date('2026-03-10T16:00:00.000Z'));
      store.insertSpan({
        messageId: 'msg-ts-2',
        traceId: 'trace-ts-2',
        subject: 'relay.agent.s2',
        metadata: { adapterId: 'tg-ts', chatId: '111' },
      });

      vi.useRealTimers();

      const chats = store.getObservedChats('tg-ts');
      expect(chats).toHaveLength(1);
      expect(chats[0].lastMessageAt).toBe('2026-03-10T16:00:00.000Z');
    });
  });
});

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
    store.insertSpan({
      messageId: 'msg-005',
      traceId: 't5',
      subject: 's1',
      status: 'no_subscriber',
    });

    const metrics = store.getMetrics();
    expect(metrics.totalMessages).toBe(5);
    expect(metrics.deliveredCount).toBe(2);
    expect(metrics.failedCount).toBe(1);
    // A message nothing was listening for is counted apart from a failure.
    expect(metrics.noSubscriberCount).toBe(1);
    expect(metrics.activeEndpoints).toBe(1);
  });

  // Restarting an integration is not traffic. These rows were written as
  // `delivered` and swept into every delivery metric (DOR-789).
  it('leaves adapter lifecycle events out of the delivery numbers', () => {
    store.insertSpan({ messageId: 'msg-001', traceId: 't1', subject: 's1', status: 'delivered' });
    const before = store.getMetrics();

    store.insertAdapterEvent('tg-main', 'adapter.connected', 'Connected to relay');
    store.insertAdapterEvent('tg-main', 'adapter.disconnected', 'Disconnected from relay');
    store.insertAdapterEvent('tg-main', 'adapter.connected', 'Connected to relay');

    const after = store.getMetrics();
    expect(after.totalMessages).toBe(before.totalMessages);
    expect(after.deliveredCount).toBe(before.deliveredCount);
    // …and the events are still readable on their own surface.
    expect(store.getAdapterEvents('tg-main')).toHaveLength(3);
  });

  // It used to count trace rows with a status nothing writes, so it read zero
  // however full the queue was (DOR-789).
  it('counts dead letters from the queue that actually holds them', () => {
    const insertDeadLetter = (id: string) =>
      db.run(
        sql`INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at)
            VALUES (${id}, 'relay.inbox.agent-a', 'relay.inbox.agent-a', 'failed',
                    ${new Date().toISOString()})`
      );

    expect(store.getMetrics().deadLetteredCount).toBe(0);
    insertDeadLetter('dl-1');
    insertDeadLetter('dl-2');
    expect(store.getMetrics().deadLetteredCount).toBe(2);
  });

  it('windows dead letters by the same period as every other metric', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    db.run(
      sql`INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at)
          VALUES ('dl-old', 'relay.inbox.agent-a', 'relay.inbox.agent-a', 'failed', ${old})`
    );

    // Default window is 24h: a three-day-old dead letter is not "today".
    expect(store.getMetrics().deadLetteredCount).toBe(0);
    expect(
      store.getMetrics({ since: new Date(Date.now() - 7 * 86_400_000).toISOString() })
        .deadLetteredCount
    ).toBe(1);
  });

  it('returns empty metrics with no data', () => {
    const metrics = store.getMetrics();
    expect(metrics.totalMessages).toBe(0);
    expect(metrics.deliveredCount).toBe(0);
    expect(metrics.avgDeliveryLatencyMs).toBeNull();
    expect(metrics.p50DeliveryLatencyMs).toBeNull();
    expect(metrics.p95DeliveryLatencyMs).toBeNull();
    expect(metrics.p99DeliveryLatencyMs).toBeNull();
  });

  it('does not fabricate a latency percentile when spans exist but none delivered', () => {
    // Every span is still 'sent' -- deliveredAt is NULL for all of them, so
    // percentile_cont() sees zero non-NULL inputs and must return NULL, not 0.
    store.insertSpan({ messageId: 'pending-1', traceId: 't1', subject: 's1' });
    store.insertSpan({ messageId: 'pending-2', traceId: 't2', subject: 's1' });

    const metrics = store.getMetrics();
    expect(metrics.totalMessages).toBe(2);
    expect(metrics.avgDeliveryLatencyMs).toBeNull();
    expect(metrics.p50DeliveryLatencyMs).toBeNull();
    expect(metrics.p95DeliveryLatencyMs).toBeNull();
    expect(metrics.p99DeliveryLatencyMs).toBeNull();
  });

  describe('delivery-latency percentiles (DOR-166)', () => {
    /**
     * Hand-computed linear-interpolation percentile (the standard
     * percentile_cont formula), independent of the query under test:
     * rank = fraction * (n - 1); interpolate between the values that
     * straddle `rank` in the sorted array.
     */
    function handComputedPercentile(sorted: number[], fraction: number): number {
      const rank = fraction * (sorted.length - 1);
      const lo = Math.floor(rank);
      const hi = Math.ceil(rank);
      return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
    }

    /** Seed one delivered span per latency, all sent at the same fake instant. */
    function seedDeliveredSpans(latenciesMs: number[]): string {
      vi.useFakeTimers();
      const base = Date.parse('2026-01-01T00:00:00.000Z');
      vi.setSystemTime(new Date(base));
      const sentAt = new Date().toISOString();

      latenciesMs.forEach((_, i) => {
        store.insertSpan({ messageId: `lat-${i}`, traceId: `trace-${i}`, subject: 's1' });
      });
      latenciesMs.forEach((latency, i) => {
        vi.setSystemTime(new Date(base + latency));
        store.updateSpan(`lat-${i}`, {
          status: 'delivered',
          deliveredAt: new Date().toISOString(),
        });
      });
      vi.useRealTimers();
      return sentAt;
    }

    // julianday() carries float noise in the microsecond range (measured at
    // most ~0.015ms on these fixtures), so latency assertions use
    // toBeCloseTo(expected, 1) -- tolerance 0.05ms.
    it('computes p50/p95/p99 delivery latency in one SQL pass, verified against hand-computed values', () => {
      const latencies = Array.from({ length: 10 }, (_, i) => (i + 1) * 1000); // 1000..10000ms
      const sentAt = seedDeliveredSpans(latencies);

      const metrics = store.getMetrics({ since: sentAt });
      expect(metrics.avgDeliveryLatencyMs).toBeCloseTo(5500, 1); // mean of 1000..10000
      expect(metrics.p50DeliveryLatencyMs).toBeCloseTo(handComputedPercentile(latencies, 0.5), 1); // 5500
      expect(metrics.p95DeliveryLatencyMs).toBeCloseTo(handComputedPercentile(latencies, 0.95), 1); // 9550
      expect(metrics.p99DeliveryLatencyMs).toBeCloseTo(handComputedPercentile(latencies, 0.99), 1); // 9910
    });

    it('resolves sub-second latencies to milliseconds -- never truncates them to 0', () => {
      // Anti-regression for the strftime('%s') bug: whole-second truncation
      // reported a real 650ms delivery as 0ms. In-process relay hops are
      // routinely sub-second, so this is the primary case, not an edge.
      const latencies = [50, 150, 250, 350, 450, 550, 650, 750, 850, 950];
      const sentAt = seedDeliveredSpans(latencies);

      const metrics = store.getMetrics({ since: sentAt });
      expect(metrics.avgDeliveryLatencyMs).toBeGreaterThan(0);
      expect(metrics.avgDeliveryLatencyMs).toBeCloseTo(500, 1);
      expect(metrics.p50DeliveryLatencyMs).toBeCloseTo(handComputedPercentile(latencies, 0.5), 1); // 500
      expect(metrics.p95DeliveryLatencyMs).toBeCloseTo(handComputedPercentile(latencies, 0.95), 1); // 905
      expect(metrics.p99DeliveryLatencyMs).toBeCloseTo(handComputedPercentile(latencies, 0.99), 1); // 941
    });

    it('reports a single 650ms delivery as ~650ms, not 0', () => {
      const sentAt = seedDeliveredSpans([650]);

      const metrics = store.getMetrics({ since: sentAt });
      expect(metrics.avgDeliveryLatencyMs).toBeCloseTo(650, 1);
      expect(metrics.p50DeliveryLatencyMs).toBeCloseTo(650, 1);
      expect(metrics.p95DeliveryLatencyMs).toBeCloseTo(650, 1);
      expect(metrics.p99DeliveryLatencyMs).toBeCloseTo(650, 1);
    });
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
        })
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
    /**
     * Seed a span the way the publish pipeline writes one for a message a chat
     * connection brought in: the chat lives in the subject, and the sender is
     * the connection's `.bot` principal. The previous tests seeded
     * `{ adapterId, chatId }` metadata, a shape no writer produces, so they
     * passed while the list was empty in production.
     */
    function publishSpan(
      messageId: string,
      subject: string,
      from?: string,
      chat: { chatName?: string; emptyContent?: true } = {}
    ): void {
      const parsed = subject.split('.');
      store.insertSpan({
        messageId,
        traceId: messageId,
        subject,
        status: 'delivered',
        metadata: {
          from: from ?? `relay.human.${parsed[2]}.${parsed[3]}.bot`,
          ...chat,
          deliveredTo: 1,
          rejectedCount: 0,
          hasAdapterResult: false,
          durationMs: 1,
        },
      });
    }

    it('returns empty array when no traces exist for adapter', () => {
      expect(store.getObservedChats('telegram-1')).toEqual([]);
    });

    it('returns a chat named in a delivery span subject', () => {
      publishSpan('msg-001', 'relay.human.telegram.telegram-1.111');

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({ chatId: '111', channelType: 'dm', messageCount: 1 });
      expect(chats[0].displayName).toBeUndefined();
      expect(typeof chats[0].lastMessageAt).toBe('string');
    });

    it('groups spans by chat and reads the group segment as a group chat', () => {
      publishSpan('msg-001', 'relay.human.telegram.telegram-1.111');
      publishSpan('msg-002', 'relay.human.telegram.telegram-1.111');
      publishSpan('msg-003', 'relay.human.telegram.telegram-1.group.-222');

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(2);
      expect(chats.find((c) => c.chatId === '111')).toMatchObject({
        channelType: 'dm',
        messageCount: 2,
      });
      expect(chats.find((c) => c.chatId === '-222')).toMatchObject({
        channelType: 'group',
        messageCount: 1,
      });
    });

    it('filters by adapterId and excludes other adapters', () => {
      publishSpan('msg-001', 'relay.human.telegram.telegram-1.111');
      publishSpan('msg-002', 'relay.human.telegram.telegram-2.999');
      // An adapter id that merely contains the one asked for is a different connection.
      publishSpan('msg-003', 'relay.human.telegram.telegram-10.555');
      // The id appearing later in the subject is part of another connection's chat id.
      publishSpan('msg-004', 'relay.human.telegram.other.telegram-1.777');

      const chats = store.getObservedChats('telegram-1');
      expect(chats.map((c) => c.chatId)).toEqual(['111']);
    });

    it('treats LIKE wildcards in an adapter id literally', () => {
      publishSpan('msg-001', 'relay.human.slack.slack_a.C1');
      publishSpan('msg-002', 'relay.human.slack.slackXa.C2');

      expect(store.getObservedChats('slack_a').map((c) => c.chatId)).toEqual(['C1']);
    });

    it("counts only messages the connection brought in, not the agent's replies", () => {
      publishSpan('msg-001', 'relay.human.telegram.telegram-1.111');
      // The agent's reply and each stream event of its turn go to the same subject.
      publishSpan('msg-002', 'relay.human.telegram.telegram-1.111', 'agent:session-1');
      publishSpan('msg-003', 'relay.human.telegram.telegram-1.111', 'agent:session-1');
      // A reply-only chat (the agent spoke first) is not one that messaged the connection.
      publishSpan('msg-004', 'relay.human.telegram.telegram-1.222', 'agent:session-1');
      // Another connection's sender is not this one's.
      publishSpan('msg-005', 'relay.human.telegram.telegram-1.333', 'relay.human.slack.x.bot');

      const chats = store.getObservedChats('telegram-1');
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({ chatId: '111', messageCount: 1 });
    });

    it('names a chat by the latest non-empty name its messages recorded', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-10T08:00:00.000Z'));
      publishSpan('msg-001', 'relay.human.telegram.tg-1.group.-100', undefined, {
        chatName: 'Old Title',
      });
      vi.setSystemTime(new Date('2026-03-10T09:00:00.000Z'));
      publishSpan('msg-002', 'relay.human.telegram.tg-1.group.-100', undefined, {
        chatName: 'New Title',
      });
      vi.setSystemTime(new Date('2026-03-10T10:00:00.000Z'));
      // A later message that recorded no name keeps the last one it had.
      publishSpan('msg-003', 'relay.human.telegram.tg-1.group.-100');
      publishSpan('msg-004', 'relay.human.telegram.tg-1.555');
      vi.useRealTimers();

      const chats = store.getObservedChats('tg-1');
      expect(chats.find((c) => c.chatId === '-100')?.displayName).toBe('New Title');
      expect(chats.find((c) => c.chatId === '555')?.displayName).toBeUndefined();
    });

    it('does not count a message that said nothing, but keeps the name it carried', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-10T08:00:00.000Z'));
      publishSpan('msg-001', 'relay.human.telegram.tg-1.group.-100', undefined, {
        chatName: 'Dev Team',
        emptyContent: true,
      });
      vi.setSystemTime(new Date('2026-03-10T07:00:00.000Z'));
      publishSpan('msg-002', 'relay.human.telegram.tg-1.group.-100');
      // A chat seen only through a no-text event (the bot was added) is not listed.
      publishSpan('msg-003', 'relay.human.telegram.tg-1.group.-200', undefined, {
        chatName: 'Quiet',
        emptyContent: true,
      });
      vi.useRealTimers();

      const chats = store.getObservedChats('tg-1');
      expect(chats).toHaveLength(1);
      expect(chats[0]).toMatchObject({
        chatId: '-100',
        displayName: 'Dev Team',
        messageCount: 1,
        lastMessageAt: '2026-03-10T07:00:00.000Z',
      });
    });

    it('skips a span with no recorded sender', () => {
      store.insertSpan({
        messageId: 'msg-001',
        traceId: 'msg-001',
        subject: 'relay.human.telegram.telegram-1.111',
      });
      expect(store.getObservedChats('telegram-1')).toEqual([]);
    });

    it('skips an adapter-root subject that names no chat', () => {
      publishSpan('msg-001', 'relay.human.telegram.telegram-1');
      expect(store.getObservedChats('telegram-1')).toEqual([]);
    });

    it('skips lifecycle events and non-human subjects', () => {
      store.insertAdapterEvent('telegram-1', 'adapter.connected', 'Connected');
      publishSpan('msg-001', 'relay.agent.telegram-1.session');
      expect(store.getObservedChats('telegram-1')).toEqual([]);
    });

    it('respects the limit parameter', () => {
      for (let i = 0; i < 10; i++) {
        publishSpan(`msg-${i}`, `relay.human.telegram.telegram-1.${i}`);
      }
      expect(store.getObservedChats('telegram-1', 3)).toHaveLength(3);
    });

    it('sorts by lastMessageAt descending', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      publishSpan('msg-001', 'relay.human.telegram.telegram-1.older-chat');
      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
      publishSpan('msg-002', 'relay.human.telegram.telegram-1.newer-chat');
      vi.useRealTimers();

      const chats = store.getObservedChats('telegram-1');
      expect(chats.map((c) => c.chatId)).toEqual(['newer-chat', 'older-chat']);
      expect(chats[0].lastMessageAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it("moves a chat's lastMessageAt to its most recent message", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-10T08:00:00.000Z'));
      publishSpan('msg-ts-1', 'relay.human.telegram.tg-ts.111');
      vi.setSystemTime(new Date('2026-03-10T16:00:00.000Z'));
      publishSpan('msg-ts-2', 'relay.human.telegram.tg-ts.111');
      vi.useRealTimers();

      const chats = store.getObservedChats('tg-ts');
      expect(chats).toHaveLength(1);
      expect(chats[0].lastMessageAt).toBe('2026-03-10T16:00:00.000Z');
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
        sql`SELECT sent_at FROM relay_traces WHERE message_id = 'ts-check'`
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
        sql`SELECT delivered_at FROM relay_traces WHERE message_id = 'ts-deliver'`
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
        sql`SELECT sent_at, delivered_at FROM relay_traces WHERE message_id = 'col-check'`
      );
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].sent_at).toBe('string');
    });
  });
});

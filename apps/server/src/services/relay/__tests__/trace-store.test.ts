import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { TraceStore } from '../trace-store.js';

let store: TraceStore;
let db: Db;

beforeEach(() => {
  db = createTestDb();
  store = new TraceStore(db);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run `fn` with the clock set to `iso`. */
function at(iso: string, fn: () => void): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  fn();
  vi.useRealTimers();
}

describe('TraceStore spans and metrics', () => {
  it('inserts, updates and reads a span, mapping legacy statuses and numeric times', () => {
    store.insertSpan({
      messageId: 'msg-001',
      traceId: 'trace-001',
      subject: 'relay.agent.s1',
      status: 'pending' as never,
      metadata: { key: 'value' },
    });
    expect(store.getSpanByMessageId('msg-001')).toMatchObject({
      traceId: 'trace-001',
      status: 'sent',
      metadata: JSON.stringify({ key: 'value' }),
    });
    const now = Date.now();
    store.updateSpan('msg-001', { status: 'processed', deliveredAt: now });
    expect(store.getSpanByMessageId('msg-001')).toMatchObject({
      status: 'delivered',
      deliveredAt: new Date(now).toISOString(),
    });
    expect(store.getSpanByMessageId('nonexistent')).toBeNull();
  });

  it('counts delivery outcomes, leaving adapter lifecycle events out (DOR-789)', () => {
    const statuses = ['delivered', 'delivered', 'failed', 'timeout', 'no_subscriber'] as const;
    statuses.forEach((status, i) =>
      store.insertSpan({ messageId: `msg-${i}`, traceId: `t${i}`, subject: 's1', status })
    );
    store.insertAdapterEvent('tg-main', 'adapter.connected', 'Connected to relay');
    expect(store.getMetrics()).toMatchObject({
      totalMessages: 5,
      deliveredCount: 2,
      failedCount: 1,
      noSubscriberCount: 1,
      activeEndpoints: 1,
    });
  });

  it('counts dead letters from the queue that holds them, in the same window (DOR-789)', () => {
    const insertDeadLetter = (id: string, createdAt: string) =>
      db.run(
        sql`INSERT INTO relay_index (id, subject, endpoint_hash, status, created_at)
            VALUES (${id}, 'relay.inbox.agent-a', 'relay.inbox.agent-a', 'failed', ${createdAt})`
      );
    insertDeadLetter('dl-1', new Date().toISOString());
    insertDeadLetter('dl-old', new Date(Date.now() - 3 * 86_400_000).toISOString());
    expect(store.getMetrics().deadLetteredCount).toBe(1);
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    expect(store.getMetrics({ since: week }).deadLetteredCount).toBe(2);
  });

  it('leaves spans older than 24 hours out, and fabricates no latency for undelivered ones', () => {
    store.insertSpan({
      messageId: 'old',
      traceId: 'old',
      subject: 'test.old',
      status: 'delivered',
    });
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    db.run(sql`UPDATE relay_traces SET sent_at = ${old} WHERE message_id = 'old'`);
    store.insertSpan({ messageId: 'pending', traceId: 'p', subject: 'test.new' });
    expect(store.getMetrics()).toMatchObject({
      totalMessages: 1,
      activeEndpoints: 1,
      avgDeliveryLatencyMs: null,
      p50DeliveryLatencyMs: null,
      p99DeliveryLatencyMs: null,
    });
  });

  // DOR-166. julianday() carries sub-millisecond noise, hence toBeCloseTo(…, 1).
  it.each([
    ['whole seconds', Array.from({ length: 10 }, (_, i) => (i + 1) * 1000)],
    // strftime('%s') once truncated a real 650ms delivery to 0ms.
    ['sub-second, never truncated to 0', [50, 150, 250, 350, 450, 550, 650, 750, 850, 950]],
  ])('computes avg and percentiles against hand-computed values: %s', (_label, latencies) => {
    const percentile = (fraction: number) => {
      const rank = fraction * (latencies.length - 1);
      const lo = Math.floor(rank);
      return latencies[lo] + (rank - lo) * (latencies[Math.ceil(rank)] - latencies[lo]);
    };
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(base));
    latencies.forEach((_, i) =>
      store.insertSpan({ messageId: `l${i}`, traceId: `t${i}`, subject: 's1' })
    );
    latencies.forEach((latency, i) => {
      vi.setSystemTime(new Date(base + latency));
      store.updateSpan(`l${i}`, { status: 'delivered', deliveredAt: new Date().toISOString() });
    });
    vi.useRealTimers();
    const metrics = store.getMetrics({ since: new Date(base).toISOString() });
    expect(metrics.avgDeliveryLatencyMs).toBeCloseTo(
      latencies.reduce((a, b) => a + b, 0) / latencies.length,
      1
    );
    expect(metrics.p50DeliveryLatencyMs).toBeCloseTo(percentile(0.5), 1);
    expect(metrics.p95DeliveryLatencyMs).toBeCloseTo(percentile(0.95), 1);
    expect(metrics.p99DeliveryLatencyMs).toBeCloseTo(percentile(0.99), 1);
  });
});

describe('TraceStore adapter events', () => {
  it("returns one adapter's events, newest first, up to the limit", () => {
    at('2026-01-01T00:00:00.000Z', () =>
      store.insertAdapterEvent('tg-1', 'adapter.connected', 'First')
    );
    at('2026-01-01T00:00:01.000Z', () =>
      store.insertAdapterEvent('webhook-1', 'adapter.connected', 'x')
    );
    at('2026-01-01T00:00:02.000Z', () =>
      store.insertAdapterEvent('tg-1', 'adapter.error', 'Second')
    );
    const events = store.getAdapterEvents('tg-1');
    expect(events.map((e) => e.subject)).toEqual(['adapter.error', 'adapter.connected']);
    expect(JSON.parse(events[0].metadata!)).toEqual({
      adapterId: 'tg-1',
      eventType: 'adapter.error',
      message: 'Second',
    });
    expect(store.getAdapterEvents('tg-1', 1)).toHaveLength(1);
  });
});

describe('TraceStore#getObservedChats', () => {
  /** Seed a span as the publish pipeline writes one for a message a chat brought in. */
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
      metadata: { from: from ?? `relay.human.${parsed[2]}.${parsed[3]}.bot`, ...chat },
    });
  }

  it('groups inbound messages by chat, reading group subjects, newest first, up to the limit', () => {
    at('2026-01-01T00:00:00.000Z', () => publishSpan('m1', 'relay.human.telegram.tg-1.111'));
    at('2026-01-02T00:00:00.000Z', () => publishSpan('m2', 'relay.human.telegram.tg-1.group.-222'));
    at('2026-01-03T00:00:00.000Z', () => publishSpan('m3', 'relay.human.telegram.tg-1.111'));
    expect(store.getObservedChats('tg-1')).toEqual([
      expect.objectContaining({
        chatId: '111',
        channelType: 'dm',
        messageCount: 2,
        lastMessageAt: '2026-01-03T00:00:00.000Z',
      }),
      expect.objectContaining({ chatId: '-222', channelType: 'group', messageCount: 1 }),
    ]);
    expect(store.getObservedChats('tg-1', 1)).toHaveLength(1);
  });

  it('matches the whole adapter id, literally, in its own segment', () => {
    publishSpan('m1', 'relay.human.telegram.tg-1.111');
    publishSpan('m2', 'relay.human.telegram.tg-10.555');
    publishSpan('m3', 'relay.human.telegram.other.tg-1.777');
    publishSpan('m4', 'relay.human.slack.slack_a.C1');
    publishSpan('m5', 'relay.human.slack.slackXa.C2');
    expect(store.getObservedChats('tg-1').map((c) => c.chatId)).toEqual(['111']);
    expect(store.getObservedChats('slack_a').map((c) => c.chatId)).toEqual(['C1']);
  });

  it('counts only messages the connection brought in, never replies, bare roots or other senders', () => {
    publishSpan('m1', 'relay.human.telegram.tg-1.111');
    publishSpan('m2', 'relay.human.telegram.tg-1.111', 'agent:session-1');
    publishSpan('m3', 'relay.human.telegram.tg-1.222', 'agent:session-1');
    publishSpan('m4', 'relay.human.telegram.tg-1.333', 'relay.human.slack.x.bot');
    publishSpan('m5', 'relay.human.telegram.tg-1');
    store.insertSpan({ messageId: 'm6', traceId: 'm6', subject: 'relay.human.telegram.tg-1.444' });
    store.insertAdapterEvent('tg-1', 'adapter.connected', 'Connected');
    expect(store.getObservedChats('tg-1')).toEqual([
      expect.objectContaining({ chatId: '111', messageCount: 1 }),
    ]);
  });

  it('names a chat by its latest recorded name, counting no empty message but keeping its name', () => {
    at('2026-03-10T08:00:00.000Z', () =>
      publishSpan('m1', 'relay.human.telegram.tg-1.group.-100', undefined, {
        chatName: 'Old Title',
      })
    );
    at('2026-03-10T09:00:00.000Z', () =>
      publishSpan('m2', 'relay.human.telegram.tg-1.group.-100', undefined, {
        chatName: 'New Title',
        emptyContent: true,
      })
    );
    at('2026-03-10T10:00:00.000Z', () => publishSpan('m3', 'relay.human.telegram.tg-1.group.-100'));
    // A chat seen only through a no-text event (the bot was added) is not listed.
    publishSpan('m4', 'relay.human.telegram.tg-1.group.-200', undefined, {
      chatName: 'Quiet',
      emptyContent: true,
    });
    expect(store.getObservedChats('tg-1')).toEqual([
      expect.objectContaining({ chatId: '-100', displayName: 'New Title', messageCount: 2 }),
    ]);
  });
});

describe('TraceStore#deleteConnectionTraces (DOR-2604)', () => {
  function span(messageId: string, subject: string, metadata: Record<string, unknown> = {}) {
    store.insertSpan({ messageId, traceId: messageId, subject, status: 'delivered', metadata });
  }
  const remaining = () =>
    db
      .all<{ message_id: string }>(sql`SELECT message_id FROM relay_traces ORDER BY message_id`)
      .map((r) => r.message_id);

  it("deletes a removed connection's chats, forwarded messages and events, legacy ones included", () => {
    span('dm-in', 'relay.human.telegram.tg.111', {
      from: 'relay.human.telegram.tg.bot',
      chatName: 'Ada',
    });
    span('reply', 'relay.human.telegram.tg.111', { from: 'relay.agent.session-1' });
    span('forwarded', 'relay.agent.session-1', {
      from: 'relay.human.telegram.tg.bot',
      chatName: 'Ada',
    });
    span('bare', 'relay.human.telegram.tg');
    span('legacy-event', 'adapter.connected', { adapterId: 'tg', eventType: 'adapter.connected' });
    store.insertAdapterEvent('tg', 'adapter.connected', 'Connected to relay');
    expect(store.deleteConnectionTraces('tg', 1000)).toBe(6);
    expect(remaining()).toEqual([]);
  });

  it('keeps lookalike ids, LIKE patterns, agent traffic and other connections', () => {
    span('tg2-in', 'relay.human.telegram.tg-2.111', { from: 'relay.human.telegram.tg-2.bot' });
    span('tg2-fwd', 'relay.agent.session-2', { from: 'relay.human.telegram.tg-2.bot' });
    span('tgx-in', 'relay.human.telegram.tgx.5', { from: 'relay.human.telegram.tgx.bot' });
    span('axb', 'relay.human.slack.axb.C1', { from: 'relay.human.slack.axb.bot' });
    span('agent', 'relay.agent.session-1', { from: 'relay.agent.session-2' });
    span('other-segment', 'relay.human.slack.sl.tg', { from: 'relay.human.slack.sl.bot' });
    span('not-human', 'relay.system.tg.111');
    store.insertAdapterEvent('tg-2', 'adapter.connected', 'Connected to relay');
    expect(store.deleteConnectionTraces('tg', 1000)).toBe(0);
    expect(store.deleteConnectionTraces('a_b', 1000)).toBe(0);
    expect(remaining()).toHaveLength(8);
  });

  it('deletes at most `limit` rows per call, until none are left', () => {
    for (let i = 0; i < 7; i++) {
      span(`m${i}`, `relay.human.telegram.tg.${i}`, { from: 'relay.human.telegram.tg.bot' });
    }
    span('keep', 'relay.human.telegram.tg-2.1', { from: 'relay.human.telegram.tg-2.bot' });
    expect(store.deleteConnectionTraces('tg', 3)).toBe(3);
    expect(store.deleteConnectionTraces('tg', 3)).toBe(3);
    expect(store.deleteConnectionTraces('tg', 3)).toBe(1);
    expect(remaining()).toEqual(['keep']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { TraceStore } from '../trace-store.js';
import { createTestDb } from '@dorkos/test-utils';
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
});

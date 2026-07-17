/**
 * Isolated from trace-store.test.ts because it mocks `hasPercentileSupport`
 * for the whole file (DOR-166) -- verifies that TraceStore#getMetrics()
 * degrades gracefully on a better-sqlite3 binary that predates the
 * percentile extension (pre-12.10), rather than crashing when
 * `percentile_cont()` isn't callable.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TraceStore } from '../trace-store.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('@dorkos/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dorkos/db')>();
  return {
    ...actual,
    hasPercentileSupport: vi.fn(() => false),
  };
});

describe('TraceStore#getMetrics — percentile feature-detection fallback', () => {
  let store: TraceStore;
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    store = new TraceStore(db);
  });

  it('never crashes and returns null percentiles when percentile_cont() is unavailable', () => {
    store.insertSpan({ messageId: 'msg-001', traceId: 't1', subject: 's1', status: 'delivered' });
    store.updateSpan('msg-001', { deliveredAt: new Date().toISOString() });
    store.insertSpan({ messageId: 'msg-002', traceId: 't2', subject: 's1', status: 'delivered' });
    store.updateSpan('msg-002', { deliveredAt: new Date().toISOString() });

    let metrics: ReturnType<TraceStore['getMetrics']> | undefined;
    expect(() => {
      metrics = store.getMetrics();
    }).not.toThrow();

    expect(metrics!.totalMessages).toBe(2);
    expect(metrics!.deliveredCount).toBe(2);
    // AVG has no dependency on the percentile extension, so it still works.
    expect(metrics!.avgDeliveryLatencyMs).not.toBeNull();
    // The percentile columns fail soft to null instead of throwing.
    expect(metrics!.p50DeliveryLatencyMs).toBeNull();
    expect(metrics!.p95DeliveryLatencyMs).toBeNull();
    expect(metrics!.p99DeliveryLatencyMs).toBeNull();
  });
});

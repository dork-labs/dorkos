import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentRegistry } from '../agent-registry.js';
import { BudgetMapper } from '../budget-mapper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let registry: AgentRegistry;
let mapper: BudgetMapper;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-budget-test-'));
  const dbPath = path.join(tmpDir, 'mesh.db');
  registry = new AgentRegistry(dbPath);
  mapper = new BudgetMapper(registry.database);
});

afterEach(async () => {
  registry.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('budget_counters table migration', () => {
  it('creates budget_counters table at version 3', () => {
    const version = registry.database.pragma('user_version', { simple: true });
    expect(version).toBeGreaterThanOrEqual(3);

    // Verify table exists by running a query
    const row = registry.database
      .prepare('SELECT COUNT(*) AS cnt FROM budget_counters')
      .get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

describe('checkBudget', () => {
  it('returns allowed with full remaining for a fresh agent', () => {
    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: true, remaining: 100 });
  });

  it('reflects recorded calls in remaining count', () => {
    mapper.recordCall('agent-001');
    mapper.recordCall('agent-001');
    mapper.recordCall('agent-001');

    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: true, remaining: 97 });
  });

  it('returns denied when budget is exhausted', () => {
    for (let i = 0; i < 100; i++) {
      mapper.recordCall('agent-001');
    }

    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: false, used: 100 });
  });

  it('returns denied when calls exceed budget', () => {
    for (let i = 0; i < 105; i++) {
      mapper.recordCall('agent-001');
    }

    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: false, used: 105 });
  });

  it('tracks agents independently', () => {
    for (let i = 0; i < 50; i++) {
      mapper.recordCall('agent-001');
    }
    mapper.recordCall('agent-002');

    const r1 = mapper.checkBudget('agent-001', 100);
    const r2 = mapper.checkBudget('agent-002', 100);

    expect(r1).toEqual({ allowed: true, remaining: 50 });
    expect(r2).toEqual({ allowed: true, remaining: 99 });
  });
});

// ---------------------------------------------------------------------------
// recordCall
// ---------------------------------------------------------------------------

describe('recordCall', () => {
  it('aggregates multiple calls within the same minute bucket', () => {
    // All calls happen in the same test instant (same minute bucket)
    mapper.recordCall('agent-001');
    mapper.recordCall('agent-001');
    mapper.recordCall('agent-001');

    // Verify the bucket has count=3 via a raw query
    const nowMinute = mapper.currentMinuteBucket();
    const row = registry.database
      .prepare('SELECT call_count FROM budget_counters WHERE agent_id = ? AND bucket_minute = ?')
      .get('agent-001', nowMinute) as { call_count: number };
    expect(row.call_count).toBe(3);
  });

  it('uses SQLite UPSERT correctly for concurrent-like calls', () => {
    // Simulate multiple rapid calls (all same bucket due to same timestamp)
    for (let i = 0; i < 10; i++) {
      mapper.recordCall('agent-001');
    }

    const nowMinute = mapper.currentMinuteBucket();
    const rows = registry.database
      .prepare('SELECT * FROM budget_counters WHERE agent_id = ?')
      .all('agent-001') as Array<{ agent_id: string; bucket_minute: number; call_count: number }>;

    // Should be exactly one row for this minute
    expect(rows.length).toBe(1);
    expect(rows[0]!.call_count).toBe(10);
    expect(rows[0]!.bucket_minute).toBe(nowMinute);
  });
});

// ---------------------------------------------------------------------------
// Sliding window behavior
// ---------------------------------------------------------------------------

describe('sliding window', () => {
  it('does not count calls older than 60 minutes', () => {
    const nowMinute = mapper.currentMinuteBucket();
    const oldBucket = nowMinute - 61; // 61 minutes ago — outside the window

    // Insert old bucket directly
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', oldBucket, 50);

    // These old calls should NOT be counted
    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: true, remaining: 100 });
  });

  it('counts calls within the 60-minute window', () => {
    const nowMinute = mapper.currentMinuteBucket();
    const recentBucket = nowMinute - 30; // 30 minutes ago — inside the window

    // Insert recent bucket directly
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', recentBucket, 40);

    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: true, remaining: 60 });
  });

  it('counts calls at the window boundary (exactly 60 minutes ago)', () => {
    const nowMinute = mapper.currentMinuteBucket();
    const boundaryBucket = nowMinute - 60; // Exactly at window start

    // windowStart = nowMinute - 60, query is bucket_minute >= windowStart
    // so bucket at nowMinute - 60 IS included
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', boundaryBucket, 25);

    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: true, remaining: 75 });
  });

  it('sums across multiple buckets within the window', () => {
    const nowMinute = mapper.currentMinuteBucket();

    // Insert calls at various times within the window
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', nowMinute - 10, 20);
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', nowMinute - 30, 30);
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', nowMinute - 50, 15);

    const result = mapper.checkBudget('agent-001', 100);
    expect(result).toEqual({ allowed: true, remaining: 35 });
  });
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

describe('pruning', () => {
  it('removes buckets older than 120 minutes on checkBudget', () => {
    const nowMinute = mapper.currentMinuteBucket();
    const veryOldBucket = nowMinute - 130; // 130 minutes ago

    // Insert very old bucket directly
    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', veryOldBucket, 99);

    // checkBudget triggers lazy pruning
    mapper.checkBudget('agent-001', 100);

    // Verify the old bucket was pruned
    const row = registry.database
      .prepare('SELECT COUNT(*) AS cnt FROM budget_counters WHERE bucket_minute = ?')
      .get(veryOldBucket) as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it('preserves buckets within 120-minute prune window', () => {
    const nowMinute = mapper.currentMinuteBucket();
    const recentBucket = nowMinute - 90; // 90 minutes ago — outside 60-min window but inside prune window

    registry.database
      .prepare('INSERT INTO budget_counters (agent_id, bucket_minute, call_count) VALUES (?, ?, ?)')
      .run('agent-001', recentBucket, 10);

    mapper.checkBudget('agent-001', 100);

    // The bucket at 90 minutes should NOT be pruned (< 120 minutes)
    const row = registry.database
      .prepare('SELECT COUNT(*) AS cnt FROM budget_counters WHERE bucket_minute = ?')
      .get(recentBucket) as { cnt: number };
    expect(row.cnt).toBe(1);
  });
});

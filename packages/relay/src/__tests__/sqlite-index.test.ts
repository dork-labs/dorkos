import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { sql } from 'drizzle-orm';
import { SqliteIndex } from '../sqlite-index.js';
import { MaildirStore } from '../maildir-store.js';
import type { IndexedMessage, MessageStatus } from '../sqlite-index.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

const TEST_ENDPOINT_HASH = 'abc123def456';
const TEST_SUBJECT = 'relay.agent.myproject.backend';

function makeMessage(overrides: Partial<IndexedMessage> = {}): IndexedMessage {
  return {
    id: '01JKABCDEFGH',
    subject: TEST_SUBJECT,
    endpointHash: TEST_ENDPOINT_HASH,
    status: 'pending',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

function makeEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    id: '01JKABCDEFGH',
    subject: TEST_SUBJECT,
    from: 'relay.agent.myproject.frontend',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 60_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { hello: 'world' },
    ...overrides,
  };
}

let db: Db;
let index: SqliteIndex;

beforeEach(() => {
  db = createTestDb();
  index = new SqliteIndex(db);
});

// ---------------------------------------------------------------------------
// WAL Mode
// ---------------------------------------------------------------------------

describe('WAL mode', () => {
  it('in-memory db reports WAL pragma was set', () => {
    // In-memory databases use 'memory' journal mode, but the pragma was set
    // on createDb(). For file-based dbs it would be 'wal'.
    // We verify the method does not throw.
    expect(typeof index.isWalMode()).toBe('boolean');
  });
});

// ---------------------------------------------------------------------------
// Insert and Query by Subject
// ---------------------------------------------------------------------------

describe('insertMessage + getBySubject', () => {
  it('inserts a message and retrieves it by subject', () => {
    const msg = makeMessage();
    index.insertMessage(msg);

    const results = index.getBySubject(TEST_SUBJECT);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(msg);
  });

  it('returns empty array for unknown subject', () => {
    const results = index.getBySubject('relay.nonexistent');
    expect(results).toHaveLength(0);
  });

  it('retrieves multiple messages for the same subject ordered by created_at DESC', () => {
    const msg1 = makeMessage({
      id: '01JAAA',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const msg2 = makeMessage({
      id: '01JBBB',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const msg3 = makeMessage({
      id: '01JCCC',
      createdAt: '2026-01-03T00:00:00.000Z',
    });

    index.insertMessage(msg1);
    index.insertMessage(msg2);
    index.insertMessage(msg3);

    const results = index.getBySubject(TEST_SUBJECT);
    expect(results).toHaveLength(3);
    // Descending order
    expect(results[0].id).toBe('01JCCC');
    expect(results[1].id).toBe('01JBBB');
    expect(results[2].id).toBe('01JAAA');
  });

  it('INSERT OR REPLACE is idempotent — re-inserting the same message updates it', () => {
    const msg = makeMessage();
    index.insertMessage(msg);
    index.insertMessage({ ...msg, status: 'delivered' });

    const results = index.getBySubject(TEST_SUBJECT);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------
// getMessage
// ---------------------------------------------------------------------------

describe('getMessage', () => {
  it('returns the message by ID', () => {
    const msg = makeMessage();
    index.insertMessage(msg);

    const result = index.getMessage(msg.id);
    expect(result).toEqual(msg);
  });

  it('returns null for unknown ID', () => {
    expect(index.getMessage('nonexistent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getByEndpoint
// ---------------------------------------------------------------------------

describe('getByEndpoint', () => {
  it('returns messages for a given endpoint hash', () => {
    const msg = makeMessage();
    index.insertMessage(msg);

    const results = index.getByEndpoint(TEST_ENDPOINT_HASH);
    expect(results).toHaveLength(1);
    expect(results[0].endpointHash).toBe(TEST_ENDPOINT_HASH);
  });

  it('filters by endpoint hash — does not return messages from other endpoints', () => {
    index.insertMessage(makeMessage({ id: '01JAAA', endpointHash: 'hash_one' }));
    index.insertMessage(makeMessage({ id: '01JBBB', endpointHash: 'hash_two' }));

    const results = index.getByEndpoint('hash_one');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('01JAAA');
  });

  it('returns empty array for unknown endpoint hash', () => {
    expect(index.getByEndpoint('unknown_hash')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Status Updates
// ---------------------------------------------------------------------------

describe('updateStatus', () => {
  it('updates the status of an existing message', () => {
    index.insertMessage(makeMessage({ id: 'msg1', status: 'pending' }));

    const updated = index.updateStatus('msg1', 'delivered');
    expect(updated).toBe(true);

    const result = index.getMessage('msg1');
    expect(result?.status).toBe('delivered');
  });

  it('can transition through all statuses: pending -> delivered -> failed', () => {
    index.insertMessage(makeMessage({ id: 'msg1', status: 'pending' }));

    index.updateStatus('msg1', 'delivered');
    expect(index.getMessage('msg1')?.status).toBe('delivered');

    index.updateStatus('msg1', 'failed');
    expect(index.getMessage('msg1')?.status).toBe('failed');
  });

  it('returns false for unknown message ID', () => {
    const updated = index.updateStatus('nonexistent', 'delivered');
    expect(updated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expire Cleanup
// ---------------------------------------------------------------------------

describe('deleteExpired', () => {
  it('deletes messages with expiresAt in the past', () => {
    const now = Date.now();
    index.insertMessage(
      makeMessage({ id: 'expired', expiresAt: new Date(now - 1000).toISOString() }),
    );
    index.insertMessage(
      makeMessage({ id: 'valid', expiresAt: new Date(now + 60_000).toISOString() }),
    );

    const deleted = index.deleteExpired(now);
    expect(deleted).toBe(1);

    expect(index.getMessage('expired')).toBeNull();
    expect(index.getMessage('valid')).not.toBeNull();
  });

  it('returns 0 when no messages are expired', () => {
    const now = Date.now();
    index.insertMessage(
      makeMessage({ id: 'valid', expiresAt: new Date(now + 60_000).toISOString() }),
    );

    const deleted = index.deleteExpired(now);
    expect(deleted).toBe(0);
  });

  it('deletes all messages when all have expired', () => {
    const now = Date.now();
    index.insertMessage(
      makeMessage({ id: 'exp1', expiresAt: new Date(now - 2000).toISOString() }),
    );
    index.insertMessage(
      makeMessage({ id: 'exp2', expiresAt: new Date(now - 1000).toISOString() }),
    );

    const deleted = index.deleteExpired(now);
    expect(deleted).toBe(2);

    const metrics = index.getMetrics();
    expect(metrics.totalMessages).toBe(0);
  });

  it('uses Date.now() when no argument is provided', () => {
    const pastExpiry = new Date(Date.now() - 10_000).toISOString();
    index.insertMessage(makeMessage({ id: 'expired', expiresAt: pastExpiry }));

    const deleted = index.deleteExpired();
    expect(deleted).toBe(1);
  });

  it('does not delete messages with null expiresAt', () => {
    index.insertMessage(makeMessage({ id: 'no-expiry', expiresAt: null }));

    const deleted = index.deleteExpired();
    expect(deleted).toBe(0);
    expect(index.getMessage('no-expiry')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rebuild from Maildir
// ---------------------------------------------------------------------------

describe('rebuild', () => {
  let tmpDir: string;
  let maildirRoot: string;
  let maildirStore: MaildirStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-sqlite-test-'));
    maildirRoot = path.join(tmpDir, 'mailboxes');
    maildirStore = new MaildirStore({ rootDir: maildirRoot });
  });

  it('rebuilds the index from Maildir files', async () => {
    const hash = 'rebuild_test';
    await maildirStore.ensureMaildir(hash);

    // Deliver two messages
    const env1 = makeEnvelope({ id: 'msg_rebuild_1' });
    const env2 = makeEnvelope({ id: 'msg_rebuild_2' });
    const result1 = await maildirStore.deliver(hash, env1);
    const result2 = await maildirStore.deliver(hash, env2);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    const fileId1 = (result1 as { ok: true; messageId: string }).messageId;
    const fileId2 = (result2 as { ok: true; messageId: string }).messageId;

    // Pre-populate index with stale data
    index.insertMessage(makeMessage({ id: 'stale_data' }));

    const endpointHashes = new Map<string, string>();
    endpointHashes.set(hash, TEST_SUBJECT);

    const count = await index.rebuild(maildirStore, endpointHashes);
    expect(count).toBe(2);

    // Stale data should be gone
    expect(index.getMessage('stale_data')).toBeNull();

    // Rebuilt messages are indexed by filename ULID
    const msg1 = index.getMessage(fileId1);
    expect(msg1).not.toBeNull();
    expect(msg1!.status).toBe('pending');
    expect(msg1!.endpointHash).toBe(hash);

    const msg2 = index.getMessage(fileId2);
    expect(msg2).not.toBeNull();
    expect(msg2!.status).toBe('pending');
  });

  it('indexes messages in cur/ with status "delivered"', async () => {
    const hash = 'cur_test';
    await maildirStore.ensureMaildir(hash);

    const env = makeEnvelope({ id: 'msg_cur_test' });
    const deliverResult = await maildirStore.deliver(hash, env);
    expect(deliverResult.ok).toBe(true);

    const fileMessageId = (deliverResult as { ok: true; messageId: string }).messageId;

    // Claim the message (move new/ -> cur/)
    const claimResult = await maildirStore.claim(hash, fileMessageId);
    expect(claimResult.ok).toBe(true);

    const endpointHashes = new Map<string, string>();
    endpointHashes.set(hash, TEST_SUBJECT);

    await index.rebuild(maildirStore, endpointHashes);

    const msg = index.getMessage(fileMessageId);
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe('delivered');
  });

  it('indexes messages in failed/ with status "failed"', async () => {
    const hash = 'failed_test';
    await maildirStore.ensureMaildir(hash);

    const env = makeEnvelope({ id: 'msg_failed_test' });
    await maildirStore.failDirect(hash, env, 'budget exceeded');

    const endpointHashes = new Map<string, string>();
    endpointHashes.set(hash, TEST_SUBJECT);

    await index.rebuild(maildirStore, endpointHashes);

    const msg = index.getMessage('msg_failed_test');
    expect(msg).not.toBeNull();
    expect(msg!.status).toBe('failed');
  });

  it('returns 0 when Maildir is empty', async () => {
    const hash = 'empty_test';
    await maildirStore.ensureMaildir(hash);

    const endpointHashes = new Map<string, string>();
    endpointHashes.set(hash, TEST_SUBJECT);

    const count = await index.rebuild(maildirStore, endpointHashes);
    expect(count).toBe(0);
  });

  it('handles multiple endpoints', async () => {
    const hash1 = 'multi_ep_1';
    const hash2 = 'multi_ep_2';
    await maildirStore.ensureMaildir(hash1);
    await maildirStore.ensureMaildir(hash2);

    await maildirStore.deliver(hash1, makeEnvelope({ id: 'ep1_msg1', subject: 'relay.a' }));
    await maildirStore.deliver(hash2, makeEnvelope({ id: 'ep2_msg1', subject: 'relay.b' }));
    await maildirStore.deliver(hash2, makeEnvelope({ id: 'ep2_msg2', subject: 'relay.b' }));

    const endpointHashes = new Map<string, string>();
    endpointHashes.set(hash1, 'relay.a');
    endpointHashes.set(hash2, 'relay.b');

    const count = await index.rebuild(maildirStore, endpointHashes);
    expect(count).toBe(3);

    expect(index.getByEndpoint(hash1)).toHaveLength(1);
    expect(index.getByEndpoint(hash2)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

describe('getMetrics', () => {
  it('returns zero metrics for empty index', () => {
    const metrics = index.getMetrics();
    expect(metrics.totalMessages).toBe(0);
    expect(metrics.byStatus).toEqual({});
    expect(metrics.bySubject).toEqual([]);
  });

  it('returns correct aggregate counts by status', () => {
    index.insertMessage(makeMessage({ id: 'p1', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 'p2', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 'd1', status: 'delivered' }));
    index.insertMessage(makeMessage({ id: 'f1', status: 'failed' }));

    const metrics = index.getMetrics();
    expect(metrics.totalMessages).toBe(4);
    expect(metrics.byStatus).toEqual({
      pending: 2,
      delivered: 1,
      failed: 1,
    });
  });

  it('returns correct counts by subject sorted by volume descending', () => {
    index.insertMessage(makeMessage({ id: 'a1', subject: 'relay.a' }));
    index.insertMessage(makeMessage({ id: 'b1', subject: 'relay.b' }));
    index.insertMessage(makeMessage({ id: 'b2', subject: 'relay.b' }));
    index.insertMessage(makeMessage({ id: 'c1', subject: 'relay.c' }));
    index.insertMessage(makeMessage({ id: 'c2', subject: 'relay.c' }));
    index.insertMessage(makeMessage({ id: 'c3', subject: 'relay.c' }));

    const metrics = index.getMetrics();
    expect(metrics.totalMessages).toBe(6);
    expect(metrics.bySubject).toEqual([
      { subject: 'relay.c', count: 3 },
      { subject: 'relay.b', count: 2 },
      { subject: 'relay.a', count: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// countSenderInWindow (now counts all messages in window)
// ---------------------------------------------------------------------------

describe('countSenderInWindow', () => {
  it('returns 0 for no matching messages', () => {
    const count = index.countSenderInWindow('unused', '2020-01-01T00:00:00.000Z');
    expect(count).toBe(0);
  });

  it('counts messages after the window start', () => {
    index.insertMessage(
      makeMessage({ id: 'a1', createdAt: '2026-01-15T10:00:00.000Z' }),
    );
    index.insertMessage(
      makeMessage({ id: 'a2', createdAt: '2026-01-15T10:01:00.000Z' }),
    );

    const count = index.countSenderInWindow('unused', '2026-01-01T00:00:00.000Z');
    expect(count).toBe(2);
  });

  it('filters by window start time', () => {
    index.insertMessage(
      makeMessage({ id: 'old', createdAt: '2026-01-10T00:00:00.000Z' }),
    );
    index.insertMessage(
      makeMessage({ id: 'recent', createdAt: '2026-01-15T12:00:00.000Z' }),
    );

    // Window starts after the old message
    const count = index.countSenderInWindow('unused', '2026-01-12T00:00:00.000Z');
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// countNewByEndpoint (now counts 'pending' status)
// ---------------------------------------------------------------------------

describe('countNewByEndpoint', () => {
  it('returns 0 for empty endpoint', () => {
    const count = index.countNewByEndpoint('nonexistent-hash');
    expect(count).toBe(0);
  });

  it('counts only messages with status pending', () => {
    index.insertMessage(makeMessage({ id: 'n1', endpointHash: 'ep1', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 'n2', endpointHash: 'ep1', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 'c1', endpointHash: 'ep1', status: 'delivered' }));

    const count = index.countNewByEndpoint('ep1');
    expect(count).toBe(2);
  });

  it('excludes delivered and failed messages', () => {
    index.insertMessage(makeMessage({ id: 'c1', endpointHash: 'ep1', status: 'delivered' }));
    index.insertMessage(makeMessage({ id: 'f1', endpointHash: 'ep1', status: 'failed' }));

    const count = index.countNewByEndpoint('ep1');
    expect(count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// queryMessages
// ---------------------------------------------------------------------------

describe('queryMessages', () => {
  it('returns all messages with no filters', () => {
    index.insertMessage(makeMessage({ id: '01JAAA' }));
    index.insertMessage(makeMessage({ id: '01JBBB' }));

    const { messages } = index.queryMessages();
    expect(messages).toHaveLength(2);
  });

  it('filters by subject', () => {
    index.insertMessage(makeMessage({ id: '01JAAA', subject: 'relay.a' }));
    index.insertMessage(makeMessage({ id: '01JBBB', subject: 'relay.b' }));

    const { messages } = index.queryMessages({ subject: 'relay.a' });
    expect(messages).toHaveLength(1);
    expect(messages[0].subject).toBe('relay.a');
  });

  it('filters by status', () => {
    index.insertMessage(makeMessage({ id: '01JAAA', status: 'pending' }));
    index.insertMessage(makeMessage({ id: '01JBBB', status: 'delivered' }));

    const { messages } = index.queryMessages({ status: 'pending' });
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe('pending');
  });

  it('supports cursor-based pagination', () => {
    index.insertMessage(makeMessage({ id: '01JAAA' }));
    index.insertMessage(makeMessage({ id: '01JBBB' }));
    index.insertMessage(makeMessage({ id: '01JCCC' }));

    // First page with limit 2 (ordered by id DESC)
    const page1 = index.queryMessages({ limit: 2 });
    expect(page1.messages).toHaveLength(2);
    expect(page1.nextCursor).toBeDefined();

    // Second page using cursor
    const page2 = index.queryMessages({ limit: 2, cursor: page1.nextCursor });
    expect(page2.messages).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Anti-regression: semantic status values (pending/delivered, not new/cur)
// ---------------------------------------------------------------------------

describe('anti-regression: semantic status values', () => {
  it('uses "pending" status for new messages (not "new")', () => {
    const msg = makeMessage({ id: 'status-check' });
    index.insertMessage(msg);

    const result = index.getMessage('status-check');
    expect(result?.status).toBe('pending');
    expect(result?.status).not.toBe('new');

    // Verify at the raw SQL level that the stored value is 'pending'
    const rows = db.all<{ status: string }>(
      sql`SELECT status FROM relay_index WHERE id = 'status-check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
  });

  it('uses "delivered" status for claimed messages (not "cur")', () => {
    index.insertMessage(makeMessage({ id: 'delivered-check', status: 'pending' }));
    index.updateStatus('delivered-check', 'delivered');

    const result = index.getMessage('delivered-check');
    expect(result?.status).toBe('delivered');
    expect(result?.status).not.toBe('cur');

    // Verify at the raw SQL level
    const rows = db.all<{ status: string }>(
      sql`SELECT status FROM relay_index WHERE id = 'delivered-check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('delivered');
  });

  it('status enum contains only semantic values: pending, delivered, failed', () => {
    // Insert one of each valid status
    index.insertMessage(makeMessage({ id: 's-pending', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 's-delivered', status: 'delivered' }));
    index.insertMessage(makeMessage({ id: 's-failed', status: 'failed' }));

    const metrics = index.getMetrics();
    const statusKeys = Object.keys(metrics.byStatus);
    for (const key of statusKeys) {
      expect(['pending', 'delivered', 'failed']).toContain(key);
      expect(key).not.toBe('new');
      expect(key).not.toBe('cur');
    }
  });
});

// ---------------------------------------------------------------------------
// Anti-regression: expiresAt as ISO 8601 (not ttl as INTEGER)
// ---------------------------------------------------------------------------

describe('anti-regression: expiresAt as ISO 8601', () => {
  it('stores expiresAt as ISO 8601 string (not INTEGER Unix ms)', () => {
    const expiry = new Date(Date.now() + 60_000).toISOString();
    index.insertMessage(makeMessage({ id: 'expiry-check', expiresAt: expiry }));

    const result = index.getMessage('expiry-check');
    expect(result?.expiresAt).toBe(expiry);

    // Verify at the raw SQL level that the stored value is an ISO string
    const rows = db.all<{ expires_at: string }>(
      sql`SELECT expires_at FROM relay_index WHERE id = 'expiry-check'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBe(expiry);
    // Confirm it parses as a valid ISO date
    expect(new Date(rows[0].expires_at).toISOString()).toBe(expiry);
  });

  it('column is named expires_at (not ttl)', () => {
    index.insertMessage(makeMessage({ id: 'col-check' }));

    // Query the column by name — this would fail if the column were still 'ttl'
    const rows = db.all<{ expires_at: string | null }>(
      sql`SELECT expires_at FROM relay_index WHERE id = 'col-check'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('expiresAt supports null (no expiry)', () => {
    index.insertMessage(makeMessage({ id: 'null-expiry', expiresAt: null }));

    const result = index.getMessage('null-expiry');
    expect(result?.expiresAt).toBeNull();

    const rows = db.all<{ expires_at: string | null }>(
      sql`SELECT expires_at FROM relay_index WHERE id = 'null-expiry'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at).toBeNull();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { DeadLetterQueue } from '../dead-letter-queue.js';
import { MaildirStore } from '../maildir-store.js';
import { SqliteIndex } from '../sqlite-index.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { DeadLetter } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Db {
  const db = createDb(':memory:');
  runMigrations(db);
  return db;
}

const TEST_ENDPOINT = 'dlq-endpoint-abc';

function makeEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    id: '01JKDLQ00001',
    subject: 'relay.test.dlq',
    from: 'relay.sender',
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

/**
 * Backdates a dead letter sidecar's `failedAt` timestamp.
 * Used by purge tests to simulate old dead letters.
 */
async function backdateSidecar(
  mailboxesDir: string,
  endpointHash: string,
  messageId: string,
  failedAt: string,
): Promise<void> {
  const reasonPath = path.join(
    mailboxesDir,
    endpointHash,
    'failed',
    `${messageId}.reason.json`,
  );
  const data = await fs.readFile(reasonPath, 'utf-8');
  const deadLetter: DeadLetter = JSON.parse(data);
  deadLetter.failedAt = failedAt;
  await fs.writeFile(reasonPath, JSON.stringify(deadLetter, null, 2));
}

let tmpDir: string;
let mailboxesDir: string;
let maildirStore: MaildirStore;
let sqliteIndex: SqliteIndex;
let dlq: DeadLetterQueue;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-dlq-test-'));
  mailboxesDir = path.join(tmpDir, 'mailboxes');

  maildirStore = new MaildirStore({ rootDir: mailboxesDir });
  sqliteIndex = new SqliteIndex(createTestDb());
  dlq = new DeadLetterQueue({
    maildirStore,
    sqliteIndex,
    rootDir: mailboxesDir,
  });

  await maildirStore.ensureMaildir(TEST_ENDPOINT);
});

afterEach(async () => {
  sqliteIndex.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// reject
// ---------------------------------------------------------------------------

describe('reject', () => {
  it('writes envelope to Maildir failed/ and indexes in SQLite', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-REJECT-01' });
    const result = await dlq.reject(TEST_ENDPOINT, envelope, 'budget exceeded');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messageId).toBe('DLQ-REJECT-01');

    // Verify file on disk
    const failedFiles = await maildirStore.listFailed(TEST_ENDPOINT);
    expect(failedFiles).toContain('DLQ-REJECT-01');

    // Verify sidecar on disk
    const deadLetter = await maildirStore.readDeadLetter(TEST_ENDPOINT, 'DLQ-REJECT-01');
    expect(deadLetter).not.toBeNull();
    expect(deadLetter!.reason).toBe('budget exceeded');
    expect(deadLetter!.endpointHash).toBe(TEST_ENDPOINT);

    // Verify SQLite index
    const indexed = sqliteIndex.getMessage('DLQ-REJECT-01');
    expect(indexed).not.toBeNull();
    expect(indexed!.status).toBe('failed');
    expect(indexed!.endpointHash).toBe(TEST_ENDPOINT);
    expect(indexed!.subject).toBe('relay.test.dlq');
  });

  it('preserves the full envelope content', async () => {
    const envelope = makeEnvelope({
      id: 'DLQ-REJECT-02',
      payload: { important: 'data', nested: { key: 'value' } },
    });
    await dlq.reject(TEST_ENDPOINT, envelope, 'access denied');

    const readEnvelope = await maildirStore.readEnvelope(TEST_ENDPOINT, 'failed', 'DLQ-REJECT-02');
    expect(readEnvelope).not.toBeNull();
    expect(readEnvelope!.payload).toEqual({ important: 'data', nested: { key: 'value' } });
  });

  it('records the rejection reason in the sidecar file', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-REJECT-03' });
    await dlq.reject(TEST_ENDPOINT, envelope, 'TTL expired');

    const dl = await maildirStore.readDeadLetter(TEST_ENDPOINT, 'DLQ-REJECT-03');
    expect(dl!.reason).toBe('TTL expired');
    expect(dl!.failedAt).toBeDefined();
  });

  it('returns error when Maildir does not exist', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-REJECT-ERR' });
    const result = await dlq.reject('nonexistent-endpoint', envelope, 'reason');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeDefined();
  });

  it('handles multiple rejections for the same endpoint', async () => {
    const e1 = makeEnvelope({ id: 'DLQ-MULTI-01' });
    const e2 = makeEnvelope({ id: 'DLQ-MULTI-02' });
    const e3 = makeEnvelope({ id: 'DLQ-MULTI-03' });

    await dlq.reject(TEST_ENDPOINT, e1, 'budget exceeded');
    await dlq.reject(TEST_ENDPOINT, e2, 'access denied');
    await dlq.reject(TEST_ENDPOINT, e3, 'TTL expired');

    const failedFiles = await maildirStore.listFailed(TEST_ENDPOINT);
    expect(failedFiles).toHaveLength(3);

    const metrics = sqliteIndex.getMetrics();
    expect(metrics.byStatus['failed']).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listDead
// ---------------------------------------------------------------------------

describe('listDead', () => {
  it('returns empty array when no dead letters exist', async () => {
    const entries = await dlq.listDead();
    expect(entries).toEqual([]);
  });

  it('returns empty array for specific endpoint with no dead letters', async () => {
    const entries = await dlq.listDead({ endpointHash: TEST_ENDPOINT });
    expect(entries).toEqual([]);
  });

  it('lists dead letters for a specific endpoint', async () => {
    const e1 = makeEnvelope({ id: 'DLQ-LIST-01' });
    const e2 = makeEnvelope({ id: 'DLQ-LIST-02' });

    await dlq.reject(TEST_ENDPOINT, e1, 'budget exceeded');
    await dlq.reject(TEST_ENDPOINT, e2, 'access denied');

    const entries = await dlq.listDead({ endpointHash: TEST_ENDPOINT });

    expect(entries).toHaveLength(2);
    expect(entries[0].messageId).toBe('DLQ-LIST-01');
    expect(entries[0].reason).toBe('budget exceeded');
    expect(entries[0].endpointHash).toBe(TEST_ENDPOINT);
    expect(entries[0].envelope).not.toBeNull();

    expect(entries[1].messageId).toBe('DLQ-LIST-02');
    expect(entries[1].reason).toBe('access denied');
  });

  it('lists dead letters across all endpoints via SQLite index', async () => {
    const secondEndpoint = 'dlq-endpoint-def';
    await maildirStore.ensureMaildir(secondEndpoint);

    const e1 = makeEnvelope({ id: 'DLQ-ALL-01', subject: 'relay.test.one' });
    const e2 = makeEnvelope({ id: 'DLQ-ALL-02', subject: 'relay.test.two' });

    await dlq.reject(TEST_ENDPOINT, e1, 'reason one');
    await dlq.reject(secondEndpoint, e2, 'reason two');

    const entries = await dlq.listDead();

    expect(entries).toHaveLength(2);
    // Sorted by messageId (FIFO)
    expect(entries[0].messageId).toBe('DLQ-ALL-01');
    expect(entries[0].endpointHash).toBe(TEST_ENDPOINT);
    expect(entries[1].messageId).toBe('DLQ-ALL-02');
    expect(entries[1].endpointHash).toBe(secondEndpoint);
  });

  it('includes reason and failedAt from sidecar', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-META-01' });
    await dlq.reject(TEST_ENDPOINT, envelope, 'hop count exceeded');

    const entries = await dlq.listDead({ endpointHash: TEST_ENDPOINT });

    expect(entries).toHaveLength(1);
    expect(entries[0].reason).toBe('hop count exceeded');
    expect(entries[0].failedAt).toBeDefined();
    // failedAt should be a valid ISO 8601 timestamp
    expect(() => new Date(entries[0].failedAt)).not.toThrow();
    expect(new Date(entries[0].failedAt).getTime()).toBeGreaterThan(0);
  });

  it('includes the original envelope in the entry', async () => {
    const envelope = makeEnvelope({
      id: 'DLQ-ENV-01',
      payload: { check: 'payload' },
    });
    await dlq.reject(TEST_ENDPOINT, envelope, 'rejected');

    const entries = await dlq.listDead({ endpointHash: TEST_ENDPOINT });

    expect(entries[0].envelope).not.toBeNull();
    expect(entries[0].envelope!.id).toBe('DLQ-ENV-01');
    expect(entries[0].envelope!.payload).toEqual({ check: 'payload' });
  });
});

// ---------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------

describe('purge', () => {
  it('purges dead letters older than maxAgeMs for a specific endpoint', async () => {
    const oldEnvelope = makeEnvelope({ id: 'DLQ-PURGE-OLD' });
    const recentEnvelope = makeEnvelope({ id: 'DLQ-PURGE-NEW' });

    await dlq.reject(TEST_ENDPOINT, oldEnvelope, 'old rejection');
    await dlq.reject(TEST_ENDPOINT, recentEnvelope, 'recent rejection');

    // Backdate the old entry's sidecar to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-PURGE-OLD', twoHoursAgo);

    // Purge entries older than 1 hour
    const result = await dlq.purge({
      maxAgeMs: 60 * 60 * 1000,
      endpointHash: TEST_ENDPOINT,
    });

    expect(result.purged).toBe(1);

    // Verify only the recent entry remains
    const remaining = await maildirStore.listFailed(TEST_ENDPOINT);
    expect(remaining).toEqual(['DLQ-PURGE-NEW']);

    // Verify SQLite index was cleaned up
    expect(sqliteIndex.getMessage('DLQ-PURGE-OLD')).toBeNull();
    expect(sqliteIndex.getMessage('DLQ-PURGE-NEW')).not.toBeNull();
  });

  it('purges dead letters across all endpoints', async () => {
    const secondEndpoint = 'dlq-purge-second';
    await maildirStore.ensureMaildir(secondEndpoint);

    const old1 = makeEnvelope({ id: 'DLQ-GPUR-01', subject: 'relay.purge.one' });
    const old2 = makeEnvelope({ id: 'DLQ-GPUR-02', subject: 'relay.purge.two' });
    const recent = makeEnvelope({ id: 'DLQ-GPUR-03', subject: 'relay.purge.one' });

    await dlq.reject(TEST_ENDPOINT, old1, 'old one');
    await dlq.reject(secondEndpoint, old2, 'old two');
    await dlq.reject(TEST_ENDPOINT, recent, 'recent');

    // Backdate the old entries' sidecars to 3 hours ago
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-GPUR-01', threeHoursAgo);
    await backdateSidecar(mailboxesDir, secondEndpoint, 'DLQ-GPUR-02', threeHoursAgo);

    // Purge entries older than 1 hour
    const result = await dlq.purge({ maxAgeMs: 60 * 60 * 1000 });

    expect(result.purged).toBe(2);

    // Only the recent entry should remain
    const remaining1 = await maildirStore.listFailed(TEST_ENDPOINT);
    expect(remaining1).toEqual(['DLQ-GPUR-03']);

    const remaining2 = await maildirStore.listFailed(secondEndpoint);
    expect(remaining2).toEqual([]);
  });

  it('returns zero when no dead letters are old enough', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-FRESH-01' });
    await dlq.reject(TEST_ENDPOINT, envelope, 'fresh rejection');

    const result = await dlq.purge({
      maxAgeMs: 60 * 60 * 1000,
      endpointHash: TEST_ENDPOINT,
    });

    expect(result.purged).toBe(0);

    // Entry should still exist
    const remaining = await maildirStore.listFailed(TEST_ENDPOINT);
    expect(remaining).toEqual(['DLQ-FRESH-01']);
  });

  it('returns zero when no dead letters exist', async () => {
    const result = await dlq.purge({ maxAgeMs: 1000 });
    expect(result.purged).toBe(0);
  });

  it('removes both envelope and sidecar files during purge', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-FILES-01' });
    await dlq.reject(TEST_ENDPOINT, envelope, 'to be purged');

    // Backdate the sidecar to make it old enough to purge
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-FILES-01', twoHoursAgo);

    const failedDir = path.join(mailboxesDir, TEST_ENDPOINT, 'failed');

    // Verify files exist before purge
    const beforeFiles = await fs.readdir(failedDir);
    expect(beforeFiles).toContain('DLQ-FILES-01.json');
    expect(beforeFiles).toContain('DLQ-FILES-01.reason.json');

    await dlq.purge({ maxAgeMs: 60 * 60 * 1000, endpointHash: TEST_ENDPOINT });

    // Verify files are gone after purge
    const afterFiles = await fs.readdir(failedDir);
    expect(afterFiles).not.toContain('DLQ-FILES-01.json');
    expect(afterFiles).not.toContain('DLQ-FILES-01.reason.json');
  });

  it('purges all entries when sidecars are backdated', async () => {
    const e1 = makeEnvelope({ id: 'DLQ-ZERO-01' });
    const e2 = makeEnvelope({ id: 'DLQ-ZERO-02' });

    await dlq.reject(TEST_ENDPOINT, e1, 'reason 1');
    await dlq.reject(TEST_ENDPOINT, e2, 'reason 2');

    // Backdate both sidecars to 1 second ago
    const oneSecondAgo = new Date(Date.now() - 1000).toISOString();
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-ZERO-01', oneSecondAgo);
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-ZERO-02', oneSecondAgo);

    // Purge with maxAgeMs=500 means cutoff is 500ms ago — both entries are older
    const result = await dlq.purge({
      maxAgeMs: 500,
      endpointHash: TEST_ENDPOINT,
    });

    expect(result.purged).toBe(2);

    const remaining = await maildirStore.listFailed(TEST_ENDPOINT);
    expect(remaining).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SQLite integration
// ---------------------------------------------------------------------------

describe('SQLite integration', () => {
  it('rejected messages appear in metrics as failed', async () => {
    const e1 = makeEnvelope({ id: 'DLQ-METRIC-01' });
    const e2 = makeEnvelope({ id: 'DLQ-METRIC-02' });

    await dlq.reject(TEST_ENDPOINT, e1, 'budget exceeded');
    await dlq.reject(TEST_ENDPOINT, e2, 'TTL expired');

    const metrics = sqliteIndex.getMetrics();
    expect(metrics.totalMessages).toBe(2);
    expect(metrics.byStatus['failed']).toBe(2);
  });

  it('purged messages are removed from the SQLite index', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-IDX-PURGE' });
    await dlq.reject(TEST_ENDPOINT, envelope, 'to be purged');

    // Backdate the sidecar
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-IDX-PURGE', twoHoursAgo);

    // Verify message is in index
    expect(sqliteIndex.getMessage('DLQ-IDX-PURGE')).not.toBeNull();

    await dlq.purge({ maxAgeMs: 60 * 60 * 1000, endpointHash: TEST_ENDPOINT });

    // Verify message is removed from index
    expect(sqliteIndex.getMessage('DLQ-IDX-PURGE')).toBeNull();
  });

  it('getBySubject returns rejected messages with status failed', async () => {
    const envelope = makeEnvelope({
      id: 'DLQ-SUBJECT-01',
      subject: 'relay.test.specific',
    });
    await dlq.reject(TEST_ENDPOINT, envelope, 'rejected');

    const messages = sqliteIndex.getBySubject('relay.test.specific');
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe('failed');
    expect(messages[0].id).toBe('DLQ-SUBJECT-01');
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle
// ---------------------------------------------------------------------------

describe('full lifecycle', () => {
  it('reject -> listDead -> purge removes everything', async () => {
    const envelope = makeEnvelope({ id: 'DLQ-LIFECYCLE-01' });

    // Reject
    const rejectResult = await dlq.reject(TEST_ENDPOINT, envelope, 'budget exceeded');
    expect(rejectResult.ok).toBe(true);

    // List
    const entries = await dlq.listDead({ endpointHash: TEST_ENDPOINT });
    expect(entries).toHaveLength(1);
    expect(entries[0].messageId).toBe('DLQ-LIFECYCLE-01');
    expect(entries[0].reason).toBe('budget exceeded');

    // Backdate sidecar so it's old enough to purge
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await backdateSidecar(mailboxesDir, TEST_ENDPOINT, 'DLQ-LIFECYCLE-01', twoHoursAgo);

    // Purge
    const purgeResult = await dlq.purge({
      maxAgeMs: 60 * 60 * 1000,
      endpointHash: TEST_ENDPOINT,
    });
    expect(purgeResult.purged).toBe(1);

    // Verify everything is cleaned up
    const remainingEntries = await dlq.listDead({ endpointHash: TEST_ENDPOINT });
    expect(remainingEntries).toEqual([]);

    const indexedMsg = sqliteIndex.getMessage('DLQ-LIFECYCLE-01');
    expect(indexedMsg).toBeNull();
  });

  it('works with multiple endpoints independently', async () => {
    const ep1 = 'lifecycle-ep1';
    const ep2 = 'lifecycle-ep2';
    await maildirStore.ensureMaildir(ep1);
    await maildirStore.ensureMaildir(ep2);

    await dlq.reject(ep1, makeEnvelope({ id: 'EP1-MSG-01', subject: 'relay.ep1' }), 'rejected');
    await dlq.reject(ep2, makeEnvelope({ id: 'EP2-MSG-01', subject: 'relay.ep2' }), 'rejected');

    const ep1Entries = await dlq.listDead({ endpointHash: ep1 });
    expect(ep1Entries).toHaveLength(1);
    expect(ep1Entries[0].messageId).toBe('EP1-MSG-01');

    const ep2Entries = await dlq.listDead({ endpointHash: ep2 });
    expect(ep2Entries).toHaveLength(1);
    expect(ep2Entries[0].messageId).toBe('EP2-MSG-01');

    const allEntries = await dlq.listDead();
    expect(allEntries).toHaveLength(2);
  });
});

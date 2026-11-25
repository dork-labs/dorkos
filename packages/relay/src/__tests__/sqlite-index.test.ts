import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { SqliteIndex } from '../sqlite-index.js';
import { MaildirStore } from '../maildir-store.js';
import type { IndexedMessage } from '../sqlite-index.js';
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
    sender: null,
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

// ---------------------------------------------------------------------------
// Insert and Query by Subject
// ---------------------------------------------------------------------------

describe('insertMessage + getBySubject', () => {
  it('preserves existing sender/expiresAt when the SAME row is re-written omitting them (H2)', () => {
    // The publish accounting row carries sender + expiresAt for rate limiting.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    index.insertMessage(
      makeMessage({
        id: '01JACCT',
        endpointHash: '*',
        status: 'delivered',
        sender: 'relay.agent.sender',
        expiresAt,
      })
    );

    // A re-write of the SAME (id, endpointHash) row omitting sender + expiresAt
    // must not null them: a plain overwrite would erase rate-limit accounting.
    index.insertMessage({
      id: '01JACCT',
      subject: TEST_SUBJECT,
      endpointHash: '*',
      status: 'delivered',
      createdAt: new Date().toISOString(),
      expiresAt: null,
    });

    const row = index.getMessage('01JACCT');
    expect(row?.sender).toBe('relay.agent.sender');
    expect(row?.expiresAt).toBe(expiresAt);
  });

  it('a dead-letter of the same envelope is a SEPARATE row, leaving accounting intact (H2)', () => {
    // Identity unification keys rows on (id, endpointHash). The `*` accounting
    // row and a per-endpoint dead-letter row now coexist as distinct rows, so
    // the DLQ write can no longer clobber the accounting row's sender/expiresAt.
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    index.insertMessage(
      makeMessage({
        id: '01JACCT',
        endpointHash: '*',
        status: 'delivered',
        sender: 'relay.agent.sender',
        expiresAt,
      })
    );
    index.insertMessage({
      id: '01JACCT',
      subject: TEST_SUBJECT,
      endpointHash: 'relay.agent.target',
      status: 'failed',
      createdAt: new Date().toISOString(),
      expiresAt: null,
    });

    const deliveries = index.getMessageDeliveries('01JACCT');
    expect(deliveries).toHaveLength(2);
    const accounting = deliveries.find((d) => d.endpointHash === '*');
    expect(accounting?.sender).toBe('relay.agent.sender');
    expect(accounting?.expiresAt).toBe(expiresAt);
    // getMessage prefers the real per-endpoint row over the `*` placeholder.
    expect(index.getMessage('01JACCT')?.endpointHash).toBe('relay.agent.target');
  });

  it('rate-limit accounting survives a dead-letter of the same envelope (H2)', () => {
    const windowStart = new Date(Date.now() - 60_000).toISOString();
    index.insertMessage(
      makeMessage({
        id: '01JRATE',
        endpointHash: '*',
        status: 'delivered',
        sender: 'relay.agent.sender',
      })
    );
    expect(index.countSenderInWindow('relay.agent.sender', windowStart)).toBe(1);

    index.insertMessage({
      id: '01JRATE',
      subject: TEST_SUBJECT,
      endpointHash: 'relay.agent.target',
      status: 'failed',
      createdAt: new Date().toISOString(),
      expiresAt: null,
    });
    expect(index.countSenderInWindow('relay.agent.sender', windowStart)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getMessage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// getByEndpoint
// ---------------------------------------------------------------------------

describe('getByEndpoint', () => {
  it('filters by endpoint hash — does not return messages from other endpoints', () => {
    index.insertMessage(makeMessage({ id: '01JAAA', endpointHash: 'hash_one' }));
    index.insertMessage(makeMessage({ id: '01JBBB', endpointHash: 'hash_two' }));

    const results = index.getByEndpoint('hash_one');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('01JAAA');
  });
});

// ---------------------------------------------------------------------------
// Status Updates
// ---------------------------------------------------------------------------

describe('updateStatus', () => {
  it('only touches the addressed endpoint row, not siblings sharing the id', () => {
    // One envelope id now owns a row per endpoint; a delivered/failed transition
    // must not bleed across a message's sibling deliveries.
    index.insertMessage(makeMessage({ id: 'shared', endpointHash: 'ep-a', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 'shared', endpointHash: 'ep-b', status: 'pending' }));

    index.updateStatus('shared', 'ep-a', 'delivered');

    const rows = index.getMessageDeliveries('shared');
    const byHash = Object.fromEntries(rows.map((r) => [r.endpointHash, r.status]));
    expect(byHash['ep-a']).toBe('delivered');
    expect(byHash['ep-b']).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// deleteMessage
// ---------------------------------------------------------------------------

describe('deleteMessage', () => {
  it('deletes a single row by (id, endpointHash) and reports whether it existed', () => {
    index.insertMessage(makeMessage({ id: 'gone' }));

    expect(index.deleteMessage('gone', TEST_ENDPOINT_HASH)).toBe(true);
    expect(index.getMessage('gone')).toBeNull();
    expect(index.deleteMessage('gone', TEST_ENDPOINT_HASH)).toBe(false);
  });

  it('leaves sibling endpoint rows intact when deleting one', () => {
    index.insertMessage(makeMessage({ id: 'shared', endpointHash: 'ep-a' }));
    index.insertMessage(makeMessage({ id: 'shared', endpointHash: 'ep-b' }));

    expect(index.deleteMessage('shared', 'ep-a')).toBe(true);

    const rows = index.getMessageDeliveries('shared');
    expect(rows.map((r) => r.endpointHash)).toEqual(['ep-b']);
  });
});

// ---------------------------------------------------------------------------
// getExpired
// ---------------------------------------------------------------------------

describe('getExpired', () => {
  it('returns expired non-failed rows and excludes dead letters', () => {
    const now = Date.now();
    const past = new Date(now - 1000).toISOString();
    index.insertMessage(makeMessage({ id: 'exp-pending', status: 'pending', expiresAt: past }));
    index.insertMessage(makeMessage({ id: 'exp-failed', status: 'failed', expiresAt: past }));
    index.insertMessage(
      makeMessage({
        id: 'fresh',
        status: 'pending',
        expiresAt: new Date(now + 60_000).toISOString(),
      })
    );
    index.insertMessage(makeMessage({ id: 'no-expiry', status: 'pending', expiresAt: null }));

    const expired = index.getExpired(now);
    expect(expired.map((m) => m.id)).toEqual(['exp-pending']);
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

  it('indexes messages in cur/ with status "pending" (in-flight, not delivered)', async () => {
    // A message in cur/ was claimed but not completed. The live pipeline only
    // flips a row to 'delivered' AFTER complete() removes the file, so rebuild
    // must label in-flight cur/ entries 'pending', not 'delivered' — the latter
    // was a lie that hid messages stranded by a crash between claim and complete
    // (M1). Crash recovery re-drives these back to new/ for redelivery.
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
    expect(msg!.status).toBe('pending');
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
});

// ---------------------------------------------------------------------------
// countSenderInWindow (now counts all messages in window)
// ---------------------------------------------------------------------------

describe('countSenderInWindow', () => {
  const SENDER_A = 'relay.human.slack.bot';

  it('counts messages from a specific sender after the window start', () => {
    index.insertMessage(
      makeMessage({ id: 'a1', createdAt: '2026-01-15T10:00:00.000Z', sender: SENDER_A })
    );
    index.insertMessage(
      makeMessage({ id: 'a2', createdAt: '2026-01-15T10:01:00.000Z', sender: SENDER_A })
    );

    const count = index.countSenderInWindow(SENDER_A, '2026-01-01T00:00:00.000Z');
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// queryMessages
// ---------------------------------------------------------------------------

describe('queryMessages', () => {
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
// Message identity unification: one envelope id, one row per endpoint
// ---------------------------------------------------------------------------

describe('message identity (composite id + endpointHash)', () => {
  it('stores one row per endpoint for a shared envelope id', () => {
    index.insertMessage(makeMessage({ id: 'env-1', endpointHash: '*', status: 'delivered' }));
    index.insertMessage(makeMessage({ id: 'env-1', endpointHash: 'relay.a', status: 'pending' }));
    index.insertMessage(makeMessage({ id: 'env-1', endpointHash: 'relay.b', status: 'failed' }));

    const deliveries = index.getMessageDeliveries('env-1');
    expect(deliveries.map((d) => d.endpointHash)).toEqual(['*', 'relay.a', 'relay.b']);
  });

  it('getMessage returns a real endpoint row over the synthetic accounting row', () => {
    index.insertMessage(makeMessage({ id: 'env-2', endpointHash: '*', status: 'delivered' }));
    index.insertMessage(
      makeMessage({ id: 'env-2', endpointHash: 'adapter:relay.x', status: 'delivered' })
    );
    index.insertMessage(
      makeMessage({ id: 'env-2', endpointHash: 'relay.real', status: 'pending' })
    );

    expect(index.getMessage('env-2')?.endpointHash).toBe('relay.real');
  });

  it('paginates without skipping sibling rows that share an id across a page boundary', () => {
    // Three rows share id 'B'; a bare-id cursor would skip the tail of the group.
    index.insertMessage(makeMessage({ id: '01JC', endpointHash: 'h1' }));
    index.insertMessage(makeMessage({ id: '01JB', endpointHash: 'h3' }));
    index.insertMessage(makeMessage({ id: '01JB', endpointHash: 'h2' }));
    index.insertMessage(makeMessage({ id: '01JB', endpointHash: 'h1' }));
    index.insertMessage(makeMessage({ id: '01JA', endpointHash: 'h1' }));

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const page = index.queryMessages({ limit: 2, cursor });
      seen.push(...page.messages.map((m) => `${m.id}:${m.endpointHash}`));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(seen.sort()).toEqual(['01JA:h1', '01JB:h1', '01JB:h2', '01JB:h3', '01JC:h1'].sort());
    // No duplicates leaked across pages.
    expect(new Set(seen).size).toBe(seen.length);
  });
});

// ---------------------------------------------------------------------------
// Anti-regression: expiresAt as ISO 8601 (not ttl as INTEGER)
// ---------------------------------------------------------------------------

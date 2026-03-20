import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { MaildirStore } from '../maildir-store.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { DeadLetter } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ENDPOINT = 'abc123';

function makeEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    id: '01JKABCDEFGH',
    subject: 'relay.test.subject',
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

let tmpRoot: string;
let store: MaildirStore;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-maildir-test-'));
  store = new MaildirStore({ rootDir: tmpRoot });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ensureMaildir
// ---------------------------------------------------------------------------

describe('ensureMaildir', () => {
  it('creates tmp, new, cur, and failed subdirectories', async () => {
    await store.ensureMaildir(TEST_ENDPOINT);

    const base = path.join(tmpRoot, TEST_ENDPOINT);
    for (const subdir of ['tmp', 'new', 'cur', 'failed']) {
      const stat = await fs.stat(path.join(base, subdir));
      expect(stat.isDirectory()).toBe(true);
    }
  });

  it('is idempotent — safe to call multiple times', async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
    await store.ensureMaildir(TEST_ENDPOINT);

    const base = path.join(tmpRoot, TEST_ENDPOINT);
    const stat = await fs.stat(path.join(base, 'new'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('sets directory permissions to 0o700', async () => {
    await store.ensureMaildir(TEST_ENDPOINT);

    const base = path.join(tmpRoot, TEST_ENDPOINT);
    for (const subdir of ['tmp', 'new', 'cur', 'failed']) {
      const stat = await fs.stat(path.join(base, subdir));
      // Mask with 0o777 to get only the permission bits
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// deliver
// ---------------------------------------------------------------------------

describe('deliver', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('atomically delivers an envelope to new/', async () => {
    const envelope = makeEnvelope();
    const result = await store.deliver(TEST_ENDPOINT, envelope);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.messageId).toBeDefined();
    expect(result.path).toContain('/new/');
    expect(result.path.endsWith('.json')).toBe(true);
  });

  it('creates a valid JSON file in new/', async () => {
    const envelope = makeEnvelope();
    const result = await store.deliver(TEST_ENDPOINT, envelope);
    if (!result.ok) throw new Error('deliver failed');

    const data = await fs.readFile(result.path, 'utf-8');
    const parsed = JSON.parse(data);

    expect(parsed.id).toBe(envelope.id);
    expect(parsed.subject).toBe(envelope.subject);
    expect(parsed.from).toBe(envelope.from);
    expect(parsed.payload).toEqual(envelope.payload);
  });

  it('does not leave files in tmp/ on success', async () => {
    const envelope = makeEnvelope();
    await store.deliver(TEST_ENDPOINT, envelope);

    const tmpFiles = await fs.readdir(path.join(tmpRoot, TEST_ENDPOINT, 'tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('generates unique ULID message IDs for each delivery', async () => {
    const envelope = makeEnvelope();
    const r1 = await store.deliver(TEST_ENDPOINT, envelope);
    const r2 = await store.deliver(TEST_ENDPOINT, envelope);

    if (!r1.ok || !r2.ok) throw new Error('deliver failed');
    expect(r1.messageId).not.toBe(r2.messageId);
  });

  it('generates monotonically increasing ULIDs', async () => {
    const envelope = makeEnvelope();
    const r1 = await store.deliver(TEST_ENDPOINT, envelope);
    const r2 = await store.deliver(TEST_ENDPOINT, envelope);

    if (!r1.ok || !r2.ok) throw new Error('deliver failed');
    expect(r1.messageId < r2.messageId).toBe(true);
  });

  it('sets file permissions to 0o600', async () => {
    const envelope = makeEnvelope();
    const result = await store.deliver(TEST_ENDPOINT, envelope);
    if (!result.ok) throw new Error('deliver failed');

    const stat = await fs.stat(result.path);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('returns an error when maildir does not exist', async () => {
    const result = await store.deliver('nonexistent-endpoint', makeEnvelope());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('delivery failed');
  });
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------

describe('claim', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('moves a message from new/ to cur/', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    const claimResult = await store.claim(TEST_ENDPOINT, deliverResult.messageId);

    expect(claimResult.ok).toBe(true);
    if (!claimResult.ok) return;
    expect(claimResult.path).toContain('/cur/');
    expect(claimResult.envelope.id).toBe(envelope.id);
  });

  it('removes the file from new/ after claim', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, deliverResult.messageId);

    const newFiles = await fs.readdir(path.join(tmpRoot, TEST_ENDPOINT, 'new'));
    expect(newFiles).toHaveLength(0);
  });

  it('returns the parsed envelope on successful claim', async () => {
    const envelope = makeEnvelope({ payload: { test: 'data' } });
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    const claimResult = await store.claim(TEST_ENDPOINT, deliverResult.messageId);

    if (!claimResult.ok) throw new Error('claim failed');
    expect(claimResult.envelope.subject).toBe('relay.test.subject');
    expect(claimResult.envelope.payload).toEqual({ test: 'data' });
  });

  it('returns error when message does not exist in new/', async () => {
    const result = await store.claim(TEST_ENDPOINT, 'nonexistent-message');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('claim failed');
  });

  it('only one concurrent claim succeeds (atomic rename)', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    // Race two claims against the same message
    const [r1, r2] = await Promise.all([
      store.claim(TEST_ENDPOINT, deliverResult.messageId),
      store.claim(TEST_ENDPOINT, deliverResult.messageId),
    ]);

    const successes = [r1, r2].filter((r) => r.ok);
    const failures = [r1, r2].filter((r) => !r.ok);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

describe('complete', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('removes the message file from cur/', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    const claimResult = await store.claim(TEST_ENDPOINT, deliverResult.messageId);
    if (!claimResult.ok) throw new Error('claim failed');

    await store.complete(TEST_ENDPOINT, deliverResult.messageId);

    const curFiles = await fs.readdir(path.join(tmpRoot, TEST_ENDPOINT, 'cur'));
    expect(curFiles).toHaveLength(0);
  });

  it('throws when message does not exist in cur/', async () => {
    await expect(store.complete(TEST_ENDPOINT, 'nonexistent')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

describe('fail', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('moves message from cur/ to failed/', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, deliverResult.messageId);
    const failResult = await store.fail(TEST_ENDPOINT, deliverResult.messageId, 'test failure');

    expect(failResult.ok).toBe(true);
    if (!failResult.ok) return;
    expect(failResult.path).toContain('/failed/');
  });

  it('removes the message from cur/ after failure', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, deliverResult.messageId);
    await store.fail(TEST_ENDPOINT, deliverResult.messageId, 'test failure');

    const curFiles = await fs.readdir(path.join(tmpRoot, TEST_ENDPOINT, 'cur'));
    expect(curFiles).toHaveLength(0);
  });

  it('writes a .reason.json sidecar with dead letter metadata', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, deliverResult.messageId);
    await store.fail(TEST_ENDPOINT, deliverResult.messageId, 'budget exceeded');

    const reasonPath = path.join(
      tmpRoot,
      TEST_ENDPOINT,
      'failed',
      `${deliverResult.messageId}.reason.json`
    );
    const data = await fs.readFile(reasonPath, 'utf-8');
    const deadLetter: DeadLetter = JSON.parse(data);

    expect(deadLetter.reason).toBe('budget exceeded');
    expect(deadLetter.endpointHash).toBe(TEST_ENDPOINT);
    expect(deadLetter.failedAt).toBeDefined();
    expect(deadLetter.envelope.id).toBe(envelope.id);
  });

  it('returns error when message does not exist in cur/', async () => {
    const result = await store.fail(TEST_ENDPOINT, 'nonexistent', 'reason');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('fail operation failed');
  });
});

// ---------------------------------------------------------------------------
// failDirect
// ---------------------------------------------------------------------------

describe('failDirect', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('writes envelope directly to failed/ without going through cur/', async () => {
    const envelope = makeEnvelope({ id: 'DIRECT-FAIL-01' });
    const result = await store.failDirect(TEST_ENDPOINT, envelope, 'access denied');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toContain('/failed/');
  });

  it('writes a .reason.json sidecar', async () => {
    const envelope = makeEnvelope({ id: 'DIRECT-FAIL-02' });
    await store.failDirect(TEST_ENDPOINT, envelope, 'budget exceeded');

    const reasonPath = path.join(tmpRoot, TEST_ENDPOINT, 'failed', 'DIRECT-FAIL-02.reason.json');
    const data = await fs.readFile(reasonPath, 'utf-8');
    const deadLetter: DeadLetter = JSON.parse(data);

    expect(deadLetter.reason).toBe('budget exceeded');
    expect(deadLetter.endpointHash).toBe(TEST_ENDPOINT);
    expect(deadLetter.envelope.id).toBe('DIRECT-FAIL-02');
  });

  it('preserves full envelope content in the failed file', async () => {
    const envelope = makeEnvelope({
      id: 'DIRECT-FAIL-03',
      payload: { important: 'data' },
    });
    await store.failDirect(TEST_ENDPOINT, envelope, 'rejected');

    const filePath = path.join(tmpRoot, TEST_ENDPOINT, 'failed', 'DIRECT-FAIL-03.json');
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    expect(parsed.payload).toEqual({ important: 'data' });
    expect(parsed.subject).toBe('relay.test.subject');
  });
});

// ---------------------------------------------------------------------------
// listNew / listCurrent / listFailed
// ---------------------------------------------------------------------------

describe('listNew', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('returns empty array when no messages exist', async () => {
    const list = await store.listNew(TEST_ENDPOINT);
    expect(list).toEqual([]);
  });

  it('returns message IDs without file extension', async () => {
    const r1 = await store.deliver(TEST_ENDPOINT, makeEnvelope());
    if (!r1.ok) throw new Error('deliver failed');

    const list = await store.listNew(TEST_ENDPOINT);

    expect(list).toHaveLength(1);
    expect(list[0]).toBe(r1.messageId);
    expect(list[0]).not.toContain('.json');
  });

  it('returns messages in FIFO order (sorted by ULID)', async () => {
    const r1 = await store.deliver(TEST_ENDPOINT, makeEnvelope());
    const r2 = await store.deliver(TEST_ENDPOINT, makeEnvelope());
    const r3 = await store.deliver(TEST_ENDPOINT, makeEnvelope());

    if (!r1.ok || !r2.ok || !r3.ok) throw new Error('deliver failed');

    const list = await store.listNew(TEST_ENDPOINT);

    expect(list).toEqual([r1.messageId, r2.messageId, r3.messageId]);
  });

  it('returns empty array for nonexistent endpoint', async () => {
    const list = await store.listNew('nonexistent');
    expect(list).toEqual([]);
  });
});

describe('listCurrent', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('returns messages that have been claimed', async () => {
    const r1 = await store.deliver(TEST_ENDPOINT, makeEnvelope());
    if (!r1.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, r1.messageId);

    const list = await store.listCurrent(TEST_ENDPOINT);
    expect(list).toEqual([r1.messageId]);
  });
});

describe('listFailed', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('returns failed messages without .reason.json sidecars', async () => {
    const envelope = makeEnvelope({ id: 'FAIL-LIST-01' });
    await store.failDirect(TEST_ENDPOINT, envelope, 'rejected');

    const list = await store.listFailed(TEST_ENDPOINT);

    expect(list).toEqual(['FAIL-LIST-01']);
    // Should NOT include the .reason.json sidecar
    expect(list).not.toContain('FAIL-LIST-01.reason');
  });
});

// ---------------------------------------------------------------------------
// readEnvelope / readDeadLetter
// ---------------------------------------------------------------------------

describe('readEnvelope', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('reads an envelope from new/', async () => {
    const envelope = makeEnvelope({ payload: { read: 'test' } });
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    const read = await store.readEnvelope(TEST_ENDPOINT, 'new', deliverResult.messageId);

    expect(read).not.toBeNull();
    expect(read?.payload).toEqual({ read: 'test' });
  });

  it('reads an envelope from cur/ after claim', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, deliverResult.messageId);

    const read = await store.readEnvelope(TEST_ENDPOINT, 'cur', deliverResult.messageId);
    expect(read).not.toBeNull();
    expect(read?.id).toBe(envelope.id);
  });

  it('returns null for nonexistent message', async () => {
    const read = await store.readEnvelope(TEST_ENDPOINT, 'new', 'nonexistent');
    expect(read).toBeNull();
  });
});

describe('readDeadLetter', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('reads dead letter metadata from .reason.json', async () => {
    const envelope = makeEnvelope({ id: 'DL-READ-01' });
    await store.failDirect(TEST_ENDPOINT, envelope, 'budget exhausted');

    const dl = await store.readDeadLetter(TEST_ENDPOINT, 'DL-READ-01');

    expect(dl).not.toBeNull();
    expect(dl?.reason).toBe('budget exhausted');
    expect(dl?.endpointHash).toBe(TEST_ENDPOINT);
    expect(dl?.envelope.id).toBe('DL-READ-01');
  });

  it('returns null for nonexistent dead letter', async () => {
    const dl = await store.readDeadLetter(TEST_ENDPOINT, 'nonexistent');
    expect(dl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full lifecycle (deliver -> claim -> complete)
// ---------------------------------------------------------------------------

describe('full lifecycle', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('deliver -> claim -> complete removes all files', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    const claimResult = await store.claim(TEST_ENDPOINT, deliverResult.messageId);
    if (!claimResult.ok) throw new Error('claim failed');

    await store.complete(TEST_ENDPOINT, deliverResult.messageId);

    // No files in any directory
    expect(await store.listNew(TEST_ENDPOINT)).toHaveLength(0);
    expect(await store.listCurrent(TEST_ENDPOINT)).toHaveLength(0);
    expect(await store.listFailed(TEST_ENDPOINT)).toHaveLength(0);
  });

  it('deliver -> claim -> fail moves to dead letter queue', async () => {
    const envelope = makeEnvelope();
    const deliverResult = await store.deliver(TEST_ENDPOINT, envelope);
    if (!deliverResult.ok) throw new Error('deliver failed');

    await store.claim(TEST_ENDPOINT, deliverResult.messageId);
    const failResult = await store.fail(TEST_ENDPOINT, deliverResult.messageId, 'processing error');
    if (!failResult.ok) throw new Error('fail failed');

    expect(await store.listNew(TEST_ENDPOINT)).toHaveLength(0);
    expect(await store.listCurrent(TEST_ENDPOINT)).toHaveLength(0);
    expect(await store.listFailed(TEST_ENDPOINT)).toHaveLength(1);

    const dl = await store.readDeadLetter(TEST_ENDPOINT, deliverResult.messageId);
    expect(dl?.reason).toBe('processing error');
  });

  it('handles multiple messages in parallel', async () => {
    const envelopes = Array.from({ length: 5 }, (_, i) => makeEnvelope({ id: `PARALLEL-${i}` }));

    const results = await Promise.all(envelopes.map((env) => store.deliver(TEST_ENDPOINT, env)));

    const successes = results.filter((r) => r.ok);
    expect(successes).toHaveLength(5);

    const list = await store.listNew(TEST_ENDPOINT);
    expect(list).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Concurrent safety
// ---------------------------------------------------------------------------

describe('concurrent safety', () => {
  beforeEach(async () => {
    await store.ensureMaildir(TEST_ENDPOINT);
  });

  it('concurrent delivers all succeed with unique IDs', async () => {
    const envelope = makeEnvelope();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.deliver(TEST_ENDPOINT, envelope))
    );

    const successes = results.filter((r) => r.ok);
    expect(successes).toHaveLength(10);

    // All message IDs should be unique
    const ids = successes.map((r) => (r as { ok: true; messageId: string }).messageId);
    expect(new Set(ids).size).toBe(10);
  });

  it('concurrent claims on the same message: exactly one succeeds', async () => {
    const deliverResult = await store.deliver(TEST_ENDPOINT, makeEnvelope());
    if (!deliverResult.ok) throw new Error('deliver failed');

    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claim(TEST_ENDPOINT, deliverResult.messageId))
    );

    const successes = claims.filter((r) => r.ok);
    expect(successes).toHaveLength(1);
  });
});

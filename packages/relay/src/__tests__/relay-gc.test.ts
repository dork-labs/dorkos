/**
 * Integration tests for the Relay storage GC sweep (H4, M1, M3, L3).
 *
 * Drives a real RelayCore against a temp data directory and calls
 * `runGcSweep()` deterministically (the periodic timer interval is set very
 * high so it never fires mid-test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { RelayCore } from '../relay-core.js';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A sweep interval large enough never to fire during a test. */
const NEVER_MS = 60 * 60 * 1000;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-gc-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mailboxDir(subject: string): string {
  return path.join(tmpDir, 'mailboxes', subject);
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function makeEnvelope(overrides: Partial<RelayEnvelope> = {}): RelayEnvelope {
  return {
    id: '01JGCENVELOPE',
    subject: 'relay.inbox.recover.x',
    from: 'relay.agent.sender',
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

// ---------------------------------------------------------------------------
// Expiry + rebuild-no-resurrect (H4)
// ---------------------------------------------------------------------------

describe('GC expiry sweep', () => {
  it('removes expired index rows AND their Maildir files in lockstep, and rebuild does not resurrect them', async () => {
    const relay = new RelayCore({
      dataDir: tmpDir,
      defaultTtlMs: 100,
      gcIntervalMs: NEVER_MS,
    });
    const subject = 'relay.inbox.persist.x';
    await relay.registerEndpoint(subject);

    // No subscriber: the message lands in new/ as pending and stays there.
    await relay.publish(subject, { n: 1 }, { from: 'relay.agent.sender' });

    const before = await relay.readInbox(subject, { status: 'unread' });
    expect(before.messages).toHaveLength(1);
    expect(await listDir(path.join(mailboxDir(subject), 'new'))).toHaveLength(1);

    // Let the TTL pass, then sweep.
    await new Promise((r) => setTimeout(r, 160));
    const result = await relay.runGcSweep();
    expect(result?.expiredRemoved).toBeGreaterThanOrEqual(1);

    // Row and file are both gone.
    const after = await relay.readInbox(subject, { status: 'unread' });
    expect(after.messages).toHaveLength(0);
    expect(await listDir(path.join(mailboxDir(subject), 'new'))).toHaveLength(0);

    // Rebuild scans the (now-empty) maildir — nothing resurrects.
    await relay.rebuildIndex();
    const afterRebuild = await relay.readInbox(subject, { status: 'unread' });
    expect(afterRebuild.messages).toHaveLength(0);

    await relay.close();
  });
});

// ---------------------------------------------------------------------------
// Backpressure recovery after GC (H4)
// ---------------------------------------------------------------------------

describe('GC backpressure recovery', () => {
  it('a mailbox bricked at maxMailboxSize accepts deliveries again after GC', async () => {
    const relay = new RelayCore({
      dataDir: tmpDir,
      defaultTtlMs: 200,
      gcIntervalMs: NEVER_MS,
      reliability: { backpressure: { maxMailboxSize: 3, pressureWarningAt: 0.8 } },
    });
    const subject = 'relay.inbox.brick.x';
    await relay.registerEndpoint(subject);

    // Fill the mailbox to its cap (no subscriber → all stay pending).
    for (let i = 0; i < 3; i++) {
      await relay.publish(subject, { i }, { from: 'relay.agent.sender' });
    }

    // The next delivery is rejected: the inbox is bricked.
    const bricked = await relay.publish(subject, { i: 3 }, { from: 'relay.agent.sender' });
    expect(bricked.deliveredTo).toBe(0);
    expect(bricked.rejected?.[0]?.reason).toBe('backpressure');

    // Let the pending backlog expire, then GC it.
    await new Promise((r) => setTimeout(r, 260));
    await relay.runGcSweep();

    // The inbox accepts deliveries again.
    const recovered = await relay.publish(subject, { i: 4 }, { from: 'relay.agent.sender' });
    expect(recovered.deliveredTo).toBeGreaterThanOrEqual(1);

    await relay.close();
  });
});

// ---------------------------------------------------------------------------
// Crash recovery: re-drive stranded cur/ messages (M1)
// ---------------------------------------------------------------------------

describe('GC crash recovery', () => {
  it('re-drives messages stranded in cur/ back to new/ and redelivers them', async () => {
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      inFlightRecoveryMs: 10,
    });
    const subject = 'relay.inbox.recover.x';
    await relay.registerEndpoint(subject);

    const received: unknown[] = [];
    relay.subscribe(subject, (envelope) => {
      received.push(envelope.payload);
    });

    // Simulate a crash between claim and complete: an old envelope stranded in cur/.
    const stranded = makeEnvelope({
      id: '01JSTRANDED',
      subject,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { stranded: true },
    });
    const curPath = path.join(mailboxDir(subject), 'cur', `${stranded.id}.json`);
    await fs.writeFile(curPath, JSON.stringify(stranded), 'utf-8');

    await relay.runGcSweep();

    await vi.waitFor(() => {
      expect(received).toContainEqual({ stranded: true });
    });
    // cur/ and new/ are both drained (redelivered + completed).
    expect(await listDir(path.join(mailboxDir(subject), 'cur'))).toHaveLength(0);
    expect(await listDir(path.join(mailboxDir(subject), 'new'))).toHaveLength(0);

    await relay.close();
  });

  it('leaves a freshly-claimed cur/ message untouched (age threshold)', async () => {
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      inFlightRecoveryMs: 60_000,
    });
    const subject = 'relay.inbox.recover.fresh';
    await relay.registerEndpoint(subject);

    const fresh = makeEnvelope({ id: '01JFRESH', subject, createdAt: new Date().toISOString() });
    const curPath = path.join(mailboxDir(subject), 'cur', `${fresh.id}.json`);
    await fs.writeFile(curPath, JSON.stringify(fresh), 'utf-8');

    const result = await relay.runGcSweep();
    expect(result?.inFlightRecovered).toBe(0);
    expect(await listDir(path.join(mailboxDir(subject), 'cur'))).toHaveLength(1);

    await relay.close();
  });
});

// ---------------------------------------------------------------------------
// Dead-letter retention (L3 / H4)
// ---------------------------------------------------------------------------

describe('GC dead-letter retention', () => {
  it('purges dead letters older than the retention window', async () => {
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      deadLetterRetentionMs: 60_000,
    });

    // Publish to an unmatched subject (no endpoint/subscriber/adapter) → dead-letter.
    const orphanSubject = 'relay.orphan.deadletter';
    const published = await relay.publish(orphanSubject, { x: 1 }, { from: 'relay.agent.sender' });
    expect(published.deliveredTo).toBe(0);

    let deadLetters = await relay.getDeadLetters();
    expect(deadLetters).toHaveLength(1);

    // Backdate the sidecar so it falls outside the retention window.
    const reasonPath = path.join(
      mailboxDir(orphanSubject),
      'failed',
      `${published.messageId}.reason.json`
    );
    const sidecar = JSON.parse(await fs.readFile(reasonPath, 'utf-8'));
    sidecar.failedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    await fs.writeFile(reasonPath, JSON.stringify(sidecar), 'utf-8');

    await relay.runGcSweep();

    deadLetters = await relay.getDeadLetters();
    expect(deadLetters).toHaveLength(0);
    expect(relay.getMessage(published.messageId)).toBeNull();

    await relay.close();
  });
});

// ---------------------------------------------------------------------------
// Orphan maildir reaping (H4 / M3)
// ---------------------------------------------------------------------------

describe('GC orphan maildir reaping', () => {
  it('reaps unowned, stale mailbox directories but keeps registered and fresh ones', async () => {
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      orphanMaildirRetentionMs: 60 * 60 * 1000,
    });

    // A registered endpoint — must never be reaped.
    const keepSubject = 'relay.inbox.keep.x';
    await relay.registerEndpoint(keepSubject);

    // A stale orphan (historical relay.agent.{basename}.{id} shape), backdated.
    const staleOrphan = 'relay.agent.myproj.01998e00-1111-7000-8000-000000000000';
    for (const sub of ['tmp', 'new', 'cur', 'failed']) {
      await fs.mkdir(path.join(mailboxDir(staleOrphan), sub), { recursive: true });
    }
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(mailboxDir(staleOrphan), twoHoursAgo, twoHoursAgo);

    // A fresh orphan (recent activity) — within the safety margin, must survive.
    const freshOrphan = 'relay.agent.myproj.fresh';
    await fs.mkdir(path.join(mailboxDir(freshOrphan), 'new'), { recursive: true });

    const result = await relay.runGcSweep();
    expect(result?.orphansReaped).toBe(1);

    await expect(fs.stat(mailboxDir(staleOrphan))).rejects.toThrow();
    await expect(fs.stat(mailboxDir(keepSubject))).resolves.toBeDefined();
    await expect(fs.stat(mailboxDir(freshOrphan))).resolves.toBeDefined();

    await relay.close();
  });
});

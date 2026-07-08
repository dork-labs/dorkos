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

    // Simulate a crash between claim and complete: an envelope stranded in cur/.
    const stranded = makeEnvelope({
      id: '01JSTRANDED',
      subject,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      payload: { stranded: true },
    });
    const curPath = path.join(mailboxDir(subject), 'cur', `${stranded.id}.json`);
    await fs.writeFile(curPath, JSON.stringify(stranded), 'utf-8');

    // Recovery gates on the cur/ file's ctime (claim time) — let it age past
    // the 10ms window before sweeping.
    await new Promise((r) => setTimeout(r, 30));
    await relay.runGcSweep();

    await vi.waitFor(() => {
      expect(received).toContainEqual({ stranded: true });
    });
    // cur/ and new/ are both drained (redelivered + completed).
    expect(await listDir(path.join(mailboxDir(subject), 'cur'))).toHaveLength(0);
    expect(await listDir(path.join(mailboxDir(subject), 'new'))).toHaveLength(0);

    await relay.close();
  });

  it('does NOT re-drive a recently-claimed message even when its createdAt is old (in-flight guard)', async () => {
    // The gate is time-since-CLAIM (cur/ file ctime), never envelope.createdAt:
    // createdAt includes queue time, so a slow handler that just claimed an old
    // message must not have it re-driven into a second delivery mid-turn.
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      inFlightRecoveryMs: 60_000,
    });
    const subject = 'relay.inbox.recover.fresh';
    await relay.registerEndpoint(subject);

    const inFlight = makeEnvelope({
      id: '01JINFLIGHT',
      subject,
      // createdAt hours in the past — an old message freshly claimed.
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    const curPath = path.join(mailboxDir(subject), 'cur', `${inFlight.id}.json`);
    await fs.writeFile(curPath, JSON.stringify(inFlight), 'utf-8');

    const result = await relay.runGcSweep();
    expect(result?.inFlightRecovered).toBe(0);
    expect(await listDir(path.join(mailboxDir(subject), 'cur'))).toHaveLength(1);

    await relay.close();
  });

  it('a re-drive racing a slow in-flight handler never flips a delivered message to failed', async () => {
    // The full double-claim trace: handler in flight -> sweep re-drives
    // cur/ -> new/ (window 0 forces it) -> second claim runs the handler AGAIN
    // -> first invocation's complete() unlinks cur/{id} -> second invocation's
    // complete() hits ENOENT. That second complete must be a silent no-op —
    // previously it threw, and the catch path flipped a message that succeeded
    // TWICE to 'failed' and dinged the circuit breaker.
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      inFlightRecoveryMs: 0,
    });
    const subject = 'relay.inbox.recover.race';
    await relay.registerEndpoint(subject);

    let invocations = 0;
    relay.subscribe(subject, async () => {
      invocations++;
      await new Promise((r) => setTimeout(r, 120));
    });

    // Don't await — the handler holds the dispatch (and thus publish) open.
    const publishPromise = relay.publish(subject, { race: true }, { from: 'relay.agent.sender' });

    // Let the claim land (file in cur/, handler running), then sweep: the
    // zero window treats the in-flight message as stranded and re-drives it.
    await vi.waitFor(async () => {
      expect(await listDir(path.join(mailboxDir(subject), 'cur'))).toHaveLength(1);
    });
    await relay.runGcSweep();
    await publishPromise;

    // Both invocations settle; the double complete() must leave the message
    // 'delivered' — never 'failed'.
    await vi.waitFor(async () => {
      const { messages } = await relay.listMessages({ subject });
      expect(messages.length).toBeGreaterThanOrEqual(1);
      expect(messages.every((m) => m.status === 'delivered')).toBe(true);
    });
    expect(invocations).toBeGreaterThanOrEqual(2);
    expect(await listDir(path.join(mailboxDir(subject), 'failed'))).toHaveLength(0);

    await relay.close();
  });
});

// ---------------------------------------------------------------------------
// Expiry of claimed-pending messages (file in cur/, row pending)
// ---------------------------------------------------------------------------

describe('GC expiry of claimed-pending messages', () => {
  it('removes the cur/ file when an expired pending row was claimed but never completed', async () => {
    // A pending row's file lives in cur/ (not new/) while a claim is in
    // flight. Expiry must check both subdirs — deleting only new/ would leave
    // an orphan cur/ file with no index row.
    const relay = new RelayCore({
      dataDir: tmpDir,
      defaultTtlMs: 100,
      gcIntervalMs: NEVER_MS,
      // Keep crash recovery out of this test's way.
      inFlightRecoveryMs: NEVER_MS,
    });
    const subject = 'relay.inbox.persist.claimed';
    await relay.registerEndpoint(subject);

    await relay.publish(subject, { n: 1 }, { from: 'relay.agent.sender' });
    const newDir = path.join(mailboxDir(subject), 'new');
    const [filename] = await listDir(newDir);
    expect(filename).toBeDefined();

    // Simulate a claim that never completed: move the file new/ -> cur/ by
    // hand (the index row stays 'pending').
    await fs.rename(path.join(newDir, filename), path.join(mailboxDir(subject), 'cur', filename));

    await new Promise((r) => setTimeout(r, 160));
    const result = await relay.runGcSweep();
    expect(result?.expiredRemoved).toBeGreaterThanOrEqual(1);

    // Row gone AND the cur/ file gone — no orphan file left behind.
    expect(await listDir(path.join(mailboxDir(subject), 'cur'))).toHaveLength(0);
    const inbox = await relay.readInbox(subject, { status: 'unread' });
    expect(inbox.messages).toHaveLength(0);

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

  it('a persistent inbox with unread messages survives a restart + immediate sweep with an empty registry', async () => {
    // Endpoint registration is in-memory: after a restart every maildir looks
    // unowned until its owner re-registers. A durable relay.inbox.* persistent
    // inbox holding unread no-TTL mail must NEVER be reaped in that window —
    // rm -rf here is permanent data loss.
    const subject = 'relay.inbox.persist.survivor';

    const relay1 = new RelayCore({ dataDir: tmpDir, gcIntervalMs: NEVER_MS });
    await relay1.registerEndpoint(subject);
    await relay1.publish(subject, { keep: 'me' }, { from: 'relay.agent.sender' });
    expect(await listDir(path.join(mailboxDir(subject), 'new'))).toHaveLength(1);
    await relay1.close();

    // Backdate the whole maildir so even the age safety-margin would allow
    // reaping — only the persistent-type exemption protects it.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const sub of ['', 'tmp', 'new', 'cur', 'failed']) {
      await fs.utimes(path.join(mailboxDir(subject), sub), twoDaysAgo, twoDaysAgo);
    }

    // Restart: empty in-memory registry, construction sweep fires immediately
    // (it skips reaping), then an explicit full sweep with reaping active.
    const relay2 = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      orphanMaildirRetentionMs: 0,
    });
    const result = await relay2.runGcSweep();
    expect(result?.orphansReaped).toBe(0);

    // The unread message is still on disk and readable after re-registration.
    expect(await listDir(path.join(mailboxDir(subject), 'new'))).toHaveLength(1);
    await relay2.registerEndpoint(subject);
    const inbox = await relay2.readInbox(subject, { status: 'unread' });
    expect(inbox.messages).toHaveLength(1);
    expect(inbox.messages[0].payload).toEqual({ keep: 'me' });

    await relay2.close();
  });

  it('the construction-time sweep defers orphan reaping (empty-registry grace)', async () => {
    // Ephemeral (non-persistent) maildirs must also survive the construction
    // sweep — the registry has not repopulated yet. They are only reaped by a
    // later interval sweep.
    const orphan = 'relay.agent.myproj.ephemeral-restart';
    for (const sub of ['tmp', 'new', 'cur', 'failed']) {
      await fs.mkdir(path.join(mailboxDir(orphan), sub), { recursive: true });
    }
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(mailboxDir(orphan), twoDaysAgo, twoDaysAgo);
    for (const sub of ['tmp', 'new', 'cur', 'failed']) {
      await fs.utimes(path.join(mailboxDir(orphan), sub), twoDaysAgo, twoDaysAgo);
    }

    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      orphanMaildirRetentionMs: 0,
    });
    // Give the (void) construction sweep a beat to run.
    await new Promise((r) => setTimeout(r, 50));
    await expect(fs.stat(mailboxDir(orphan))).resolves.toBeDefined();

    // The next full sweep (reaping active) removes it.
    const result = await relay.runGcSweep();
    expect(result?.orphansReaped).toBe(1);
    await expect(fs.stat(mailboxDir(orphan))).rejects.toThrow();

    await relay.close();
  });
});

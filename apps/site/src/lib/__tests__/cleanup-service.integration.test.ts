/**
 * @vitest-environment node
 */
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mailer seam mocked so constructing the auth instance performs no email/network
// I/O (the reset/verification senders are referenced at build time).
vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
  sendDeleteAccountVerification: vi.fn().mockResolvedValue(undefined),
}));

import { listAudit } from '../audit-service';
import { type Auth, createAuth } from '../auth';
import { STALE_INSTANCE_TTL_MS, UNVERIFIED_USER_TTL_MS, runCleanup } from '../cleanup-service';

/** A row shape loose enough for the in-memory Better Auth store. */
type MemoryRow = Record<string, unknown>;

/** A fresh, fully-provisioned in-memory store for every test. */
function freshMemory(): Record<string, MemoryRow[]> {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    apikey: [],
    deviceCode: [],
    instance: [],
    auditLog: [],
  };
}

/** A fixed reference clock so TTL boundaries are deterministic. */
const NOW = new Date('2026-07-06T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** `NOW` shifted back by `ms`. */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret-123';
});
afterAll(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

/** The Better Auth database adapter type, as resolved from a built instance. */
type Adapter = Awaited<Auth['$context']>['adapter'];

describe('cleanup-service — runCleanup', () => {
  let memory: Record<string, MemoryRow[]>;
  let auth: Auth;
  let adapter: Adapter;

  /** Seed a `user` row and return its generated id. */
  async function seedUser(args: {
    email: string;
    emailVerified: boolean;
    createdAt: Date;
  }): Promise<string> {
    const row = (await adapter.create({
      model: 'user',
      data: {
        name: args.email,
        email: args.email,
        emailVerified: args.emailVerified,
        role: 'user',
        createdAt: args.createdAt,
        updatedAt: args.createdAt,
      },
    })) as { id: string };
    return row.id;
  }

  /** Seed an `instance` row and return its generated id. */
  async function seedInstance(args: {
    userId: string;
    lastSeenAt: Date;
    revokedAt?: Date | null;
  }): Promise<string> {
    const row = (await adapter.create({
      model: 'instance',
      data: {
        userId: args.userId,
        name: 'Kai laptop',
        platform: 'darwin',
        dorkosVersion: '0.4.2',
        createdAt: ago(60 * DAY_MS),
        lastSeenAt: args.lastSeenAt,
        revokedAt: args.revokedAt ?? null,
      },
    })) as { id: string };
    return row.id;
  }

  beforeEach(async () => {
    memory = freshMemory();
    auth = createAuth(memoryAdapter(memory));
    adapter = (await auth.$context).adapter;
  });

  it('purges only never-verified accounts older than the TTL', async () => {
    const staleUnverified = await seedUser({
      email: 'ghost@dork.test',
      emailVerified: false,
      createdAt: ago(UNVERIFIED_USER_TTL_MS + DAY_MS), // 8 days old
    });
    const freshUnverified = await seedUser({
      email: 'newcomer@dork.test',
      emailVerified: false,
      createdAt: ago(DAY_MS), // 1 day old — inside the grace window
    });
    const oldVerified = await seedUser({
      email: 'member@dork.test',
      emailVerified: true,
      createdAt: ago(30 * DAY_MS), // old but verified — a real account
    });

    const counts = await runCleanup(auth, { now: NOW });

    expect(counts.unverifiedUsers).toBe(1);
    expect(memory.user.map((u) => u.id)).toEqual(
      expect.arrayContaining([freshUnverified, oldVerified])
    );
    expect(memory.user.find((u) => u.id === staleUnverified)).toBeUndefined();
    // The fresh unverified account and the real verified account are never touched.
    expect(memory.user.find((u) => u.id === freshUnverified)).toBeTruthy();
    expect(memory.user.find((u) => u.id === oldVerified)).toBeTruthy();
  });

  it('deletes expired verification tokens but keeps live ones', async () => {
    await adapter.create({
      model: 'verification',
      data: {
        identifier: 'reset-password:expired-token',
        value: 'x',
        expiresAt: ago(60 * 60 * 1000), // 1h ago
        createdAt: ago(2 * 60 * 60 * 1000),
        updatedAt: ago(2 * 60 * 60 * 1000),
      },
    });
    await adapter.create({
      model: 'verification',
      data: {
        identifier: 'reset-password:live-token',
        value: 'y',
        expiresAt: new Date(NOW.getTime() + 30 * 60 * 1000), // 30m in the future
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    await runCleanup(auth, { now: NOW });

    const identifiers = memory.verification.map((v) => v.identifier);
    expect(identifiers).toEqual(['reset-password:live-token']);
  });

  it('deletes only expired device codes', async () => {
    await adapter.create({
      model: 'deviceCode',
      data: {
        deviceCode: 'dc-expired',
        userCode: 'AAAA1111',
        status: 'pending',
        expiresAt: ago(60 * 1000), // expired
        createdAt: ago(31 * 60 * 1000),
        updatedAt: ago(31 * 60 * 1000),
      },
    });
    await adapter.create({
      model: 'deviceCode',
      data: {
        deviceCode: 'dc-live',
        userCode: 'BBBB2222',
        status: 'pending',
        expiresAt: new Date(NOW.getTime() + 20 * 60 * 1000), // still valid
        createdAt: NOW,
        updatedAt: NOW,
      },
    });

    const counts = await runCleanup(auth, { now: NOW });

    expect(counts.expiredDeviceCodes).toBe(1);
    expect(memory.deviceCode.map((d) => d.deviceCode)).toEqual(['dc-live']);
  });

  it('auto-revokes stale instances (row kept, key killed) and never touches fresh ones', async () => {
    const staleOwner = 'owner-stale';
    const freshOwner = 'owner-fresh';

    const staleId = await seedInstance({
      userId: staleOwner,
      lastSeenAt: ago(STALE_INSTANCE_TTL_MS + DAY_MS), // 31 days silent
    });
    const freshId = await seedInstance({
      userId: freshOwner,
      lastSeenAt: ago(DAY_MS), // seen yesterday — live
    });
    // An already-revoked stale row must not be re-counted or re-touched.
    const alreadyRevokedId = await seedInstance({
      userId: 'owner-gone',
      lastSeenAt: ago(90 * DAY_MS),
      revokedAt: ago(10 * DAY_MS),
    });

    // The stale instance owns a scoped API key that revocation must delete.
    await adapter.create({
      model: 'apikey',
      data: {
        name: 'stale key',
        referenceId: staleOwner,
        key: 'stale-key-value',
        enabled: true,
        metadata: JSON.stringify({ instanceId: staleId }),
        createdAt: ago(40 * DAY_MS),
        updatedAt: ago(40 * DAY_MS),
      },
    });

    const counts = await runCleanup(auth, { now: NOW });

    expect(counts.staleInstances).toBe(1);

    // Stale instance: row survives, now stamped revoked; its key is deleted.
    const staleRow = memory.instance.find((i) => i.id === staleId);
    expect(staleRow).toBeTruthy();
    expect(staleRow?.revokedAt).toBeTruthy();
    expect(memory.apikey.filter((k) => k.referenceId === staleOwner)).toHaveLength(0);

    // Fresh instance: never revoked.
    const freshRow = memory.instance.find((i) => i.id === freshId);
    expect(freshRow?.revokedAt).toBeNull();

    // Already-revoked row: untouched (its revokedAt stamp is unchanged).
    const revokedRow = memory.instance.find((i) => i.id === alreadyRevokedId);
    expect(revokedRow?.revokedAt).toEqual(ago(10 * DAY_MS));
  });

  it('writes one system-actor audit row summarizing a run that removed rows', async () => {
    await seedUser({
      email: 'ghost@dork.test',
      emailVerified: false,
      createdAt: ago(UNVERIFIED_USER_TTL_MS + DAY_MS),
    });

    await runCleanup(auth, { now: NOW });

    const audit = await listAudit(auth);
    const row = audit.find((a) => a.action === 'system.cleanup');
    expect(row).toBeTruthy();
    expect(row?.actorUserId).toBe('system');
    expect(row?.targetUserId).toBeNull();
    expect(row?.metadata).toMatchObject({
      unverifiedUsers: 1,
      expiredDeviceCodes: 0,
      staleInstances: 0,
    });
  });

  it('writes no audit row when a run removes nothing', async () => {
    await seedUser({
      email: 'member@dork.test',
      emailVerified: true,
      createdAt: ago(30 * DAY_MS),
    });

    const counts = await runCleanup(auth, { now: NOW });

    expect(counts).toEqual({ unverifiedUsers: 0, expiredDeviceCodes: 0, staleInstances: 0 });
    const audit = await listAudit(auth);
    expect(audit).toHaveLength(0);
  });

  it('dryRun reports the same counts but mutates nothing', async () => {
    await seedUser({
      email: 'ghost@dork.test',
      emailVerified: false,
      createdAt: ago(UNVERIFIED_USER_TTL_MS + DAY_MS),
    });
    await adapter.create({
      model: 'deviceCode',
      data: {
        deviceCode: 'dc-expired',
        userCode: 'CCCC3333',
        status: 'pending',
        expiresAt: ago(60 * 1000),
        createdAt: ago(31 * 60 * 1000),
        updatedAt: ago(31 * 60 * 1000),
      },
    });
    const staleId = await seedInstance({
      userId: 'owner-stale',
      lastSeenAt: ago(STALE_INSTANCE_TTL_MS + DAY_MS),
    });

    const counts = await runCleanup(auth, { now: NOW, dryRun: true });

    expect(counts).toEqual({ unverifiedUsers: 1, expiredDeviceCodes: 1, staleInstances: 1 });
    // Nothing was actually removed or revoked.
    expect(memory.user).toHaveLength(1);
    expect(memory.deviceCode).toHaveLength(1);
    expect(memory.instance.find((i) => i.id === staleId)?.revokedAt).toBeNull();
    const audit = await listAudit(auth);
    expect(audit).toHaveLength(0);
  });
});

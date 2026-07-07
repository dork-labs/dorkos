/**
 * Scheduled cleanup for the **DorkOS account** cloud identity core (DOR-194).
 *
 * A single {@link runCleanup} pass purges the debris that open self-registration
 * and device-linking accumulate on Neon Postgres:
 *
 * 1. **Never-verified accounts** — `user` rows still `emailVerified = false` after
 *    {@link UNVERIFIED_USER_TTL_MS}. Deleting the `user` row cascades its
 *    sessions, OAuth links, API keys, and linked instances via the schema's
 *    `onDelete: cascade` foreign keys (see `db/auth-schema.ts` /
 *    `db/instance-schema.ts`). Alongside, expired one-time `verification` tokens
 *    are swept — dead `reset-password:*` rows Better Auth would otherwise only
 *    garbage-collect lazily.
 * 2. **Expired device codes** — RFC 8628 `deviceCode` rows past their `expiresAt`.
 * 3. **Stale instances** — device-linked `instance` rows silent for longer than
 *    {@link STALE_INSTANCE_TTL_MS}. These are **revoked, not deleted** (see below).
 *
 * Like {@link module:lib/instance-service} and {@link module:lib/audit-service},
 * every read and write goes through Better Auth's database adapter
 * (`auth.$context.adapter`), so the exact same code runs against production
 * Postgres and the in-memory adapter the tests drive. **Nothing here ever logs a
 * secret** (key, token, or password).
 *
 * ## Why stale instances are revoked, not deleted
 *
 * The `instance` row is the human-facing registry rendered at
 * `/account/instances`. Hard-deleting a long-silent instance would make it
 * silently vanish from the owner's view — the opposite of honest. Instead we run
 * the same {@link revokeInstance} a human triggers from that UI: the owning API
 * key is deleted (so the instance 401s and self-unlinks on its next heartbeat)
 * and `revokedAt` is stamped, while the visible row survives as "revoked"
 * history. That kills a long-idle credential (a security win) without erasing the
 * record the user relies on to understand what happened. Genuine row removal is
 * left to the account cascade (an unverified purge here, or a self-serve / admin
 * account delete).
 *
 * @module lib/cleanup-service
 */
import type { Where } from 'better-auth/types';

import type { Auth } from '@/lib/auth';
import { recordAudit } from '@/lib/audit-service';
import { INSTANCE_MODEL } from '@/lib/instance-registry-plugin';
import { revokeInstance } from '@/lib/instance-service';

/**
 * How long a never-verified account is kept before it is purged (7 days, in ms).
 * A cloud account must verify its email before it can sign in, so a `user` still
 * `emailVerified = false` this long after `createdAt` is abandoned debris.
 */
export const UNVERIFIED_USER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an instance may go without a heartbeat before it is auto-revoked
 * (30 days, in ms). A linked instance heartbeats every ~15 minutes, so a
 * `lastSeenAt` this old means the instance is gone; its credential should not
 * stay live.
 */
export const STALE_INSTANCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Actor id recorded on a cleanup run's audit row. Not a `user.id` (the audit log
 * has no FK to `user`), just the marker that an automated job — not a human —
 * performed the deletions.
 */
const SYSTEM_ACTOR = 'system';

/** Page size for streaming stale-instance candidates through the adapter. */
const INSTANCE_PAGE_SIZE = 500;

/**
 * Per-category counts of rows a cleanup run removed — or, in a dry run, would
 * remove. Expired `verification` tokens are swept as hygiene but not counted
 * here: they are dead one-time tokens, not accounts.
 */
export interface CleanupCounts {
  /** Never-verified accounts purged (sessions/keys/instances cascade via FK). */
  unverifiedUsers: number;
  /** Expired device-authorization codes deleted. */
  expiredDeviceCodes: number;
  /** Silent instances auto-revoked (row kept, credential killed). */
  staleInstances: number;
}

/** Options for {@link runCleanup}. */
export interface RunCleanupOptions {
  /** The reference "now" (injectable for deterministic tests); defaults to the wall clock. */
  now?: Date;
  /** When true, count what would be removed without mutating anything. */
  dryRun?: boolean;
}

/** The subset of an `instance` row this service reads. */
interface StaleInstanceRow {
  id: string;
  userId: string;
  revokedAt: Date | string | null;
}

/** Resolve the Better Auth database adapter for the given instance. */
async function getAdapter(auth: Auth) {
  return (await auth.$context).adapter;
}

/**
 * Collect every still-live `instance` whose `lastSeenAt` predates `cutoff`.
 *
 * `revokedAt == null` is filtered in JS rather than in the where clause on
 * purpose: SQL `revoked_at = NULL` is never true in Postgres, and the memory
 * adapter's eq-null match is brittle for an unset column. Paginates by offset
 * over the stable `lastSeenAt < cutoff` set (collection happens before any
 * revocation mutates a row, so the set does not shift underfoot).
 */
async function collectStaleInstances(auth: Auth, cutoff: Date): Promise<StaleInstanceRow[]> {
  const adapter = await getAdapter(auth);
  const where: Where[] = [{ field: 'lastSeenAt', operator: 'lt', value: cutoff }];
  const live: StaleInstanceRow[] = [];
  for (let offset = 0; ; offset += INSTANCE_PAGE_SIZE) {
    const page = (await adapter.findMany({
      model: INSTANCE_MODEL,
      where,
      limit: INSTANCE_PAGE_SIZE,
      offset,
    })) as StaleInstanceRow[];
    for (const row of page) {
      if (!row.revokedAt) live.push(row);
    }
    if (page.length < INSTANCE_PAGE_SIZE) break;
  }
  return live;
}

/**
 * Run one cleanup pass over the DorkOS-account tables and return the per-category
 * counts of what was removed (or, with `dryRun`, would be removed).
 *
 * Idempotent and safe to run on a schedule: it only ever removes rows already
 * past a TTL or expiry. A non-dry run with any removals writes one best-effort
 * `system.cleanup` audit row (counts only — never a secret); a failed audit write
 * never fails the run.
 *
 * @param auth - The Better Auth instance (production singleton, or a memory-backed
 *   instance in tests).
 * @param options - Injectable `now` and `dryRun` toggle.
 */
export async function runCleanup(
  auth: Auth,
  options: RunCleanupOptions = {}
): Promise<CleanupCounts> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun ?? false;
  const adapter = await getAdapter(auth);

  const unverifiedCutoff = new Date(now.getTime() - UNVERIFIED_USER_TTL_MS);
  const staleCutoff = new Date(now.getTime() - STALE_INSTANCE_TTL_MS);

  // 1. Never-verified accounts older than the TTL. The `user` delete cascades
  //    sessions/accounts/apikeys/instances via the schema's onDelete: cascade FKs.
  const unverifiedWhere: Where[] = [
    { field: 'emailVerified', value: false },
    { field: 'createdAt', operator: 'lt', value: unverifiedCutoff },
  ];
  const unverifiedUsers = await adapter.count({ model: 'user', where: unverifiedWhere });
  if (!dryRun && unverifiedUsers > 0) {
    await adapter.deleteMany({ model: 'user', where: unverifiedWhere });
  }
  if (!dryRun) {
    // Sweep expired one-time verification tokens. They are keyed by `identifier`
    // (`reset-password:<token>`, or a stateless JWT flow that stores no row),
    // never by `userId`, so they cannot be correlated to a specific account —
    // deleting the expired ones is the honest, robust interpretation of "purge a
    // dead account's verification rows", and mirrors Better Auth's own lazy
    // cleanup. Not counted: these are dead tokens, not accounts.
    await adapter.deleteMany({
      model: 'verification',
      where: [{ field: 'expiresAt', operator: 'lt', value: now }],
    });
  }

  // 2. Expired device-authorization codes (RFC 8628).
  const deviceWhere: Where[] = [{ field: 'expiresAt', operator: 'lt', value: now }];
  const expiredDeviceCodes = await adapter.count({ model: 'deviceCode', where: deviceWhere });
  if (!dryRun && expiredDeviceCodes > 0) {
    await adapter.deleteMany({ model: 'deviceCode', where: deviceWhere });
  }

  // 3. Stale instances — auto-revoke (never delete; see module doc).
  const staleCandidates = await collectStaleInstances(auth, staleCutoff);
  let staleInstances = 0;
  for (const row of staleCandidates) {
    if (dryRun) {
      staleInstances++;
      continue;
    }
    const result = await revokeInstance(auth, { userId: row.userId, instanceId: row.id });
    if (result.ok) staleInstances++;
  }

  const counts: CleanupCounts = { unverifiedUsers, expiredDeviceCodes, staleInstances };

  const total = counts.unverifiedUsers + counts.expiredDeviceCodes + counts.staleInstances;
  if (!dryRun && total > 0) {
    try {
      await recordAudit(auth, {
        actorUserId: SYSTEM_ACTOR,
        action: 'system.cleanup',
        metadata: { ...counts },
      });
    } catch {
      /* audit is best-effort — never fail a cleanup run on a logging hiccup */
    }
  }

  return counts;
}

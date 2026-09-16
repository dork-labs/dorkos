/**
 * Transactional local receipt ledger for outbound community agent output.
 *
 * @module services/communities/remote/community-outbox-store
 */
import {
  and,
  communityEntryOrigins,
  communityOutbox,
  eq,
  inArray,
  lte,
  lt,
  or,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { CommunityRef } from '@dorkos/shared/community-adapter';

/** A pending, confirmed, failed, or stopped local delivery. */
export type CommunityOutboxState = 'pending' | 'confirmed' | 'failed' | 'stopped';

/** The non-secret data needed to deliver one already committed local entry. */
export interface CommunityOutboxItem {
  id: string;
  communityRef: CommunityRef;
  remoteRoomId: string;
  ownerAuthorId: string;
  localEntryId: string;
  localParentEntryId: string | null;
  localAgentId: string;
  attachmentIds: string;
  idempotencyKey: string;
  state: CommunityOutboxState;
  createdAt: string;
  expiresAt: string;
  remoteEntryId: string | null;
  failure: string | null;
  attempts: number;
  nextAttemptAt: string;
}

/** SQLite outbox whose inserts share the RoomEntryWriter entry transaction. */
export class CommunityOutboxStore {
  constructor(private readonly db: Db) {}

  /** Insert a pending row inside the entry's own SQLite transaction. */
  enqueue(item: CommunityOutboxItem, tx: DbTransaction): void {
    tx.insert(communityOutbox).values(item).run();
  }

  /** Bounded pending count used before the entry transaction claims delivery. */
  pendingCount(communityRef?: CommunityRef): number {
    const where = communityRef
      ? and(eq(communityOutbox.state, 'pending'), eq(communityOutbox.communityRef, communityRef))
      : eq(communityOutbox.state, 'pending');
    return this.db.select({ id: communityOutbox.id }).from(communityOutbox).where(where).all()
      .length;
  }

  /** Pending or repairable failed delivery rows for one local connection owner. */
  visibleForOwner(ownerAuthorId: string): readonly CommunityOutboxItem[] {
    return this.db
      .select()
      .from(communityOutbox)
      .where(
        and(
          eq(communityOutbox.ownerAuthorId, ownerAuthorId),
          or(eq(communityOutbox.state, 'pending'), eq(communityOutbox.state, 'failed'))
        )
      )
      .orderBy(communityOutbox.createdAt)
      .all()
      .map((row) => ({
        ...row,
        communityRef: row.communityRef as CommunityRef,
        state: row.state as CommunityOutboxState,
      }));
  }

  /** Whether an item remains eligible after a concurrent local Stop or receipt. */
  isPending(id: string): boolean {
    return (
      this.db
        .select({ id: communityOutbox.id })
        .from(communityOutbox)
        .where(and(eq(communityOutbox.id, id), eq(communityOutbox.state, 'pending')))
        .get() !== undefined
    );
  }

  /** Mark one local output confirmed only after a remote receipt or matching echo. */
  confirm(id: string, remoteEntryId: string): void {
    this.db
      .update(communityOutbox)
      .set({ state: 'confirmed', remoteEntryId, failure: null })
      .where(and(eq(communityOutbox.id, id), eq(communityOutbox.state, 'pending')))
      .run();
  }

  /**
   * Record a server-confirmed remote identity for an owner-originated write.
   *
   * The caller writes this immediately after the HTTP receipt. The stream
   * importer can then suppress the remote echo without comparing a person’s
   * name, account, or credential.
   */
  recordOrigin(input: {
    communityRef: CommunityRef;
    remoteRoomId: string;
    ownerAuthorId: string;
    remoteEntryId: string;
    idempotencyKey: string;
    createdAt?: string;
  }): void {
    this.db
      .insert(communityEntryOrigins)
      .values({
        ...input,
        createdAt: input.createdAt ?? new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();
  }

  /**
   * Bind a stream entry to a local durable origin and settle an agent outbox
   * row when its receipt was lost or arrived after the echo.
   */
  confirmByRemoteEntry(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    remoteEntryId: string
  ): string | null {
    const origin = this.originForRemoteEntry(
      communityRef,
      remoteRoomId,
      ownerAuthorId,
      remoteEntryId
    );
    if (!origin) return null;
    this.db
      .update(communityOutbox)
      .set({ state: 'confirmed', remoteEntryId, failure: null })
      .where(
        and(
          eq(communityOutbox.communityRef, communityRef),
          eq(communityOutbox.remoteRoomId, remoteRoomId),
          eq(communityOutbox.ownerAuthorId, ownerAuthorId),
          eq(communityOutbox.idempotencyKey, origin),
          eq(communityOutbox.state, 'pending')
        )
      )
      .run();
    return origin;
  }

  /** Return the owner-only origin key for a remote echo, if this install wrote it. */
  originForRemoteEntry(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    remoteEntryId: string
  ): string | null {
    return (
      this.db
        .select({ idempotencyKey: communityEntryOrigins.idempotencyKey })
        .from(communityEntryOrigins)
        .where(
          and(
            eq(communityEntryOrigins.communityRef, communityRef),
            eq(communityEntryOrigins.remoteRoomId, remoteRoomId),
            eq(communityEntryOrigins.ownerAuthorId, ownerAuthorId),
            eq(communityEntryOrigins.remoteEntryId, remoteEntryId)
          )
        )
        .get()?.idempotencyKey ?? null
    );
  }

  /** Fail closed after Stop, revocation, expiry, or permanent remote refusal. */
  stop(ids: readonly string[], failure: string): void {
    if (ids.length === 0) return;
    this.db
      .update(communityOutbox)
      .set({ state: 'stopped', failure })
      .where(and(inArray(communityOutbox.id, [...ids]), eq(communityOutbox.state, 'pending')))
      .run();
  }

  /** Stop every unsent item for one persisted remote room before local Stop returns. */
  stopForRoom(communityRef: CommunityRef, remoteRoomId: string, ownerAuthorId: string): void {
    this.stopWhere(
      and(
        eq(communityOutbox.communityRef, communityRef),
        eq(communityOutbox.remoteRoomId, remoteRoomId),
        eq(communityOutbox.ownerAuthorId, ownerAuthorId)
      ),
      'stopped'
    );
  }

  /** Stop every unsent item for one enrollment before best-effort remote revoke. */
  stopForAgent(communityRef: CommunityRef, localAgentId: string, ownerAuthorId: string): void {
    this.stopWhere(
      and(
        eq(communityOutbox.communityRef, communityRef),
        eq(communityOutbox.localAgentId, localAgentId),
        eq(communityOutbox.ownerAuthorId, ownerAuthorId)
      ),
      'stopped'
    );
  }

  /**
   * Expire unsent entries before a worker attempts a network action.
   *
   * Returns each affected private owner once so a replacement delivery snapshot
   * can remove stale pending UI without exposing another owner's queue.
   */
  expire(now: string): readonly string[] {
    const where = and(eq(communityOutbox.state, 'pending'), lt(communityOutbox.expiresAt, now));
    const owners = [
      ...new Set(
        this.db
          .select({ ownerAuthorId: communityOutbox.ownerAuthorId })
          .from(communityOutbox)
          .where(where)
          .all()
          .map((row) => row.ownerAuthorId)
      ),
    ];
    if (owners.length === 0) return [];
    this.db.update(communityOutbox).set({ state: 'failed', failure: 'expired' }).where(where).run();
    return owners;
  }

  /** Due rows in bounded order. The worker rechecks all authority before each request. */
  due(now: string, limit = 25): readonly CommunityOutboxItem[] {
    return this.db
      .select()
      .from(communityOutbox)
      .where(and(eq(communityOutbox.state, 'pending'), lte(communityOutbox.nextAttemptAt, now)))
      .orderBy(communityOutbox.createdAt)
      .limit(Math.min(limit, 100))
      .all()
      .map((row) => ({
        ...row,
        communityRef: row.communityRef as CommunityRef,
        state: row.state as CommunityOutboxState,
      }));
  }

  /** Record a retry schedule without changing the idempotency key. */
  retry(id: string, attempts: number, nextAttemptAt: string): void {
    this.db
      .update(communityOutbox)
      .set({ attempts, nextAttemptAt })
      .where(eq(communityOutbox.id, id))
      .run();
  }

  /** Record a permanent failure that requires a person to repair or retry. */
  fail(id: string, failure: string): void {
    this.db
      .update(communityOutbox)
      .set({ state: 'failed', failure })
      .where(eq(communityOutbox.id, id))
      .run();
  }

  /**
   * Requeue one owner-visible lost-receipt delivery without minting a new
   * idempotency key or extending the original expiry.
   *
   * Only `not-confirmed` is repairable: expiry and local Stop are terminal
   * evidence that retrying would either duplicate old work or bypass authority.
   */
  retryNotConfirmed(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    idempotencyKey: string,
    now: string
  ): 'retried' | 'missing' | 'terminal' | 'expired' {
    const item = this.db
      .select()
      .from(communityOutbox)
      .where(
        and(
          eq(communityOutbox.communityRef, communityRef),
          eq(communityOutbox.remoteRoomId, remoteRoomId),
          eq(communityOutbox.ownerAuthorId, ownerAuthorId),
          eq(communityOutbox.idempotencyKey, idempotencyKey)
        )
      )
      .get();
    if (!item) return 'missing';
    if (item.state !== 'failed' || item.failure !== 'not-confirmed') return 'terminal';
    if (item.expiresAt <= now) return 'expired';
    this.db
      .update(communityOutbox)
      .set({ state: 'pending', failure: null, nextAttemptAt: now })
      .where(and(eq(communityOutbox.id, item.id), eq(communityOutbox.state, 'failed')))
      .run();
    return 'retried';
  }

  private stopWhere(where: ReturnType<typeof and>, failure: string): void {
    this.db
      .update(communityOutbox)
      .set({ state: 'stopped', failure })
      .where(and(where, eq(communityOutbox.state, 'pending')))
      .run();
  }
}

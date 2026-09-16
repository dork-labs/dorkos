/**
 * Durable, non-secret bindings between local agent manifests and remote members.
 *
 * The encrypted connection store owns bearer material. This store deliberately
 * holds only the qualified identities and live authority required to decide
 * whether a local agent may receive or later deliver community work.
 *
 * @module services/communities/remote/agent-enrollment-store
 */
import { and, communityAgentEnrollments, eq, type Db } from '@dorkos/db';
import type { CommunityRef } from '@dorkos/shared/community-adapter';

/** One active or revoked local-manifest binding. */
export interface CommunityAgentEnrollment {
  communityRef: CommunityRef;
  localAgentId: string;
  remoteMemberId: string;
  ownerAuthorId: string;
  state: 'active' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

/** The non-secret enrollment state for native community connections. */
export class CommunityAgentEnrollmentStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** Activate the one remote member identity a local manifest may use in one community. */
  activate(input: {
    communityRef: CommunityRef;
    localAgentId: string;
    remoteMemberId: string;
    ownerAuthorId: string;
  }): CommunityAgentEnrollment {
    const timestamp = this.now();
    this.db
      .insert(communityAgentEnrollments)
      .values({ ...input, state: 'active', createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: [communityAgentEnrollments.communityRef, communityAgentEnrollments.localAgentId],
        set: {
          remoteMemberId: input.remoteMemberId,
          ownerAuthorId: input.ownerAuthorId,
          state: 'active',
          updatedAt: timestamp,
        },
      })
      .run();
    const enrollment = this.findLocalAgent(
      input.communityRef,
      input.remoteMemberId,
      input.ownerAuthorId
    );
    if (!enrollment) throw new Error('The community agent enrollment was not persisted');
    return enrollment;
  }

  /** Revoke an enrollment before best-effort credential cleanup. */
  revoke(communityRef: CommunityRef, localAgentId: string, ownerAuthorId: string): void {
    this.db
      .update(communityAgentEnrollments)
      .set({ state: 'revoked', updatedAt: this.now() })
      .where(
        and(
          eq(communityAgentEnrollments.communityRef, communityRef),
          eq(communityAgentEnrollments.localAgentId, localAgentId),
          eq(communityAgentEnrollments.ownerAuthorId, ownerAuthorId),
          eq(communityAgentEnrollments.state, 'active')
        )
      )
      .run();
  }

  /** Resolve an active local manifest from a remote member without trusting display data. */
  findLocalAgent(
    communityRef: CommunityRef,
    remoteMemberId: string,
    ownerAuthorId: string
  ): CommunityAgentEnrollment | null {
    const row = this.db
      .select()
      .from(communityAgentEnrollments)
      .where(
        and(
          eq(communityAgentEnrollments.communityRef, communityRef),
          eq(communityAgentEnrollments.remoteMemberId, remoteMemberId),
          eq(communityAgentEnrollments.ownerAuthorId, ownerAuthorId),
          eq(communityAgentEnrollments.state, 'active')
        )
      )
      .get();
    return row
      ? {
          ...row,
          communityRef: row.communityRef as CommunityRef,
          state: row.state as CommunityAgentEnrollment['state'],
        }
      : null;
  }

  /** Resolve a local binding in either state for retryable remote cleanup. */
  findAnyRemoteMember(
    communityRef: CommunityRef,
    localAgentId: string,
    ownerAuthorId: string
  ): CommunityAgentEnrollment | null {
    const row = this.db
      .select()
      .from(communityAgentEnrollments)
      .where(
        and(
          eq(communityAgentEnrollments.communityRef, communityRef),
          eq(communityAgentEnrollments.localAgentId, localAgentId),
          eq(communityAgentEnrollments.ownerAuthorId, ownerAuthorId)
        )
      )
      .get();
    return row
      ? {
          ...row,
          communityRef: row.communityRef as CommunityRef,
          state: row.state as CommunityAgentEnrollment['state'],
        }
      : null;
  }

  /** Resolve an active remote principal from a local manifest and owner grant. */
  findRemoteMember(
    communityRef: CommunityRef,
    localAgentId: string,
    ownerAuthorId: string
  ): CommunityAgentEnrollment | null {
    const row = this.db
      .select()
      .from(communityAgentEnrollments)
      .where(
        and(
          eq(communityAgentEnrollments.communityRef, communityRef),
          eq(communityAgentEnrollments.localAgentId, localAgentId),
          eq(communityAgentEnrollments.ownerAuthorId, ownerAuthorId),
          eq(communityAgentEnrollments.state, 'active')
        )
      )
      .get();
    return row
      ? {
          ...row,
          communityRef: row.communityRef as CommunityRef,
          state: row.state as CommunityAgentEnrollment['state'],
        }
      : null;
  }

  /** Enumerate every distinct owner-qualified community with active native agents. */
  activeConnections(): readonly { communityRef: CommunityRef; ownerAuthorId: string }[] {
    const rows = this.db
      .select({
        communityRef: communityAgentEnrollments.communityRef,
        ownerAuthorId: communityAgentEnrollments.ownerAuthorId,
      })
      .from(communityAgentEnrollments)
      .where(eq(communityAgentEnrollments.state, 'active'))
      .all();
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const key = `${row.communityRef}:${row.ownerAuthorId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ communityRef: row.communityRef as CommunityRef, ownerAuthorId: row.ownerAuthorId }];
    });
  }

  /** Active local manifests owned by this connection, for a local-only room Stop. */
  activeLocalAgentIds(communityRef: CommunityRef, ownerAuthorId: string): readonly string[] {
    return this.db
      .select({ localAgentId: communityAgentEnrollments.localAgentId })
      .from(communityAgentEnrollments)
      .where(
        and(
          eq(communityAgentEnrollments.communityRef, communityRef),
          eq(communityAgentEnrollments.ownerAuthorId, ownerAuthorId),
          eq(communityAgentEnrollments.state, 'active')
        )
      )
      .all()
      .map((row) => row.localAgentId);
  }

  /** List only active local agent bindings owned by this install authority. */
  activeForOwner(
    communityRef: CommunityRef,
    ownerAuthorId: string
  ): readonly CommunityAgentEnrollment[] {
    return this.db
      .select()
      .from(communityAgentEnrollments)
      .where(
        and(
          eq(communityAgentEnrollments.communityRef, communityRef),
          eq(communityAgentEnrollments.ownerAuthorId, ownerAuthorId),
          eq(communityAgentEnrollments.state, 'active')
        )
      )
      .all()
      .map((row) => ({
        ...row,
        communityRef: row.communityRef as CommunityRef,
        state: row.state as CommunityAgentEnrollment['state'],
      }));
  }
}

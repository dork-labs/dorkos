/**
 * Imports native remote room streams and explicitly dispatches only fresh,
 * authorized external-human entries.
 *
 * @module services/communities/remote/remote-room-subscription-bridge
 */
import { CommunityEntrySchema, type CommunityEntry } from '@dorkos/shared/community-adapter';
import type { RoomService } from '../../rooms/room-service.js';
import type { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
import type { CommunityOutboxStore } from './community-outbox-store.js';
import { RemoteMirrorStore, type MirrorRoomInput, type NativeMirrorEntry } from './mirror-store.js';

/** One native entry after the adapter has retained its wire sequence and author kind. */
export interface RemoteLiveEntry {
  entry: CommunityEntry;
  remoteSeq: number;
  /** Remote identity metadata is provenance only, never local authority. */
  author: { memberId: string; displayName: string; kind: 'human' | 'agent' | 'system' };
  /** Server timestamp used only as a conservative reconnect freshness bound. */
  serverCreatedAt: string;
  /** Owner-authorized exact post key retained from the native wire, never inferred. */
  originIdempotencyKey?: string;
}

/**
 * Native subscription frames after the adapter classified replay separately
 * from a newly committed event. The generic port deliberately cannot infer
 * that distinction from an opaque cursor, so this bridge never guesses it.
 */
export type RemoteSubscriptionFrame =
  | { type: 'snapshot'; entries: readonly RemoteLiveEntry[] }
  | { type: 'replay'; entries: readonly RemoteLiveEntry[] }
  | {
      type: 'live';
      entry: RemoteLiveEntry;
      reconnect: boolean;
      wasActiveBeforeDisconnect: boolean;
      readOnly: boolean;
    };

/** Resolve an enrolled local manifest id to its existing local room author id. */
export interface LocalAgentAuthorResolver {
  (localAgentId: string): string | null;
}

/** Cancels only remote delivery already in flight for a local Stop or revocation target. */
export interface CommunityOutboxInFlightAborter {
  abortForRoom(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    ownerAuthorId: string
  ): void;
  abortForAgent(
    communityRef: MirrorRoomInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string
  ): void;
  abortForAgentInRoom?(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): void;
  /** Stop durable unsent work and abort its matching network operation together. */
  stopForAgent?(
    communityRef: MirrorRoomInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string
  ): void;
  stopForAgentInRoom?(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): void;
}

/** Server-only bridge from a native remote stream into the existing room dispatcher. */
export class RemoteRoomSubscriptionBridge {
  private readonly dispatchesSinceBoot = new Map<string, number>();

  constructor(
    private readonly mirrors: RemoteMirrorStore,
    private readonly service: RoomService,
    private readonly enrollments: CommunityAgentEnrollmentStore,
    private readonly resolveLocalAgentAuthor: LocalAgentAuthorResolver,
    private readonly now: () => number = () => Date.now(),
    private readonly outbox?: CommunityOutboxStore,
    private readonly outboxAborter?: CommunityOutboxInFlightAborter
  ) {}

  /**
   * Consume native classified stream frames. Snapshots and gap-free replay are
   * cache-only; only an explicitly fresh live frame can reach the dispatcher.
   */
  async consume(
    room: MirrorRoomInput,
    frames: AsyncIterable<RemoteSubscriptionFrame>
  ): Promise<void> {
    for await (const frame of frames) {
      if (frame.type === 'snapshot' || frame.type === 'replay') {
        this.importSnapshot(room, frame.entries);
        continue;
      }
      this.importLive(room, frame.entry, {
        reconnect: frame.reconnect,
        wasActiveBeforeDisconnect: frame.wasActiveBeforeDisconnect,
        readOnly: frame.readOnly,
      });
    }
  }

  /** Import snapshot/history state only. Durable replay is deliberately never a trigger. */
  importSnapshot(room: MirrorRoomInput, entries: readonly RemoteLiveEntry[]): void {
    // A snapshot is cache data, never a directory authorization transition.
    // In particular it cannot turn a revoked or stale persisted mirror back
    // into an authorized one merely because an old subscription delivered late.
    const cached = this.mirrors.cachedRoomForImport(
      room.communityRef,
      room.remoteRoomId,
      room.ownerAuthorId
    );
    if (cached === null) return;
    if (cached === undefined) this.localRoom(room);
    this.mirrors.importEntries(
      room.communityRef,
      room.remoteRoomId,
      entries.map((entry) => this.nativeEntry(room, entry))
    );
    for (const entry of entries) this.reconcileAuthenticatedOrigin(room, entry);
  }

  /** Import one fresh live event, dispatching it at most once when every trust gate holds. */
  importLive(
    room: MirrorRoomInput,
    event: RemoteLiveEntry,
    opts: { reconnect: boolean; wasActiveBeforeDisconnect: boolean; readOnly: boolean }
  ): void {
    // Check before `ensureRoom` refreshes the cache directory. A stale/revoked
    // row is allowed to remain readable under its narrow policy, never renewed
    // merely because an old stream frame arrives.
    if (
      !this.mirrors.isAddressActivelyAuthorized(
        room.communityRef,
        room.remoteRoomId,
        room.ownerAuthorId
      )
    ) {
      return;
    }
    // A live stream is opened only after runtime directory authorization. It
    // may outlive a scoped ejection, so it must never recreate or refresh that
    // mirror from the stale stream descriptor.
    const local = this.mirrors.cachedRoomForImport(
      room.communityRef,
      room.remoteRoomId,
      room.ownerAuthorId
    );
    if (local === null) return;
    const target = local ?? this.localRoom(room);
    const [saved] = this.mirrors.importEntries(room.communityRef, room.remoteRoomId, [
      this.nativeEntry(room, event),
    ]);
    if (this.reconcileAuthenticatedOrigin(room, event)) return;
    if (!saved || opts.readOnly) return;
    if (
      this.outbox?.confirmByRemoteEntry(
        room.communityRef,
        room.remoteRoomId,
        room.ownerAuthorId,
        event.entry.id
      )
    ) {
      return;
    }
    if (event.author.kind !== 'human') return;
    if (
      opts.reconnect &&
      !this.isFreshReconnect(event.serverCreatedAt, opts.wasActiveBeforeDisconnect)
    ) {
      return;
    }
    // The persisted cache state is the final authorization answer immediately
    // before dispatch; revocation and a stale owner grant therefore fail closed.
    if (!this.mirrors.isActivelyAuthorized(target.id, room.ownerAuthorId)) return;
    const dispatchEntry = this.dispatchEntry(target.id, room, event, saved);
    if (!dispatchEntry.mentions.length) return;
    if (
      !this.mirrors.claimRemoteDispatch(
        room.communityRef,
        room.remoteRoomId,
        event.entry.id,
        new Date(this.now()).toISOString()
      )
    ) {
      return;
    }
    this.service.dispatchImportedRemoteEntry(target.id, dispatchEntry);
    const dispatchKey = `${room.communityRef}:${room.ownerAuthorId}:${room.remoteRoomId}`;
    this.dispatchesSinceBoot.set(dispatchKey, (this.dispatchesSinceBoot.get(dispatchKey) ?? 0) + 1);
  }

  /** Bind a server-authenticated agent wire key only to its active owner-qualified enrollment. */
  private reconcileAuthenticatedOrigin(room: MirrorRoomInput, event: RemoteLiveEntry): boolean {
    if (!event.originIdempotencyKey || event.author.kind !== 'agent') return false;
    const outbox = this.outbox;
    if (!outbox) return false;
    const item = outbox.deliveryForOwner(
      room.communityRef,
      room.remoteRoomId,
      room.ownerAuthorId,
      event.originIdempotencyKey
    );
    if (!item || item.state !== 'pending') return false;
    const enrollment = this.enrollments.findRemoteMember(
      room.communityRef,
      item.localAgentId,
      room.ownerAuthorId
    );
    if (enrollment?.remoteMemberId !== event.author.memberId) return false;
    outbox.recordOrigin({
      communityRef: room.communityRef,
      remoteRoomId: room.remoteRoomId,
      ownerAuthorId: room.ownerAuthorId,
      remoteEntryId: event.entry.id,
      idempotencyKey: event.originIdempotencyKey,
    });
    outbox.confirm(item.id, event.entry.id);
    return true;
  }

  /**
   * Revoke locally before remote cleanup, then stop every held or running turn
   * that this enrollment could have started. A native lifecycle caller awaits
   * this before attempting its best-effort remote ejection.
   */
  async revokeEnrollment(
    communityRef: MirrorRoomInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string,
    formerAuthorId?: string | null
  ): Promise<void> {
    const authorId = formerAuthorId ?? this.resolveLocalAgentAuthor(localAgentId);
    this.enrollments.revoke(communityRef, localAgentId, ownerAuthorId);
    if (authorId) this.mirrors.revokeAgentAccess(communityRef, ownerAuthorId, authorId);
    if (this.outboxAborter?.stopForAgent) {
      this.outboxAborter.stopForAgent(communityRef, localAgentId, ownerAuthorId);
    } else {
      this.outbox?.stopForAgent(communityRef, localAgentId, ownerAuthorId);
      this.outboxAborter?.abortForAgent(communityRef, localAgentId, ownerAuthorId);
    }
    if (!authorId) return;
    const stops = this.mirrors
      .roomIdsForOwner(communityRef, ownerAuthorId)
      .map((localRoomId) => this.service.haltAgent(localRoomId, authorId, ownerAuthorId));
    await Promise.all(stops);
    this.mirrors.removeAgentMembership(communityRef, ownerAuthorId, authorId);
  }

  /** Revoke every local authority derived from one rejected owner connection grant. */
  async revokeConnection(
    communityRef: MirrorRoomInput['communityRef'],
    ownerAuthorId: string
  ): Promise<void> {
    const enrollments = [...this.enrollments.activeForOwner(communityRef, ownerAuthorId)];
    this.mirrors.revoke(communityRef);
    await Promise.all(
      enrollments.map((enrollment) =>
        this.revokeEnrollment(communityRef, enrollment.localAgentId, ownerAuthorId)
      )
    );
  }

  /**
   * Revoke rooms an authoritative enrolled-agent directory no longer returns,
   * and stop every local turn and queued delivery that those grants enabled.
   */
  async revokeAbsentRooms(
    communityRef: MirrorRoomInput['communityRef'],
    ownerAuthorId: string,
    allowedRemoteRoomIds: ReadonlySet<string>
  ): Promise<void> {
    const revoked = this.mirrors.revokeAbsentRooms(
      communityRef,
      ownerAuthorId,
      allowedRemoteRoomIds
    );
    await Promise.all(
      revoked.flatMap(({ localRoomId, remoteRoomId }) => {
        this.outbox?.stopForRoom(communityRef, remoteRoomId, ownerAuthorId);
        this.outboxAborter?.abortForRoom(communityRef, remoteRoomId, ownerAuthorId);
        return this.enrollments
          .activeLocalAgentIds(communityRef, ownerAuthorId)
          .flatMap((localAgentId) => {
            const authorId = this.resolveLocalAgentAuthor(localAgentId);
            return authorId ? [this.service.haltAgent(localRoomId, authorId, ownerAuthorId)] : [];
          });
      })
    );
  }

  /** Apply a successful owner-qualified room discovery before any stream frame can dispatch. */
  authorizeRoom(room: MirrorRoomInput): void {
    this.mirrors.ensureRoom(room);
  }

  /** Count successful inbound dispatch claims for one owner-qualified stream since this process booted. */
  dispatchCount(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    ownerAuthorId: string
  ): number {
    return this.dispatchesSinceBoot.get(`${communityRef}:${ownerAuthorId}:${remoteRoomId}`) ?? 0;
  }

  /** Mark cached rooms stale after the owner-qualified background stream becomes unavailable. */
  markStale(communityRef: MirrorRoomInput['communityRef'], ownerAuthorId: string): void {
    this.mirrors.markStale(communityRef, ownerAuthorId);
  }

  /** Stop all locally enrolled agents in one qualified mirror without network access. */
  async haltRoom(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    ownerAuthorId: string
  ): Promise<number> {
    const localRoomId = this.mirrors.localRoomIdForOwner(communityRef, remoteRoomId, ownerAuthorId);
    if (!localRoomId) return 0;
    this.outbox?.stopForRoom(communityRef, remoteRoomId, ownerAuthorId);
    this.outboxAborter?.abortForRoom(communityRef, remoteRoomId, ownerAuthorId);
    const stops = await Promise.all(
      this.enrollments.activeLocalAgentIds(communityRef, ownerAuthorId).flatMap((localAgentId) => {
        const authorId = this.resolveLocalAgentAuthor(localAgentId);
        return authorId ? [this.service.haltAgent(localRoomId, authorId, ownerAuthorId)] : [];
      })
    );
    return stops.reduce((total, stopped) => total + stopped, 0);
  }

  /** Stop one enrolled agent only in one qualified mirror. */
  async haltRoomAgent(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<number> {
    const authorId = this.resolveLocalAgentAuthor(localAgentId);
    const localRoomId = this.mirrors.localRoomIdForOwner(communityRef, remoteRoomId, ownerAuthorId);
    if (
      !authorId ||
      !localRoomId ||
      this.mirrors.canRead(localRoomId, authorId) !== true ||
      !this.enrollments.findRemoteMember(communityRef, localAgentId, ownerAuthorId)
    ) {
      return 0;
    }
    if (this.outboxAborter?.stopForAgentInRoom) {
      this.outboxAborter.stopForAgentInRoom(
        communityRef,
        remoteRoomId,
        localAgentId,
        ownerAuthorId
      );
    } else {
      this.outbox?.stopForAgentInRoom(communityRef, remoteRoomId, localAgentId, ownerAuthorId);
      this.outboxAborter?.abortForAgentInRoom?.(
        communityRef,
        remoteRoomId,
        localAgentId,
        ownerAuthorId
      );
    }
    return this.service.haltAgent(localRoomId, authorId, ownerAuthorId);
  }

  /**
   * Fence one enrolled agent's local state after remote membership removal.
   * It touches only this qualified mirror, preserving other room memberships
   * and other agents' pending delivery.
   */
  async leaveRoom(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<number> {
    const authorId = this.resolveLocalAgentAuthor(localAgentId);
    const localRoomId = this.mirrors.localRoomIdForOwner(communityRef, remoteRoomId, ownerAuthorId);
    if (
      !authorId ||
      !localRoomId ||
      !this.enrollments.findRemoteMember(communityRef, localAgentId, ownerAuthorId)
    ) {
      return 0;
    }
    const wasAuthorized = this.mirrors.canRead(localRoomId, authorId) === true;
    this.mirrors.revokeRoomAgentAccess(communityRef, remoteRoomId, ownerAuthorId, authorId);
    if (this.outboxAborter?.stopForAgentInRoom) {
      this.outboxAborter.stopForAgentInRoom(
        communityRef,
        remoteRoomId,
        localAgentId,
        ownerAuthorId
      );
    } else {
      this.outbox?.stopForAgentInRoom(communityRef, remoteRoomId, localAgentId, ownerAuthorId);
      this.outboxAborter?.abortForAgentInRoom?.(
        communityRef,
        remoteRoomId,
        localAgentId,
        ownerAuthorId
      );
    }
    const stopped = wasAuthorized
      ? await this.service.haltAgent(localRoomId, authorId, ownerAuthorId)
      : 0;
    this.mirrors.removeRoomAgentMembership(communityRef, remoteRoomId, ownerAuthorId, authorId);
    return stopped;
  }

  /** Stop one enrolled local agent in every persisted mirror for this connection. */
  async haltAgent(
    communityRef: MirrorRoomInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<number> {
    const authorId = this.resolveLocalAgentAuthor(localAgentId);
    if (!authorId || !this.enrollments.findRemoteMember(communityRef, localAgentId, ownerAuthorId))
      return 0;
    this.outbox?.stopForAgent(communityRef, localAgentId, ownerAuthorId);
    this.outboxAborter?.abortForAgent(communityRef, localAgentId, ownerAuthorId);
    const stops = await Promise.all(
      this.mirrors
        .roomIdsForOwner(communityRef, ownerAuthorId)
        .map((roomId) => this.service.haltAgent(roomId, authorId, ownerAuthorId))
    );
    return stops.reduce((total, stopped) => total + stopped, 0);
  }

  private localRoom(room: MirrorRoomInput) {
    return this.mirrors.ensureRoom(room);
  }

  private isFreshReconnect(serverCreatedAt: string, wasActiveBeforeDisconnect: boolean): boolean {
    if (!wasActiveBeforeDisconnect) return false;
    const createdAt = Date.parse(serverCreatedAt);
    const age = this.now() - createdAt;
    return Number.isFinite(age) && age >= 0 && age <= 30_000;
  }

  private nativeEntry(room: MirrorRoomInput, event: RemoteLiveEntry): NativeMirrorEntry {
    // Parse before persisting or dispatching so a mutable native projection
    // cannot alter the mentions the dispatcher already evaluated.
    const entry = CommunityEntrySchema.parse(event.entry);
    return {
      entry,
      remoteSeq: event.remoteSeq,
      author: {
        memberId: event.author.memberId,
        displayName: event.author.displayName,
        kind: event.author.kind,
      },
    };
  }

  /** Translate remote mention identities only on the short-lived local dispatch view. */
  private dispatchEntry(
    localRoomId: string,
    room: MirrorRoomInput,
    event: RemoteLiveEntry,
    saved: ReturnType<RemoteMirrorStore['importEntries']>[number]
  ) {
    const mentions = CommunityEntrySchema.parse(event.entry).mentions.flatMap((remoteMemberId) => {
      const enrollment = this.enrollments.findLocalAgent(
        room.communityRef,
        remoteMemberId,
        room.ownerAuthorId
      );
      if (!enrollment) return [];
      const authorId = this.resolveLocalAgentAuthor(enrollment.localAgentId);
      // Membership is refreshed from the enrolled agent's own remote
      // directory. Keep the persisted per-room grant as the final fence so a
      // late event cannot dispatch an agent removed during reconciliation.
      return authorId && this.mirrors.canRead(localRoomId, authorId) === true ? [authorId] : [];
    });
    return { ...saved, mentions };
  }
}

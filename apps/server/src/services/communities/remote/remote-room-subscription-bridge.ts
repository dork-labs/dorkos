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
import type {
  ConfirmNativePostOrigin,
  ReleaseNativePostOrigin,
  ReserveNativePostOrigin,
} from './community-adapter-outbox-delivery.js';
import { RemoteMirrorStore, type MirrorRoomInput, type NativeMirrorEntry } from './mirror-store.js';

/** One native entry after the adapter has retained its wire sequence and author kind. */
export interface RemoteLiveEntry {
  entry: CommunityEntry;
  remoteSeq: number;
  /** Remote identity metadata is provenance only, never local authority. */
  author: { memberId: string; displayName: string; kind: 'human' | 'agent' | 'system' };
  /** Server timestamp used only as a conservative reconnect freshness bound. */
  serverCreatedAt: string;
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
}

/** A route-local buffered agent frame may now be released as cache-only or with one exact origin. */
export interface NativePostBarrierEvent {
  communityRef: MirrorRoomInput['communityRef'];
  remoteRoomId: string;
  ownerAuthorId: string;
}

/** Receives receipt and abandonment notifications for a bounded native-post barrier. */
export interface NativePostBarrierListener {
  (event: NativePostBarrierEvent): void;
}

interface PendingNativePost {
  communityRef: MirrorRoomInput['communityRef'];
  remoteRoomId: string;
  ownerAuthorId: string;
  idempotencyKey: string;
  frames: Array<{ room: MirrorRoomInput; event: RemoteLiveEntry }>;
  timeout: ReturnType<typeof setTimeout>;
}

/** Keep each unreceived post barrier private to its owner-qualified remote room. */
function nativePostScope(input: {
  communityRef: MirrorRoomInput['communityRef'];
  remoteRoomId: string;
  ownerAuthorId: string;
}): string {
  return `${input.communityRef}:${input.ownerAuthorId}:${input.remoteRoomId}`;
}

/** Server-only bridge from a native remote stream into the existing room dispatcher. */
export class RemoteRoomSubscriptionBridge {
  private readonly confirmedNativeOrigins = new Set<string>();
  private readonly dispatchesSinceBoot = new Map<string, number>();
  private readonly pendingNativePosts = new Map<string, PendingNativePost>();
  private readonly nativePostBarrierListeners = new Set<NativePostBarrierListener>();

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

  /**
   * Release a receipt-confirmed native echo only after its durable origin is
   * present. The stream never infers ownership from a human account or label.
   */
  confirmNativePostOrigin: ConfirmNativePostOrigin = (input) => {
    const reservation = this.pendingNativePosts.get(nativePostScope(input));
    if (reservation?.idempotencyKey === input.idempotencyKey) {
      this.pendingNativePosts.delete(nativePostScope(input));
      clearTimeout(reservation.timeout);
      for (const frame of reservation.frames) this.importCacheOnly(frame.room, frame.event);
      this.notifyNativePostBarrier(reservation);
    }
    this.confirmedNativeOrigins.add(
      `${input.communityRef}:${input.ownerAuthorId}:${input.remoteEntryId}`
    );
  };

  /** Hold agent frames briefly while one exact post waits for its authoritative receipt. */
  reserveNativePostOrigin: ReserveNativePostOrigin = (input) => {
    const scope = nativePostScope(input);
    const existing = this.pendingNativePosts.get(scope);
    if (existing) this.releasePendingNativePost(existing);
    const reservation: PendingNativePost = {
      ...input,
      frames: [],
      timeout: setTimeout(() => this.releaseNativePostOrigin(reservation), 10_000),
    };
    this.pendingNativePosts.set(scope, reservation);
  };

  /** Release a failed, aborted, or timed-out barrier without claiming any buffered remote entry. */
  releaseNativePostOrigin: ReleaseNativePostOrigin = (input) => {
    const reservation = this.pendingNativePosts.get(nativePostScope(input));
    if (!reservation || reservation.idempotencyKey !== input.idempotencyKey) return;
    this.releasePendingNativePost(reservation);
  };

  /** Whether an independent owner SSE stream must briefly buffer an agent entry. */
  shouldBufferNativeAgentEntry(
    communityRef: MirrorRoomInput['communityRef'],
    remoteRoomId: string,
    ownerAuthorId: string,
    authorKind: 'human' | 'agent'
  ): boolean {
    return (
      authorKind === 'agent' &&
      this.pendingNativePosts.has(nativePostScope({ communityRef, remoteRoomId, ownerAuthorId }))
    );
  }

  /** Observe bounded barrier release so route-local buffered entries can be written in source order. */
  onNativePostBarrierRelease(listener: NativePostBarrierListener): () => void {
    this.nativePostBarrierListeners.add(listener);
    return () => this.nativePostBarrierListeners.delete(listener);
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
    const local = this.localRoom(room);
    if (event.author.kind === 'agent') {
      const reservation = this.pendingNativePosts.get(nativePostScope(room));
      if (reservation) {
        reservation.frames.push({ room, event });
        return;
      }
    }
    const [saved] = this.mirrors.importEntries(room.communityRef, room.remoteRoomId, [
      this.nativeEntry(room, event),
    ]);
    if (!saved || opts.readOnly) return;
    const originKey = `${room.communityRef}:${room.ownerAuthorId}:${event.entry.id}`;
    if (this.confirmedNativeOrigins.delete(originKey)) {
      this.outbox?.confirmByRemoteEntry(
        room.communityRef,
        room.remoteRoomId,
        room.ownerAuthorId,
        event.entry.id
      );
      return;
    }
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
    if (!this.mirrors.isActivelyAuthorized(local.id, room.ownerAuthorId)) return;
    const dispatchEntry = this.dispatchEntry(local.id, room, event, saved);
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
    this.service.dispatchImportedRemoteEntry(local.id, dispatchEntry);
    const dispatchKey = `${room.communityRef}:${room.ownerAuthorId}:${room.remoteRoomId}`;
    this.dispatchesSinceBoot.set(dispatchKey, (this.dispatchesSinceBoot.get(dispatchKey) ?? 0) + 1);
  }

  private releasePendingNativePost(reservation: PendingNativePost): void {
    const scope = nativePostScope(reservation);
    if (this.pendingNativePosts.get(scope) === reservation) this.pendingNativePosts.delete(scope);
    clearTimeout(reservation.timeout);
    for (const frame of reservation.frames) this.importCacheOnly(frame.room, frame.event);
    this.notifyNativePostBarrier(reservation);
  }

  private notifyNativePostBarrier(reservation: PendingNativePost): void {
    for (const listener of this.nativePostBarrierListeners)
      listener({
        communityRef: reservation.communityRef,
        remoteRoomId: reservation.remoteRoomId,
        ownerAuthorId: reservation.ownerAuthorId,
      });
  }

  private importCacheOnly(room: MirrorRoomInput, event: RemoteLiveEntry): void {
    const cached = this.mirrors.cachedRoomForImport(
      room.communityRef,
      room.remoteRoomId,
      room.ownerAuthorId
    );
    if (cached === null) return;
    if (cached === undefined) this.localRoom(room);
    this.mirrors.importEntries(room.communityRef, room.remoteRoomId, [
      this.nativeEntry(room, event),
    ]);
  }

  /**
   * Revoke locally before remote cleanup, then stop every held or running turn
   * that this enrollment could have started. A native lifecycle caller awaits
   * this before attempting its best-effort remote ejection.
   */
  async revokeEnrollment(
    communityRef: MirrorRoomInput['communityRef'],
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<void> {
    this.enrollments.revoke(communityRef, localAgentId, ownerAuthorId);
    this.outbox?.stopForAgent(communityRef, localAgentId, ownerAuthorId);
    this.outboxAborter?.abortForAgent(communityRef, localAgentId, ownerAuthorId);
    const authorId = this.resolveLocalAgentAuthor(localAgentId);
    if (!authorId) return;
    const stops = this.mirrors
      .roomIdsForOwner(communityRef, ownerAuthorId)
      .map((localRoomId) => this.service.haltAgent(localRoomId, authorId, ownerAuthorId));
    await Promise.all(stops);
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

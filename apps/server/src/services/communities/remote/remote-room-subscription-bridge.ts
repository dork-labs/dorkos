/**
 * Imports native remote room streams and explicitly dispatches only fresh,
 * authorized external-human entries.
 *
 * @module services/communities/remote/remote-room-subscription-bridge
 */
import { CommunityEntrySchema, type CommunityEntry } from '@dorkos/shared/community-adapter';
import type { RoomService } from '../../rooms/room-service.js';
import type { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
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

/** Server-only bridge from a native remote stream into the existing room dispatcher. */
export class RemoteRoomSubscriptionBridge {
  private readonly knownRooms = new Map<string, { localRoomId: string; input: MirrorRoomInput }>();

  constructor(
    private readonly mirrors: RemoteMirrorStore,
    private readonly service: RoomService,
    private readonly enrollments: CommunityAgentEnrollmentStore,
    private readonly resolveLocalAgentAuthor: LocalAgentAuthorResolver,
    private readonly now: () => number = () => Date.now()
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
    this.localRoom(room);
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
    const local = this.localRoom(room);
    const [saved] = this.mirrors.importEntries(room.communityRef, room.remoteRoomId, [
      this.nativeEntry(room, event),
    ]);
    if (!saved || opts.readOnly || event.author.kind !== 'human') return;
    if (
      opts.reconnect &&
      !this.isFreshReconnect(event.serverCreatedAt, opts.wasActiveBeforeDisconnect)
    ) {
      return;
    }
    // The persisted cache state is the final authorization answer immediately
    // before dispatch; revocation and a stale owner grant therefore fail closed.
    if (this.mirrors.canRead(local.id, room.ownerAuthorId) !== true) return;
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
    this.service.dispatchImportedRemoteEntry(local.id, saved);
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
    const authorId = this.resolveLocalAgentAuthor(localAgentId);
    if (!authorId) return;
    const stops = [...this.knownRooms.values()]
      .filter(
        ({ input }) => input.communityRef === communityRef && input.ownerAuthorId === ownerAuthorId
      )
      .map(({ localRoomId }) => this.service.haltAgent(localRoomId, authorId, ownerAuthorId));
    await Promise.all(stops);
  }

  private localRoom(room: MirrorRoomInput) {
    const local = this.mirrors.ensureRoom(room);
    this.knownRooms.set(`${room.communityRef}:${room.remoteRoomId}`, {
      localRoomId: local.id,
      input: room,
    });
    return local;
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
    const mentions = entry.mentions.flatMap((remoteMemberId) => {
      const enrollment = this.enrollments.findLocalAgent(
        room.communityRef,
        remoteMemberId,
        room.ownerAuthorId
      );
      if (!enrollment) return [];
      const authorId = this.resolveLocalAgentAuthor(enrollment.localAgentId);
      return authorId ? [authorId] : [];
    });
    return {
      entry: { ...entry, mentions },
      remoteSeq: event.remoteSeq,
      author: {
        memberId: event.author.memberId,
        displayName: event.author.displayName,
        kind: event.author.kind,
      },
    };
  }
}

/**
 * Owns background native-room subscriptions for active remote-agent enrollments.
 *
 * @module services/communities/remote/remote-room-subscription-runtime
 */
import type {
  CommunityAdapter,
  CommunityEntry,
  CommunityRoom,
  CommunityRef,
  CommunityReadContext,
} from '@dorkos/shared/community-adapter';
import type { CommunityConnectionAccess } from '@dorkos/shared/community-wire';
import {
  remoteAuthorOf,
  remoteOriginIdempotencyKeyOf,
  remoteRoomAccessOf,
  remoteSequenceOf,
  type RemoteNativeRoomEvent,
} from './remote-community-adapter.js';
import type { CommunityAgentEnrollmentStore } from './agent-enrollment-store.js';
import {
  RemoteRoomSubscriptionBridge,
  type RemoteLiveEntry,
  type RemoteSubscriptionFrame,
} from './remote-room-subscription-bridge.js';
import type { MirrorRoomInput } from './mirror-store.js';

/** A shared native adapter resolved for the exact community and local owner. */
export interface RemoteRoomSubscriptionAdapter extends Pick<CommunityAdapter, 'listRooms'> {
  subscribeNativeRoom(
    roomId: string,
    sinceCursor?: CommunityEntry['cursor'],
    signal?: AbortSignal,
    context?: CommunityReadContext
  ): AsyncIterable<RemoteNativeRoomEvent>;
}

/** Dependencies already constructed by the remote runtime bootstrap. */
export interface RemoteRoomSubscriptionRuntimeDeps {
  bridge: RemoteRoomSubscriptionBridge;
  enrollments: CommunityAgentEnrollmentStore;
  adapters: (
    communityRef: CommunityRef,
    ownerAuthorId: string
  ) => RemoteRoomSubscriptionAdapter | null;
  /** Refresh the exact owner's personal grant before any enrolled-agent remote I/O. */
  resolveConnectionAccess: (
    communityRef: CommunityRef,
    ownerAuthorId: string
  ) => Promise<CommunityConnectionAccess | null>;
  resolveLocalAgentAuthor: (localAgentId: string) => string | null;
  /**
   * Connected Communities whose last known access is read-only, across every owner. Those with
   * no enrolled agent are re-checked on {@link releaseCheckMs}; the rest already are on every
   * reconcile.
   */
  readOnlyConnections?: () => Promise<
    readonly { communityRef: CommunityRef; ownerAuthorId: string }[]
  >;
  now?: () => number;
  retryMs?: number;
  /** How often a read-only connection with no enrolled agent re-checks its access. */
  releaseCheckMs?: number;
  /** Test seam for portable mock rooms; native production rooms use retained metadata. */
  isRoomJoined?: (room: CommunityRoom) => boolean;
  /** Test seam for native private entry metadata retained by the adapter. */
  toLiveEntry?: (entry: CommunityEntry) => RemoteLiveEntry | null;
  /** Mesh is authoritative only after startup reconciliation completes. */
  isReady?: () => boolean;
}

interface DesiredSubscription {
  key: string;
  signature: string;
  localAgentId: string;
  adapter: RemoteRoomSubscriptionAdapter;
  room: MirrorRoomInput;
  context: CommunityReadContext;
}

interface DiscoveredRoom {
  room: CommunityRoom;
  accessors: MirrorRoomInput['accessors'];
  members: Array<{ authorId: string; localAgentId: string; remoteMemberId: string }>;
}

interface RunningSubscription {
  signature: string;
  abort: AbortController;
  communityRef: CommunityRef;
  ownerAuthorId: string;
  remoteRoomId: string;
  localAgentId: string;
}

/** Test-only readout of the current owner-qualified native replay boundary. */
export interface RemoteRoomSubscriptionObservation {
  generation: number;
  snapshotComplete: boolean;
  replayComplete: boolean;
  dispatchesSinceBoot: number;
}

interface MutableObservation {
  generation: number;
  snapshotComplete: boolean;
  replayComplete: boolean;
}

/** How often a read-only connection with no enrolled agent re-checks its access: 5 minutes. */
export const READ_ONLY_RECHECK_MS = 5 * 60_000;

/**
 * Background consumer for native Community room streams.
 *
 * A browser SSE reader is intentionally unrelated to this runtime: active
 * enrolled agents keep receiving eligible remote human mentions when no browser
 * is connected. Every stream starts with a cache-only snapshot; only later
 * entry frames are handed to the bridge as fresh live work.
 */
export class RemoteRoomSubscriptionRuntime {
  private readonly running = new Map<string, RunningSubscription>();
  private readonly observations = new Map<string, MutableObservation>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private releaseTimer: ReturnType<typeof setInterval> | undefined;
  private checkingReleases: Promise<void> | undefined;
  private reconciling: Promise<void> | undefined;
  private refreshQueued = false;
  private membershipVersion = 0;
  private stopped = true;

  constructor(private readonly deps: RemoteRoomSubscriptionRuntimeDeps) {}

  /** Discover active owner-qualified enrollment streams and begin consuming them. */
  start(): void {
    if (!this.stopped) {
      this.refresh();
      return;
    }
    this.stopped = false;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.deps.retryMs ?? 5_000);
    this.releaseTimer = setInterval(
      () => this.checkReleases(),
      this.deps.releaseCheckMs ?? READ_ONLY_RECHECK_MS
    );
  }

  /** Abort every private remote stream before shutdown completes. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.releaseTimer) clearInterval(this.releaseTimer);
    this.releaseTimer = undefined;
    for (const subscription of this.running.values()) subscription.abort.abort();
    this.running.clear();
  }

  /** Read the completed replay boundary and inbound dispatch count for one exact owner-qualified room. */
  observation(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): RemoteRoomSubscriptionObservation | null {
    const key = `${communityRef}:${ownerAuthorId}:${remoteRoomId}`;
    const observation = this.observations.get(key);
    if (!observation) return null;
    return {
      ...observation,
      dispatchesSinceBoot: this.deps.bridge.dispatchCount(
        communityRef,
        remoteRoomId,
        ownerAuthorId
      ),
    };
  }

  /** Delegate local-only Stop to the same bridge that owns dispatch receipts. */
  haltRoom(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string
  ): Promise<number> {
    return this.deps.bridge.haltRoom(communityRef, remoteRoomId, ownerAuthorId);
  }

  /** Delegate local-only agent Stop to the same bridge that owns dispatch receipts. */
  haltAgent(
    communityRef: CommunityRef,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<number> {
    return this.deps.bridge.haltAgent(communityRef, localAgentId, ownerAuthorId);
  }

  /** Stop one agent only in one qualified mirror without changing other rooms. */
  haltRoomAgent(
    communityRef: CommunityRef,
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<number> {
    return this.deps.bridge.haltRoomAgent(communityRef, remoteRoomId, localAgentId, ownerAuthorId);
  }

  /**
   * Fence local state after remote membership removal before the route returns.
   * The version invalidates a directory read that began before the removal.
   */
  async leaveRoom(
    communityRef: CommunityRef,
    remoteRoomId: string,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<void> {
    this.membershipVersion += 1;
    this.abortStreamsForAgentInRoom(communityRef, remoteRoomId, ownerAuthorId, localAgentId);
    await this.deps.bridge.leaveRoom(communityRef, remoteRoomId, localAgentId, ownerAuthorId);
    this.refresh();
  }

  /** Fence one ejected enrollment before remote cleanup can leave a stale stream dispatchable. */
  async revokeEnrollment(
    communityRef: CommunityRef,
    localAgentId: string,
    ownerAuthorId: string
  ): Promise<void> {
    this.membershipVersion += 1;
    this.abortStreamsForAgent(communityRef, ownerAuthorId, localAgentId);
    await this.deps.bridge.revokeEnrollment(communityRef, localAgentId, ownerAuthorId);
    this.refresh();
  }

  /** Fence all streams, cached grants, queued delivery, and turns derived from one owner grant. */
  async revokeConnection(communityRef: CommunityRef, ownerAuthorId: string): Promise<void> {
    this.membershipVersion += 1;
    this.abortStreamsForConnection(communityRef, ownerAuthorId);
    await this.deps.bridge.revokeConnection(communityRef, ownerAuthorId);
    this.refresh();
  }

  /** Reconcile immediately after enrollment, ejection, or membership changes. */
  refreshSubscriptions(): void {
    this.refresh();
  }

  /**
   * Remove one deleted local manifest from every qualified remote enrollment.
   *
   * Mesh invokes this after it has removed the registry row, so the former
   * room author is supplied from the durable author registry solely to halt
   * already-running local turns. New work still resolves only through Mesh.
   */
  revokeUnregisteredAgent(localAgentId: string, formerAuthorId: string | null): void {
    // An in-progress directory pass may have captured this enrollment before
    // Mesh removed it. Invalidate that pass so it cannot re-authorize a room or
    // reopen the stream after the cascade below has revoked it.
    this.membershipVersion += 1;
    const enrollments = this.deps.enrollments.activeForLocalAgent(localAgentId);
    for (const enrollment of enrollments) {
      this.abortStreamsForAgent(
        enrollment.communityRef,
        enrollment.ownerAuthorId,
        enrollment.localAgentId
      );
      void this.deps.bridge
        .revokeEnrollment(
          enrollment.communityRef,
          enrollment.localAgentId,
          enrollment.ownerAuthorId,
          formerAuthorId
        )
        .catch(() => undefined);
    }
    this.refresh();
  }

  /**
   * Re-check each read-only connection that has no enrolled agent, so a member-only
   * connection learns that a hold ended. A connection with an enrolled agent is skipped: the
   * reconcile already re-checks it every few seconds and resubscribes once it can stream.
   * Each check is the pairing service's own status read, so a refusal still requires
   * reconnecting exactly as it does anywhere else.
   */
  private checkReleases(): void {
    if (this.stopped || this.checkingReleases || !this.deps.readOnlyConnections) return;
    const readOnly = this.deps.readOnlyConnections;
    this.checkingReleases = (async () => {
      const polled = new Set(
        this.deps.enrollments
          .activeConnections()
          .map((connection) => `${connection.communityRef}\0${connection.ownerAuthorId}`)
      );
      for (const connection of await readOnly()) {
        if (this.stopped) return;
        if (polled.has(`${connection.communityRef}\0${connection.ownerAuthorId}`)) continue;
        await this.deps
          .resolveConnectionAccess(connection.communityRef, connection.ownerAuthorId)
          .catch(() => null);
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        this.checkingReleases = undefined;
      });
  }

  private refresh(): void {
    if (this.stopped || this.deps.isReady?.() === false) return;
    if (this.reconciling) {
      this.refreshQueued = true;
      return;
    }
    this.reconciling = this.reconcile().finally(() => {
      this.reconciling = undefined;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        this.refresh();
      }
    });
  }

  private async reconcile(): Promise<void> {
    const membershipVersion = this.membershipVersion;
    const desired = new Map<string, DesiredSubscription>();
    for (const connection of this.deps.enrollments.activeConnections()) {
      try {
        const access = await this.deps.resolveConnectionAccess(
          connection.communityRef,
          connection.ownerAuthorId
        );
        if (
          access?.state !== 'verified' ||
          !access.effective.read ||
          !access.effective.enrollAgent ||
          !access.effective.stream
        ) {
          this.deps.bridge.markStale(connection.communityRef, connection.ownerAuthorId);
          continue;
        }
        const adapter = this.deps.adapters(connection.communityRef, connection.ownerAuthorId);
        if (!adapter) continue;
        const rooms = new Map<string, DiscoveredRoom>();
        for (const enrollment of this.deps.enrollments.activeForOwner(
          connection.communityRef,
          connection.ownerAuthorId
        )) {
          const authorId = this.deps.resolveLocalAgentAuthor(enrollment.localAgentId);
          if (!authorId) continue;
          // Read as the enrolled agent, not as the owner. A single owner token
          // must never keep a stream open for an agent removed from the room.
          for (const room of await adapter.listRooms({
            actingMemberId: enrollment.remoteMemberId,
          })) {
            if (!this.isJoinedRoom(room)) continue;
            const existing = rooms.get(room.roomId);
            const member = {
              authorId,
              localAgentId: enrollment.localAgentId,
              remoteMemberId: enrollment.remoteMemberId,
            };
            if (existing) {
              if (!existing.members.some((item) => item.localAgentId === member.localAgentId)) {
                existing.members.push(member);
                existing.accessors = [
                  ...existing.accessors,
                  { authorId: member.authorId, responseMode: 'always' },
                ];
              }
            } else {
              rooms.set(room.roomId, {
                room,
                accessors: [{ authorId, responseMode: 'always' }],
                members: [member],
              });
            }
          }
        }

        // `listRooms` is remote I/O. A local Mesh deletion can revoke this
        // enrollment while that await is parked, so do not apply the stale
        // room directory even briefly before the queued fresh refresh runs.
        if (membershipVersion !== this.membershipVersion) return;

        // The complete set of successful enrolled-agent directory reads is
        // authoritative. Any old room absent from it loses its persisted grant
        // and its held turns/outbound work before streams are reconciled.
        await this.deps.bridge.revokeAbsentRooms(
          connection.communityRef,
          connection.ownerAuthorId,
          new Set(rooms.keys())
        );
        for (const { room, accessors, members } of rooms.values()) {
          const input: MirrorRoomInput = {
            communityRef: connection.communityRef,
            remoteRoomId: room.roomId,
            title: room.title,
            topic: room.topic,
            ownerAuthorId: connection.ownerAuthorId,
            accessors,
            authorizedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
          };
          // This fresh enrolled-agent directory read is the only path that may
          // renew a stale mirror; delayed stream snapshots never do so.
          this.deps.bridge.authorizeRoom(input);
          for (const member of members) {
            const key = `${subscriptionKey(input)}:${member.localAgentId}`;
            desired.set(key, {
              key,
              signature: `${key}:${member.remoteMemberId}`,
              localAgentId: member.localAgentId,
              adapter,
              room: input,
              context: { actingMemberId: member.remoteMemberId },
            });
          }
        }
      } catch {
        this.deps.bridge.markStale(connection.communityRef, connection.ownerAuthorId);
      }
    }

    // Never apply a directory snapshot that started before a local Mesh
    // deletion revoked one of its enrollments. The queued refresh above reads
    // the newly authoritative active set after this stale pass returns.
    if (this.stopped || membershipVersion !== this.membershipVersion) return;

    for (const [key, running] of this.running) {
      const next = desired.get(key);
      if (!next || next.signature !== running.signature) {
        running.abort.abort();
        this.running.delete(key);
      }
    }
    if (this.stopped) return;
    for (const next of desired.values()) {
      if (this.running.has(next.key)) continue;
      const abort = new AbortController();
      this.running.set(next.key, {
        signature: next.signature,
        abort,
        communityRef: next.room.communityRef,
        ownerAuthorId: next.room.ownerAuthorId,
        remoteRoomId: next.room.remoteRoomId,
        localAgentId: next.localAgentId,
      });
      void this.consume(next, abort);
    }
  }

  private async consume(desired: DesiredSubscription, abort: AbortController): Promise<void> {
    let wasActiveBeforeDisconnect = false;
    try {
      while (!abort.signal.aborted && !this.stopped) {
        // A reconnect is a new authoritative replay boundary. Replacing the
        // observation before subscribing prevents a test (or runtime caller)
        // from treating the completed prior generation as this stream's ready
        // barrier.
        const observation = this.nextObservation(desired.room);
        const reconnect = wasActiveBeforeDisconnect;
        let receivedSnapshot = false;
        try {
          await this.deps.bridge.consume(
            desired.room,
            this.classifyFrames(
              desired.adapter.subscribeNativeRoom(
                desired.room.remoteRoomId,
                undefined,
                abort.signal,
                desired.context
              ),
              {
                snapshotComplete: () => {
                  receivedSnapshot = true;
                  observation.snapshotComplete = true;
                },
                replayComplete: () => {
                  observation.replayComplete = true;
                },
              },
              { reconnect, wasActiveBeforeDisconnect }
            )
          );
        } catch {
          this.deps.bridge.markStale(desired.room.communityRef, desired.room.ownerAuthorId);
        }
        if (receivedSnapshot) wasActiveBeforeDisconnect = true;
        if (abort.signal.aborted || this.stopped) break;
        await delay(this.deps.retryMs ?? 5_000, abort.signal);
      }
    } finally {
      const current = this.running.get(desired.key);
      if (current?.abort === abort) this.running.delete(desired.key);
    }
  }

  private async *classifyFrames(
    events: AsyncIterable<RemoteNativeRoomEvent>,
    completion: { snapshotComplete: () => void; replayComplete: () => void },
    reconnect: { reconnect: boolean; wasActiveBeforeDisconnect: boolean }
  ): AsyncGenerator<RemoteSubscriptionFrame> {
    let sawSnapshot = false;
    let watermark: number | undefined;
    let replayComplete = false;
    for await (const event of events) {
      if (event.type === 'snapshot') {
        sawSnapshot = true;
        watermark = event.capturedSeq;
        yield {
          type: 'snapshot',
          entries: event.entries.flatMap((entry) => {
            const live = (this.deps.toLiveEntry ?? nativeLiveEntry)(entry);
            return live ? [live] : [];
          }),
        };
        // The bridge asks for the next frame only after synchronous cache import.
        completion.snapshotComplete();
        continue;
      }
      if (event.type === 'replay_complete') {
        if (!sawSnapshot || event.capturedSeq !== watermark) return;
        replayComplete = true;
        yield { type: 'replay', entries: [] };
        // The next pull occurs after all entries through the captured watermark are cached.
        completion.replayComplete();
        continue;
      }
      if (event.type !== 'entry' || !sawSnapshot || watermark === undefined) continue;
      const live = (this.deps.toLiveEntry ?? nativeLiveEntry)(event.entry);
      if (!live) continue;
      if (!replayComplete || live.remoteSeq <= watermark) {
        yield { type: 'replay', entries: [live] };
        continue;
      }
      yield {
        type: 'live',
        entry: live,
        reconnect: reconnect.reconnect,
        wasActiveBeforeDisconnect: reconnect.wasActiveBeforeDisconnect,
        readOnly: false,
      };
    }
  }

  private nextObservation(room: MirrorRoomInput): MutableObservation {
    const key = subscriptionKey(room);
    const previous = this.observations.get(key);
    const observation = {
      generation: (previous?.generation ?? 0) + 1,
      snapshotComplete: false,
      replayComplete: false,
    };
    this.observations.set(key, observation);
    return observation;
  }

  private isJoinedRoom(room: CommunityRoom): boolean {
    if (this.deps.isRoomJoined) return this.deps.isRoomJoined(room);
    const access = remoteRoomAccessOf(room);
    return room.archived === false && access?.joined === true;
  }

  /** Abort only a departed agent's subscription to one qualified remote room. */
  private abortStreamsForAgentInRoom(
    communityRef: CommunityRef,
    remoteRoomId: string,
    ownerAuthorId: string,
    localAgentId: string
  ): void {
    for (const [key, subscription] of this.running) {
      if (
        subscription.communityRef === communityRef &&
        subscription.ownerAuthorId === ownerAuthorId &&
        subscription.remoteRoomId === remoteRoomId &&
        subscription.localAgentId === localAgentId
      ) {
        subscription.abort.abort();
        this.running.delete(key);
      }
    }
  }

  private abortStreamsForAgent(
    communityRef: CommunityRef,
    ownerAuthorId: string,
    localAgentId: string
  ): void {
    for (const [key, subscription] of this.running) {
      if (
        subscription.communityRef === communityRef &&
        subscription.ownerAuthorId === ownerAuthorId &&
        subscription.localAgentId === localAgentId
      ) {
        subscription.abort.abort();
        this.running.delete(key);
      }
    }
  }

  private abortStreamsForConnection(communityRef: CommunityRef, ownerAuthorId: string): void {
    for (const [key, subscription] of this.running) {
      if (
        subscription.communityRef === communityRef &&
        subscription.ownerAuthorId === ownerAuthorId
      ) {
        subscription.abort.abort();
        this.running.delete(key);
      }
    }
  }
}

/** Build one remote cache address key without exposing it outside the server process. */
function subscriptionKey(room: MirrorRoomInput): string {
  return `${room.communityRef}:${room.ownerAuthorId}:${room.remoteRoomId}`;
}

/** Recover native sequence and author metadata without widening the portable entry DTO. */
function nativeLiveEntry(entry: CommunityEntry): RemoteLiveEntry | null {
  const remoteSeq = remoteSequenceOf(entry);
  const author = remoteAuthorOf(entry);
  if (remoteSeq === undefined || !author) return null;
  return {
    entry,
    remoteSeq,
    author: { memberId: entry.authorId, displayName: author.displayName, kind: author.kind },
    serverCreatedAt: entry.createdAt,
    originIdempotencyKey: remoteOriginIdempotencyKeyOf(entry),
  };
}

/** Await a bounded retry delay while letting shutdown or revocation abort immediately. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

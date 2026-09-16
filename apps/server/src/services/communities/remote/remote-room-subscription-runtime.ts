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
import {
  remoteAuthorOf,
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
  resolveLocalAgentAuthor: (localAgentId: string) => string | null;
  now?: () => number;
  retryMs?: number;
  /** Test seam for portable mock rooms; native production rooms use retained metadata. */
  isRoomJoined?: (room: CommunityRoom) => boolean;
  /** Test seam for native private entry metadata retained by the adapter. */
  toLiveEntry?: (entry: CommunityEntry) => RemoteLiveEntry | null;
}

interface DesiredSubscription {
  key: string;
  signature: string;
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
  private reconciling: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly deps: RemoteRoomSubscriptionRuntimeDeps) {}

  /** Discover active owner-qualified enrollment streams and begin consuming them. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), this.deps.retryMs ?? 5_000);
  }

  /** Abort every private remote stream before shutdown completes. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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

  /** Reconcile immediately after enrollment, ejection, or membership changes. */
  refreshSubscriptions(): void {
    this.refresh();
  }

  private refresh(): void {
    if (this.stopped || this.reconciling) return;
    this.reconciling = this.reconcile().finally(() => {
      this.reconciling = undefined;
    });
  }

  private async reconcile(): Promise<void> {
    const desired = new Map<string, DesiredSubscription>();
    for (const connection of this.deps.enrollments.activeConnections()) {
      const adapter = this.deps.adapters(connection.communityRef, connection.ownerAuthorId);
      if (!adapter) continue;
      try {
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
      this.running.set(next.key, { signature: next.signature, abort });
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

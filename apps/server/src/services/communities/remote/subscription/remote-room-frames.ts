/**
 * Turns one native space stream into the frames the subscription bridge imports, and says which
 * stream failures end access (DOR-2976).
 *
 * A first stream is history up to its replay watermark and live after it. A stream that resumes
 * from where the last one stopped is different: everything it carries was posted while the link
 * was down, so each message goes to the bridge as a live frame marked as a reconnect, and the
 * bridge's freshness check decides whether it still wakes an agent. Before, those messages came
 * back inside a fresh snapshot, which never wakes anyone, so a mention sent during a reconnect
 * went unanswered.
 *
 * @module services/communities/remote/subscription/remote-room-frames
 */
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
  type CommunityEntry,
} from '@dorkos/shared/community-adapter';
import { RemoteConnectionAuthorizationError } from '../connection-store.js';
import { PinnedHttpError } from '../pinned-origin.js';
import {
  remoteAuthorOf,
  remoteOriginIdempotencyKeyOf,
  remoteSequenceOf,
  type RemoteNativeRoomEvent,
} from '../remote-community-adapter.js';
import type {
  RemoteLiveEntry,
  RemoteSubscriptionFrame,
} from '../remote-room-subscription-bridge.js';

/** Where one stream stands, so the next can resume from it. */
export type RemoteResumeCursor = CommunityEntry['cursor'];

/** What the frame classifier calls back to while a stream runs. */
export interface RemoteFrameCallbacks {
  /** The snapshot is in the cache. */
  snapshotComplete: () => void;
  /** Everything up to the replay watermark is in the cache. */
  replayComplete: () => void;
  /** The space ended this reader's access. */
  accessEnded: () => void;
  /** The bridge has imported everything up to this point; a later stream resumes after it. */
  reached: (cursor: RemoteResumeCursor) => void;
}

/** How one stream was opened. */
export interface RemoteFrameStream {
  /** Whether an earlier stream for this room delivered a snapshot. */
  reconnect: boolean;
  /** Whether it resumed from that stream's last point, so all it carries was missed. */
  resumed: boolean;
  /** Reads a native entry's sequence and author; the native reader when not given. */
  toLiveEntry?: (entry: CommunityEntry) => RemoteLiveEntry | null;
}

/**
 * Classify one native stream's events into bridge frames.
 *
 * @param events - The native stream.
 * @param callbacks - Told about the stream's progress.
 * @param stream - How the stream was opened.
 */
export async function* classifyNativeFrames(
  events: AsyncIterable<RemoteNativeRoomEvent>,
  callbacks: RemoteFrameCallbacks,
  stream: RemoteFrameStream
): AsyncGenerator<RemoteSubscriptionFrame> {
  const toLive = stream.toLiveEntry ?? nativeLiveEntry;
  // Every message a resumed stream carries was posted while the link was down.
  const missed = (entry: RemoteLiveEntry): RemoteSubscriptionFrame => ({
    type: 'live',
    entry,
    reconnect: true,
    wasActiveBeforeDisconnect: true,
    readOnly: false,
  });
  let sawSnapshot = false;
  let watermark: number | undefined;
  let replayComplete = false;
  for await (const event of events) {
    if (event.type === 'snapshot') {
      sawSnapshot = true;
      watermark = event.capturedSeq;
      const entries = event.entries.flatMap((entry) => {
        const live = toLive(entry);
        return live ? [live] : [];
      });
      // The bridge asks for the next frame only after it has imported this one, so each
      // callback below runs once its frame is in the cache.
      yield { type: 'snapshot', entries: stream.resumed ? [] : entries };
      if (stream.resumed)
        for (const entry of entries) {
          yield missed(entry);
          callbacks.reached(entry.entry.cursor);
        }
      callbacks.reached(event.cursor);
      callbacks.snapshotComplete();
      continue;
    }
    if (event.type === 'replay_complete') {
      if (!sawSnapshot || event.capturedSeq !== watermark) return;
      replayComplete = true;
      yield { type: 'replay', entries: [] };
      callbacks.replayComplete();
      continue;
    }
    if (event.type === 'room_closed') {
      // The Community ended this reader's access (`removed`): a revoked grant, a lost
      // membership, a suspension, or a community being deleted. Ask the access route now rather
      // than at the next reconcile, so a deletion is noticed at once and its copies purged
      // (DOR-2334). The pairing service decides what the answer means; this only asks.
      if (event.reason === 'access-revoked') callbacks.accessEnded();
      continue;
    }
    if (event.type !== 'entry' || !sawSnapshot || watermark === undefined) continue;
    const live = toLive(event.entry);
    if (!live) continue;
    if (!replayComplete || live.remoteSeq <= watermark)
      yield stream.resumed ? missed(live) : { type: 'replay', entries: [live] };
    else
      yield {
        type: 'live',
        entry: live,
        reconnect: stream.reconnect,
        wasActiveBeforeDisconnect: stream.reconnect,
        readOnly: false,
      };
    callbacks.reached(event.entry.cursor);
  }
}

/**
 * Whether a stream failure means the space ended this reader's access, which is when the room's
 * copy turns stale. A dropped connection, a timeout or a server error is not: marking the copy
 * stale then locked the owner's agents out of it, so a reply sent in that moment was refused.
 *
 * @param error - What the stream threw.
 */
export function endsAccess(error: unknown): boolean {
  // An owner-token read refused outright; an agent's own refusal arrives as the HTTP error below.
  if (error instanceof RemoteConnectionAuthorizationError) return true;
  if (error instanceof CommunityRoomNotFoundError) return true;
  return error instanceof PinnedHttpError && (error.status === 401 || error.status === 403);
}

/**
 * Whether the next stream must start fresh rather than resume: after a refusal, since a stale
 * copy keeps only snapshots, and after a cursor the space no longer accepts.
 *
 * @param error - What the stream threw.
 */
export function restartsFresh(error: unknown): boolean {
  return endsAccess(error) || error instanceof StaleCommunityCursorError;
}

/**
 * Recover native sequence and author metadata without widening the portable entry DTO.
 *
 * @param entry - One entry as the native stream carried it.
 */
export function nativeLiveEntry(entry: CommunityEntry): RemoteLiveEntry | null {
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

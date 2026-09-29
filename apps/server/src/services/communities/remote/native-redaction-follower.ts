/**
 * Follows one Community channel's redaction feed for an open native room view, so a message
 * deleted, removed, or erased on the Community server is replaced on screen without a reload
 * (DOR-2544).
 *
 * The Community server's live stream does not carry these changes (a new frame would break older
 * DorkOS installations), so the channel's feed is read on an interval instead, the same way the
 * Community's own page does it. The feed returns each changed entry as it stands now, so what is
 * handed on is the tombstone, never the text it replaced.
 *
 * @module services/communities/remote/native-redaction-follower
 */
import {
  CommunityRoomNotFoundError,
  StaleCommunityCursorError,
} from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import type { NativeMirrorEntry } from './mirror-store.js';
import { RemoteConnectionAuthorizationError } from './connection-store.js';
import {
  RemoteRedactionFeedUnsupportedError,
  type RemoteCommunityAdapter,
} from './remote-community-adapter.js';

/** How often an open native room view reads its channel's changes: 30 seconds. */
export const NATIVE_REDACTION_POLL_MS = 30_000;

/** How long the stream waits for the feed's end before opening without it. */
const READY_TIMEOUT_MS = 5_000;

/** The most pages one poll reads, so a very long backlog yields between polls. */
const MAX_PAGES_PER_POLL = 20;

/** The one adapter method the follower needs. */
export type NativeRedactionReader = Pick<RemoteCommunityAdapter, 'readRedactions'>;

/** A running follower: where it starts, and how it is stopped. */
export interface NativeRedactionFollower {
  /**
   * Read the feed's current end. Call it BEFORE the view's snapshot is read, so a change made
   * between the two is read by the first poll rather than lost. Never throws; resolves once the
   * start is known or the feed turned out to be unavailable.
   */
  ready: Promise<void>;
  /** Start polling. Changes are only handed on after this, so they never precede a snapshot. */
  start(): void;
}

/** Whether an error means this channel's feed cannot be read by this connection at all. */
function isFinal(error: unknown): boolean {
  return (
    error instanceof RemoteRedactionFeedUnsupportedError ||
    error instanceof CommunityRoomNotFoundError ||
    error instanceof RemoteConnectionAuthorizationError
  );
}

/**
 * Follow one channel's redaction feed until `signal` aborts.
 *
 * A server without the feed, a channel this connection may no longer read, or a refused
 * credential stops the follower quietly; the room's own stream reports the last two. Any other
 * failure is logged and the next poll retries from the same cursor. A stale cursor (the server
 * restored a backup) reads the feed again from its start; the view ignores changes to messages
 * it does not hold.
 *
 * @param reader - The owner's adapter for this Community.
 * @param roomId - The channel.
 * @param opts.signal - Ends the follower; aborted when the view's stream closes.
 * @param opts.intervalMs - Time between polls.
 * @param opts.onChanged - Receives each non-empty batch of changed entries, as they stand now.
 */
export function followNativeRedactions(
  reader: NativeRedactionReader,
  roomId: string,
  opts: {
    signal: AbortSignal;
    intervalMs?: number;
    onChanged: (items: NativeMirrorEntry[]) => void;
  }
): NativeRedactionFollower {
  const { signal } = opts;
  let cursor: string | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  const end = reader
    .readRedactions(roomId, { from: 'end', signal })
    .then((page) => {
      cursor ??= page.nextCursor;
    })
    .catch((error: unknown) => {
      // Without a known end the first poll reads from the start: slower, still correct.
      if (isFinal(error)) stopped = true;
    });
  // Never hold the room's stream open waiting on the feed: past this, the first poll reads
  // from the start instead.
  const ready = Promise.race([
    end,
    new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS).unref?.()),
  ]);

  const poll = async (): Promise<void> => {
    let restarted = false;
    for (let page = 0; page < MAX_PAGES_PER_POLL && !signal.aborted; page++) {
      let result;
      try {
        result = await reader.readRedactions(roomId, { cursor, signal });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof StaleCommunityCursorError && !restarted) {
          restarted = true;
          cursor = undefined;
          continue;
        }
        if (isFinal(error)) {
          stopped = true;
          return;
        }
        logger.warn('[communities] reading changed messages for an open room failed; retrying', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      cursor = result.nextCursor;
      const items = result.items.filter((item) => item.entry.roomId === roomId);
      if (items.length && !signal.aborted) {
        try {
          opts.onChanged(items);
        } catch (error) {
          logger.warn('[communities] could not pass on changed messages to an open room', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!result.hasMore) return;
    }
  };

  const schedule = () => {
    if (stopped || signal.aborted) return;
    timer = setTimeout(() => {
      void poll().finally(schedule);
    }, opts.intervalMs ?? NATIVE_REDACTION_POLL_MS);
  };

  return {
    ready,
    start: () => {
      void ready.then(schedule);
    },
  };
}

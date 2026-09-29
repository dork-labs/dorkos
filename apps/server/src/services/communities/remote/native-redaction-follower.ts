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

/** The longest a follower waits between polls after repeated failures: 10 minutes. */
const MAX_BACKOFF_MS = 10 * 60_000;

/** How long the stream waits for the feed's end before opening without it. */
const READY_TIMEOUT_MS = 5_000;

/** The most pages one poll reads, so a very long backlog yields between polls. */
const MAX_PAGES_PER_POLL = 20;

/** The one adapter method the follower needs. */
export type NativeRedactionReader = Pick<RemoteCommunityAdapter, 'readRedactions'>;

/** A running follower: where it starts, and how it is stopped. */
export interface NativeRedactionFollower {
  /**
   * Resolves once the start is known: at once for a resumed position, otherwise when the feed's
   * end was read (call it BEFORE the view's snapshot is read, so a change between the two reaches
   * the first poll), the feed turned out to be unavailable, or the wait ran out. Never rejects.
   */
  ready: Promise<void>;
  /** Start polling. Changes are only handed on after this, so they never precede a snapshot. */
  start(): void;
  /**
   * Where the next poll reads from, for the view to send back when it resumes; `undefined`
   * when no position is known yet (the first poll then reads from the start).
   */
  position(): string | undefined;
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
 * Each poll is one feed read per page, and on the Community server each read takes the same
 * `FOR UPDATE` lock on the channel row that a history read takes (`lockChannel`); that is why
 * polls are 30 seconds apart, back off after failures, and read at most
 * {@link MAX_PAGES_PER_POLL} pages.
 *
 * A server without the feed, a channel this connection may no longer read, or a refused
 * credential stops the follower quietly; the room's own stream reports the last two. Any other
 * failure waits longer before the next poll (doubling up to {@link MAX_BACKOFF_MS}) and is
 * logged once per run of failures, not once per poll. A stale position (the server restored a
 * backup, or a resumed position no longer applies) reads the feed again from its start; the
 * view ignores changes to messages it does not hold.
 *
 * @param reader - The owner's adapter for this Community.
 * @param roomId - The channel.
 * @param opts.signal - Ends the follower; aborted when the view's stream closes.
 * @param opts.intervalMs - Time between polls.
 * @param opts.resumeFrom - The position a resuming view last received. Read from there instead
 *   of the feed's end, so a change made while it was disconnected is not lost.
 * @param opts.onChanged - Receives each non-empty batch of changed entries, as they stand now,
 *   and the feed position after them.
 */
export function followNativeRedactions(
  reader: NativeRedactionReader,
  roomId: string,
  opts: {
    signal: AbortSignal;
    intervalMs?: number;
    resumeFrom?: string;
    onChanged: (items: NativeMirrorEntry[], position: string) => void;
  }
): NativeRedactionFollower {
  const { signal } = opts;
  const interval = opts.intervalMs ?? NATIVE_REDACTION_POLL_MS;
  let cursor: string | undefined = opts.resumeFrom;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  let ready: Promise<void>;
  if (opts.resumeFrom !== undefined) {
    ready = Promise.resolve();
  } else {
    let waited = false;
    const end = reader
      .readRedactions(roomId, { from: 'end', signal })
      .then((page) => {
        // An end read that lands after the wait ran out is ignored: the snapshot went out
        // without it, and starting there would skip whatever changed in between. The first
        // poll reads from the start instead.
        if (!waited) cursor = page.nextCursor;
      })
      .catch((error: unknown) => {
        if (isFinal(error)) stopped = true;
      });
    // Never hold the room's stream open waiting on the feed.
    ready = Promise.race([
      end,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          waited = true;
          resolve();
        }, READY_TIMEOUT_MS).unref?.();
      }),
    ]);
  }

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
        failures += 1;
        if (failures === 1) {
          logger.warn(
            '[communities] reading changed messages for an open room failed; retrying less often',
            { error: error instanceof Error ? error.message : String(error) }
          );
        }
        return;
      }
      failures = 0;
      cursor = result.nextCursor;
      const items = result.items.filter((item) => item.entry.roomId === roomId);
      if (items.length && !signal.aborted) {
        try {
          opts.onChanged(items, result.nextCursor);
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
    const delay = Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(failures, 10));
    timer = setTimeout(() => {
      void poll().finally(schedule);
    }, delay);
  };

  return {
    ready,
    start: () => {
      void ready.then(schedule);
    },
    position: () => cursor,
  };
}

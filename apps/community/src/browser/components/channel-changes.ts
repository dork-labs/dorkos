import { useCallback, useEffect, useRef } from 'react';
import type { CommunityWireRedactionPage } from '@dorkos/shared/community-wire';
import { RequestError, request } from '../api.js';
import type { Entry } from '../types.js';

/** How often an open channel asks for messages that were deleted or removed since it loaded. */
const POLL_MS = 30_000;

/** The changes cursor that reads the channel's changed messages from the very first. */
const FROM_START = '';

/**
 * A cursor after every change the channel's messages have had so far. When the end cannot be
 * read after a few tries, the cursor that reads every change from the first instead: slower,
 * but a message removed while the tab loads is still replaced.
 */
async function changesEnd(channelId: string): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (
        await request<CommunityWireRedactionPage>(
          `/api/v1/channels/${channelId}/redactions?from=end`
        )
      ).nextCursor;
    } catch {
      // Try again; the fallback below is correct, only slower.
    }
  }
  return FROM_START;
}

/**
 * Keep an open channel's messages current when they are deleted, removed, or erased after the
 * tab loaded them. The live stream cannot carry that change (a new event type would break older
 * DorkOS installations), so the tab asks the channel's redaction feed every 30 seconds and when
 * the window regains focus, and hands each batch of changed entries to `apply`.
 *
 * @param channelId - The open channel.
 * @param joined - Whether the reader has joined it; nothing is read before.
 * @param apply - Replaces the given entries wherever the view shows them.
 * @returns `begin`, which history loading awaits before its first read so no change between the
 *   two is missed; `asChanged`, which every later merge (and every rollback of a refused
 *   removal) runs entries through so an older read can never put back text the tab already knows
 *   changed; and `remember`, for a change the tab made itself and the server confirmed.
 */
export function useChannelChanges(
  channelId: string,
  joined: boolean,
  apply: (changed: ReadonlyMap<string, Entry>) => void
) {
  // In memory only (`null` until history loads): a reload loads history as it is now.
  const cursor = useRef<string | null>(null);
  const known = useRef(new Map<string, Entry>());
  const polling = useRef(false);
  const current = useRef(channelId);
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  }, [apply]);

  const begin = useCallback(async (forChannel: string) => {
    const from = await changesEnd(forChannel);
    if (current.current === forChannel) cursor.current = from;
  }, []);

  const remember = useCallback((entry: Entry) => {
    known.current.set(entry.id, entry);
  }, []);

  const asChanged = useCallback(
    (incoming: Entry[]) => incoming.map((entry) => known.current.get(entry.id) ?? entry),
    []
  );

  useEffect(() => {
    current.current = channelId;
    if (!joined) return;
    let active = true;
    const poll = async () => {
      if (polling.current || cursor.current === null) return;
      polling.current = true;
      try {
        const changed = new Map<string, Entry>();
        for (let round = 0; round < 20 && active; round++) {
          const from = cursor.current;
          const query = from === FROM_START ? '' : `?cursor=${encodeURIComponent(from ?? '')}`;
          const page: CommunityWireRedactionPage = await request<CommunityWireRedactionPage>(
            `/api/v1/channels/${channelId}/redactions${query}`
          );
          if (!active) return;
          for (const item of page.redactions) {
            changed.set(item.entry.id, item.entry);
            known.current.set(item.entry.id, item.entry);
          }
          cursor.current = page.nextCursor;
          if (!page.hasMore) break;
        }
        if (active && changed.size) applyRef.current(changed);
      } catch (cause) {
        // A restored backup replaced the history of changes. Read every change from the first,
        // so each message the tab shows, older pages included, is brought up to date.
        if (active && cause instanceof RequestError && cause.status === 410)
          cursor.current = FROM_START;
        // Anything else (offline, a refusal the stream will report) waits for the next poll.
      } finally {
        polling.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      cursor.current = null;
      known.current = new Map();
    };
  }, [channelId, joined]);

  return { begin, asChanged, remember };
}

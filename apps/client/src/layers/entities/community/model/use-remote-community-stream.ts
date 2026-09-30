import { useEffect, useRef, useState } from 'react';
import type { CommunityDelivery } from '@dorkos/shared/community-deliveries';
import { useQueryClient, type InfiniteData } from '@tanstack/react-query';
import type {
  RemoteCommunityEntry,
  RemoteCommunityHistoryResponse,
  RemoteCommunityRoom,
} from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import {
  communityKeys,
  isCommunityContentAuthorityCurrent,
  useCommunityContentAuthority,
} from './use-community-connections';

interface StreamState {
  address: string;
  room: RemoteCommunityRoom | null;
  entries: RemoteCommunityEntry[];
  /**
   * Entries changed in place since this view opened, by id, as they stand now (DOR-2544). Kept
   * beside the entries so a history page answered just before a change, and landing after it,
   * still shows the change.
   */
  revisions: ReadonlyMap<string, RemoteCommunityEntry>;
  deliveries: CommunityDelivery[];
  status: 'connecting' | 'live' | 'offline' | 'removed';
}

/** How many changed entries one open view remembers. */
const MAX_REVISIONS = 500;

const NO_REVISIONS: ReadonlyMap<string, RemoteCommunityEntry> = new Map();

/**
 * One held entry with a change applied: a message deleted, removed or erased on the Community,
 * now its tombstone (DOR-2544).
 *
 * **Only what a change rewrites moves** — the words, the mentions, the files, and the author's
 * name (an erasure replaces it). Everything the view derived or was told separately stays: the
 * entry's place (`remoteSeq`, `cursor`), its thread summary and the reply line under it (#2056),
 * and which delivery it confirmed.
 *
 * @param held - The entry the view holds.
 * @param revised - The same entry as it stands now.
 * @returns `held` itself when the change is not about it or changes nothing.
 */
export function reviseRemoteCommunityEntry(
  held: RemoteCommunityEntry,
  revised: RemoteCommunityEntry
): RemoteCommunityEntry {
  if (
    held.id !== revised.id ||
    held.community !== revised.community ||
    held.roomId !== revised.roomId
  )
    return held;
  if (
    held.text === revised.text &&
    held.authorDisplayName === revised.authorDisplayName &&
    JSON.stringify(held.mentions) === JSON.stringify(revised.mentions) &&
    JSON.stringify(held.attachments) === JSON.stringify(revised.attachments)
  )
    return held;
  return {
    ...held,
    text: revised.text,
    mentions: revised.mentions,
    attachments: revised.attachments,
    authorDisplayName: revised.authorDisplayName,
  };
}

/**
 * Apply every remembered change to a list of entries. Never adds one: a change to an entry the
 * list does not hold is not a row to draw.
 *
 * @param entries - Entries in native order.
 * @param revisions - Changed entries by id.
 * @returns `entries` itself when nothing changed.
 */
export function applyRemoteCommunityRevisions(
  entries: RemoteCommunityEntry[],
  revisions: ReadonlyMap<string, RemoteCommunityEntry>
): RemoteCommunityEntry[] {
  if (revisions.size === 0) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    const revised = revisions.get(entry.id);
    const result = revised ? reviseRemoteCommunityEntry(entry, revised) : entry;
    if (result !== entry) changed = true;
    return result;
  });
  return changed ? next : entries;
}

/** Merge only confirmed immutable IDs using explicit native order, never timestamps or cursor decoding. */
export function mergeRemoteCommunityEntries(
  community: string,
  roomId: string,
  ...groups: readonly RemoteCommunityEntry[][]
): RemoteCommunityEntry[] {
  const entries = new Map<string, RemoteCommunityEntry>();
  for (const group of groups)
    for (const entry of group) {
      if (entry.community !== community || entry.roomId !== roomId)
        throw new Error('Community history contains a different room.');
      entries.set(entry.id, entry);
    }
  return [...entries.values()].sort((a, b) => a.remoteSeq - b.remoteSeq);
}

/**
 * Follow one qualified room with bounded memory and cancelable reconnects.
 * Membership loss clears protected cache; a temporary outage remains visibly stale.
 */
export function useRemoteCommunityStream(
  ref: string,
  roomId: string,
  enabled = true,
  reconnectKey = 0,
  accessFingerprint = 'legacy',
  cacheReadable = false,
  holds?: (entryId: string) => boolean
) {
  const transport = useTransport();
  // Read when a change arrives, so the caller's latest answer is used without reconnecting.
  const holdsRef = useRef(holds);
  useEffect(() => {
    holdsRef.current = holds;
  }, [holds]);
  const queries = useQueryClient();
  const authority = useCommunityContentAuthority(true, accessFingerprint, ref);
  const address = JSON.stringify([
    authority?.ownerKey,
    authority?.epoch,
    authority?.route.epoch,
    authority?.accessFingerprint,
    ref,
    roomId,
  ]);
  const [state, setState] = useState<StreamState>(() => ({
    address,
    room: null,
    entries: [],
    revisions: NO_REVISIONS,
    deliveries: [],
    status: 'connecting',
  }));

  useEffect(() => {
    if (!authority) return;
    if (!enabled) return;
    const currentAuthority = authority;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let since: string | undefined;
    // Where this view reads changed messages from, sent back on a resume so a message deleted
    // or erased while it was disconnected still arrives (DOR-2544).
    let redactions: string | undefined;
    let denied = false;
    setState({
      address,
      room: null,
      entries: [],
      revisions: NO_REVISIONS,
      deliveries: [],
      status: 'connecting',
    });

    function removeAccess() {
      denied = true;
      since = undefined;
      redactions = undefined;
      queries.removeQueries({ queryKey: communityKeys.remote(currentAuthority, ref) });
      setState({
        address,
        room: null,
        entries: [],
        revisions: NO_REVISIONS,
        deliveries: [],
        status: 'removed',
      });
    }

    async function connect() {
      try {
        await transport.subscribeRemoteCommunityRoom(
          ref,
          roomId,
          (event) => {
            if (
              controller.signal.aborted ||
              denied ||
              !isCommunityContentAuthorityCurrent(currentAuthority)
            )
              return;
            if (event.type === 'closed') {
              if (event.reason === 'removed' || event.reason === 'revoked') removeAccess();
              return;
            }
            failures = 0;
            if (event.type === 'snapshot') {
              since = event.cursor ?? undefined;
              if (event.redactionCursor) redactions = event.redactionCursor;
              queries.setQueryData(communityKeys.room(currentAuthority, ref, roomId), event.room);
              setState((current) => ({
                address,
                room: event.room,
                entries: applyRemoteCommunityRevisions(
                  mergeRemoteCommunityEntries(
                    ref,
                    roomId,
                    current.address === address ? current.entries : [],
                    event.entries
                  ).slice(-500),
                  current.address === address ? current.revisions : NO_REVISIONS
                ),
                revisions: current.address === address ? current.revisions : NO_REVISIONS,
                deliveries: current.deliveries.filter(
                  (delivery) =>
                    !event.entries.some(
                      (entry) => entry.originIdempotencyKey === delivery.idempotencyKey
                    )
                ),
                status: event.stale ? 'offline' : 'live',
              }));
            } else if (event.type === 'revision') {
              // A message this view may hold was deleted, removed or erased on the Community.
              // The fence above already dropped a frame from an older owner, connection or
              // route; the frame names this room (the transport checks it). The cached history
              // pages are patched too, so reopening the room never shows the old words first.
              const revised = event.entry;
              if (event.redactionCursor) redactions = event.redactionCursor;
              const history = [...communityKeys.room(currentAuthority, ref, roomId), 'entries'];
              // Remembered only for a message this view could show: one it holds, one in a
              // cached history page, one the caller holds (a confirmed post of its own), or
              // anything while a history page is still loading. A replay of the whole feed after
              // a restore would otherwise crowd the ones that matter out of the bounded memory.
              const inHistory = queries
                .getQueriesData<InfiniteData<RemoteCommunityHistoryResponse>>({
                  queryKey: history,
                })
                .some(([, data]) =>
                  data?.pages.some((page) => page.entries.some((item) => item.id === revised.id))
                );
              const relevant =
                inHistory ||
                queries.isFetching({ queryKey: history }) > 0 ||
                holdsRef.current?.(revised.id) === true;
              queries.setQueriesData<InfiniteData<RemoteCommunityHistoryResponse>>(
                { queryKey: history },
                (data) => {
                  if (!data) return data;
                  let changed = false;
                  const pages = data.pages.map((page) => {
                    const entries = page.entries.map((entry) =>
                      reviseRemoteCommunityEntry(entry, revised)
                    );
                    if (entries.some((entry, index) => entry !== page.entries[index])) {
                      changed = true;
                      return { ...page, entries };
                    }
                    return page;
                  });
                  return changed ? { ...data, pages } : data;
                }
              );
              setState((current) => {
                if (!relevant && !current.entries.some((item) => item.id === revised.id))
                  return current;
                const revisions = new Map(current.revisions);
                revisions.delete(revised.id);
                revisions.set(revised.id, revised);
                while (revisions.size > MAX_REVISIONS)
                  revisions.delete(revisions.keys().next().value!);
                return {
                  ...current,
                  entries: applyRemoteCommunityRevisions(current.entries, revisions),
                  revisions,
                };
              });
            } else if (event.type === 'deliveries') {
              setState((current) => ({
                ...current,
                deliveries: event.deliveries.filter(
                  (delivery) =>
                    !current.entries.some(
                      (entry) => entry.originIdempotencyKey === delivery.idempotencyKey
                    )
                ),
              }));
            } else {
              since = event.entry.cursor;
              setState((current) => ({
                ...current,
                entries: mergeRemoteCommunityEntries(ref, roomId, current.entries, [
                  event.entry,
                ]).slice(-500),
                deliveries: current.deliveries.filter(
                  (delivery) => delivery.idempotencyKey !== event.entry.originIdempotencyKey
                ),
                status: 'live',
              }));
            }
          },
          { since, redactions, signal: controller.signal }
        );
      } catch (error) {
        if (controller.signal.aborted || !isCommunityContentAuthorityCurrent(currentAuthority))
          return;
        const status =
          error && typeof error === 'object' && 'status' in error ? error.status : undefined;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        if (code === 'COMMUNITY_DELETED' || code === 'COMMUNITY_TAKEN_DOWN') {
          // The whole community is gone (DOR-2575): the room ends here rather than retrying, and
          // the connection list is read again so the page shows the gone panel now, not at the
          // next poll.
          removeAccess();
          void queries.invalidateQueries({ queryKey: communityKeys.connections(currentAuthority) });
        } else if (status === 401 || status === 403 || status === 404) removeAccess();
        else if (status === 410 && code === 'COMMUNITY_CURSOR_STALE') since = undefined;
      }
      if (
        controller.signal.aborted ||
        denied ||
        !isCommunityContentAuthorityCurrent(currentAuthority)
      )
        return;
      const cachedRoom = queries.getQueryData<RemoteCommunityRoom>(
        communityKeys.room(currentAuthority, ref, roomId)
      );
      if (cachedRoom)
        queries.setQueryData(communityKeys.room(currentAuthority, ref, roomId), {
          ...cachedRoom,
          stale: true,
          writable: false,
        });
      setState((current) => ({
        ...current,
        room: current.room ? { ...current.room, stale: true, writable: false } : null,
        status: 'offline',
      }));
      retry = setTimeout(
        () => {
          void connect();
        },
        Math.min(30_000, 1_000 * 2 ** Math.min(failures++, 5))
      );
    }

    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [address, ref, roomId, enabled, reconnectKey, queries, transport, authority, cacheReadable]);

  // A route change must never expose the previous community's history for even one render.
  if (state.address !== address || !authority)
    return {
      address,
      room: null,
      entries: [],
      revisions: NO_REVISIONS,
      deliveries: [],
      status: 'connecting' as const,
    };
  if (enabled) return state;
  if (cacheReadable)
    return {
      ...state,
      room: state.room ? { ...state.room, stale: true, writable: false } : null,
      deliveries: [],
      status: 'offline' as const,
    };
  return {
    address,
    room: null,
    entries: [],
    revisions: NO_REVISIONS,
    deliveries: [],
    status: 'removed' as const,
  };
}

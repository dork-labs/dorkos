/**
 * Read every thread this person takes part in, across every room
 * (spec `room-messaging-design` §3, cross-room surface 1).
 *
 * The one room query that is not scoped to a room. A thread is a relation
 * between entries inside one room's log (ADR 260728-022013), so everything else
 * about a thread is asked of the room it lives in — but the sidebar's question
 * is "where is this thread?", which cannot be asked of a room the reader has
 * not thought of yet.
 *
 * @module entities/room/model/use-threads
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ThreadSummary } from '@dorkos/shared/room-schemas';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';

/**
 * How long a thread list stays fresh. The same window the room list uses, and
 * for the same reason: both are refreshed by `room_activity` on the global
 * stream, so this is the ceiling on staleness when that stream is down rather
 * than the mechanism that keeps the list current.
 */
const THREADS_STALE_TIME_MS = 30_000;

/**
 * Fetch the reader's threads, most recent activity first.
 *
 * Ordering comes from the server and is used as given — unlike the room list,
 * which the client re-sorts because channels want their names and DMs want
 * their recency. A thread has one honest order and this is it.
 *
 * `unreadCount` shares the room's read cursor, so opening a room clears its
 * threads' counts as well as its own badge.
 */
export function useThreads(): UseQueryResult<ThreadSummary[]> {
  const transport = useTransport();
  return useQuery({
    queryKey: roomKeys.threads(),
    queryFn: () => transport.listThreads(),
    staleTime: THREADS_STALE_TIME_MS,
  });
}

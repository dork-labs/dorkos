import { useQuery } from '@tanstack/react-query';
import type { MemberRoomsResponse } from '@dorkos/shared/team-schemas';
import { useTransport } from '@/layers/shared/model';
import { memberRoomsKey } from '../api/query-keys';

/**
 * How long a member's rooms stay fresh.
 *
 * The roster's own 30 s, deliberately: the two are read side by side on a
 * profile — the roster draws the header, this draws the Rooms row — and two
 * staleness windows on one screen would make half of it update while the other
 * half did not.
 */
const MEMBER_ROOMS_STALE_MS = 30_000;

/** How a caller narrows when a member's rooms are worth reading at all. */
export interface UseMemberRoomsOptions {
  /**
   * Whether to read now. Defaults to `true`.
   *
   * A `null` `memberId` already disables the query, so this is for the second
   * gate a profile needs: the sheet is mounted on every route and holds the last
   * member it showed, so "we know who, but nothing is open" is a real state and
   * the one a caller passes `false` for.
   */
  enabled?: boolean;
}

/**
 * Read the rooms one roster member is in.
 *
 * The source for the profile's `Rooms` row (its count) and its Rooms page (the
 * list). Archived rooms are out and the newest activity comes first, both
 * decided by the server — a profile lists where somebody can be found, in the
 * order they were last found there.
 *
 * A member in no rooms is a successful read of an empty list, never an error.
 * Only an id the install has never heard of rejects, so `isError` genuinely
 * means "we could not place this member" rather than "they have not joined
 * anything".
 *
 * @param memberId - The member's roster id, or `null` when nobody is named yet.
 * @param options - See {@link UseMemberRoomsOptions}.
 */
export function useMemberRooms(memberId: string | null, options?: UseMemberRoomsOptions) {
  const transport = useTransport();

  return useQuery<MemberRoomsResponse>({
    // `memberId` is never actually read under the empty-string key: the query is
    // disabled without one, so nothing fetches and nothing is cached there.
    queryKey: memberRoomsKey(memberId ?? ''),
    queryFn: () => transport.listMemberRooms(memberId!),
    staleTime: MEMBER_ROOMS_STALE_MS,
    enabled: memberId !== null && (options?.enabled ?? true),
  });
}

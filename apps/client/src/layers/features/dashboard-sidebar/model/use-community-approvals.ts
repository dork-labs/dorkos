/**
 * Watch every Community connection that is waiting for the person's approval.
 *
 * @module features/dashboard-sidebar/model/use-community-approvals
 */
import { useEffect, useRef } from 'react';
import { useQueries, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CommunityConnectionDescriptor,
  CommunityConnectionPollResponse,
} from '@dorkos/shared/community-connections';
import type { ConfirmedCommunityAuthority } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { communityKeys, withinCommunityAuthority } from '@/layers/entities/community';

/** How a wait for approval ended. */
export type CommunityApprovalOutcome = Exclude<
  CommunityConnectionPollResponse['status'],
  'pending'
>;

/** One pending connection's approval check. */
export type CommunityApprovalCheck = Pick<
  UseQueryResult<CommunityConnectionPollResponse>,
  'error' | 'isFetching' | 'refetch'
>;

/**
 * Ask the local server, every two seconds, whether each pending connection has
 * been approved on its Community.
 *
 * **The asking is what finishes the pairing.** The server only claims the
 * Community's grant when this check reaches it, so a pending connection nobody
 * polls stays pending however long ago the person approved it. That is why
 * this runs for every pending connection whether or not the connect dialog is
 * open: approving on the Community and coming back to a closed dialog still
 * connects. Two switchers mounted at once share one query per connection.
 *
 * A check that fails stops until the person asks again (`refetch`), rather
 * than hammering a host that is not answering.
 *
 * @param connections - The owner's connections; only pending ones are checked.
 * @param authority - The confirmed owner, or `null` while it is loading (nothing is checked).
 * @param onOutcome - Runs once per ending, after the connection list is refreshed.
 * @returns Each pending connection's check, by ref.
 */
export function useCommunityApprovals(
  connections: readonly CommunityConnectionDescriptor[] | undefined,
  authority: ConfirmedCommunityAuthority | null,
  onOutcome: (connection: CommunityConnectionDescriptor, outcome: CommunityApprovalOutcome) => void
): ReadonlyMap<string, CommunityApprovalCheck> {
  const transport = useTransport();
  const client = useQueryClient();
  const pending = authority
    ? (connections ?? []).filter((connection) => connection.status === 'pending')
    : [];
  const checks = useQueries({
    queries: pending.map((connection) => ({
      queryKey: communityKeys.approval(authority!, connection.ref),
      queryFn: () =>
        withinCommunityAuthority(authority!, () =>
          transport.pollCommunityConnection(connection.ref)
        ),
      retry: false,
      refetchInterval: (query: {
        state: { error: unknown; data: CommunityConnectionPollResponse | undefined };
      }) =>
        !query.state.error && (!query.state.data || query.state.data.status === 'pending')
          ? 2_000
          : false,
    })),
  });

  // An ending is reported once, keyed by the answer that carried it: the list
  // refresh it triggers re-renders this hook before the connection leaves it.
  const reported = useRef(new Set<string>());
  const latestOutcome = useRef(onOutcome);
  useEffect(() => {
    latestOutcome.current = onOutcome;
  });
  const endings = pending.flatMap((connection, index) => {
    const check = checks[index];
    const status = check?.data?.status;
    return status && status !== 'pending'
      ? [{ connection, outcome: status, key: `${connection.ref}:${check.dataUpdatedAt}` }]
      : [];
  });
  const endingKey = endings.map((ending) => ending.key).join('|');
  useEffect(() => {
    if (!authority) return;
    for (const { connection, outcome, key } of endings) {
      if (reported.current.has(key)) continue;
      reported.current.add(key);
      latestOutcome.current(connection, outcome);
      void client.invalidateQueries({ queryKey: communityKeys.connections(authority) });
    }
    // `endingKey` stands for `endings`, which is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endingKey, authority, client]);

  return new Map(pending.map((connection, index) => [connection.ref, checks[index]!]));
}

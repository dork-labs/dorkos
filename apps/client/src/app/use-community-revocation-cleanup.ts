/**
 * Notice when a Community connection ends somewhere else, and clean up after it.
 *
 * A connection can end without this tab asking: the person left the Community
 * on its own site (which revokes this installation's access), an owner removed
 * them, the host revoked the grant, or another window disconnected it. The
 * local server reports each of those in the connection list it already polls,
 * as `reconnect-required` or as a row that is gone. Only a change from
 * `connected` counts, so an ordinary network failure — which the server
 * reports as unverified access, never as either of those — changes nothing
 * (spec: "The switcher never infers revocation from a generic network error").
 *
 * The cleanup order is the spec's: tombstone that one connection, close and
 * erase its state, and only then route away, and only if it was on screen.
 *
 * @module app/use-community-revocation-cleanup
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { getCommunityConnectionGeneration } from '@/layers/shared/lib';
import { communityRefFromRouteDestination, getCommunityRouteEpoch } from '@/layers/shared/model';
import {
  endCommunityConnection,
  useCommunityConnections,
  useConfirmedCommunityAuthority,
} from '@/layers/entities/community';

interface Seen {
  /** Owner and epoch the statuses belong to; a new owner starts over. */
  owner: string;
  /** Each connection's status, label and generation when last seen. */
  rows: Map<
    string,
    { status: CommunityConnectionDescriptor['status']; label: string; generation: number }
  >;
}

/** Watch this owner's connections and clean up any Community that stopped being connected. */
export function useCommunityRevocationCleanup(): void {
  const authority = useConfirmedCommunityAuthority();
  const connections = useCommunityConnections();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const seen = useRef<Seen | null>(null);

  useEffect(() => {
    if (!authority || !connections.data) return;
    const owner = JSON.stringify([authority.ownerKey, authority.epoch]);
    const previous = seen.current?.owner === owner ? seen.current.rows : null;
    const rows: Seen['rows'] = new Map(
      connections.data.map((row) => [
        row.ref,
        {
          status: row.status,
          label: row.label,
          generation: getCommunityConnectionGeneration(row.ref),
        },
      ])
    );
    seen.current = { owner, rows };
    if (!previous) return;
    for (const [ref, before] of previous) {
      if (before.status !== 'connected') continue;
      const now = rows.get(ref);
      if (now?.status === 'connected') continue;
      const selected =
        communityRefFromRouteDestination(getCommunityRouteEpoch().destination) === ref;
      // A disconnect from this tab has already tombstoned and erased it; only
      // the route is left to settle.
      const alreadyEnded = getCommunityConnectionGeneration(ref) > before.generation;
      const end = now === undefined ? 'removed' : 'revoked';
      void (
        alreadyEnded ? Promise.resolve() : endCommunityConnection(queryClient, authority, ref, end)
      ).then(() => {
        if (
          selected &&
          communityRefFromRouteDestination(getCommunityRouteEpoch().destination) === ref
        )
          void navigate({ to: '/', replace: true });
      });
      if (end === 'revoked')
        toast(`This DorkOS can no longer reach ${before.label}.`, {
          description: 'Reconnect from Connections if you are still a member.',
        });
    }
  }, [authority, connections.data, navigate, queryClient]);
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StandingPermission } from '@dorkos/shared/approval-schemas';
import { useEventSubscription, useNow, useTransport } from '@/layers/shared/model';
import { useStandingGrantPolicy } from './use-standing-grant-policy';

/** Query key for the live standing-permission list. */
export const STANDING_PERMISSIONS_QUERY_KEY = ['approvals', 'grants'] as const;

/** How often the list re-checks its own deadlines. */
const EXPIRY_TICK_MS = 30_000;

/** What {@link useStandingPermissions} hands its consumers. */
export interface StandingPermissionsState {
  /** Permissions that are live right now, soonest to expire first. */
  permissions: StandingPermission[];
  /** True only on the very first load, before any answer has arrived. */
  isLoading: boolean;
  /** True when the list could not be read. */
  isError: boolean;
}

/**
 * The standing permissions that are live right now, kept in step across windows.
 *
 * ## Why this is fetched even when nothing is granted
 *
 * A permission a person cannot find is a dark pattern, so both surfaces that can
 * show one have to know whether there is anything to show before they decide
 * whether to appear at all. The read is cheap, and the alternative — only looking
 * once somebody opens the panel — means the header stays silent about trust that
 * is live, which is the exact failure this feature is supposed to avoid.
 *
 * The list is skipped entirely when standing permissions are switched off, since
 * there is nothing to find and the server would refuse the read in the login-off
 * posture anyway.
 *
 * ## Two things move the list, and only one of them is an event
 *
 * `approval_grant_changed` covers every change somebody makes: opening one from a
 * card, ending one from either surface, and the sweep that ends all of them when
 * the master switch or Require login goes off. It carries no payload worth
 * merging — every window re-reads instead, so two cockpits cannot disagree.
 *
 * Expiry is the other one, and nothing announces it, exactly as nothing announces
 * a pending approval's expiry: no code runs at the moment a window closes. So the
 * rows are filtered against a clock that ticks here. A row whose deadline passed
 * is dropped locally within {@link EXPIRY_TICK_MS} rather than sitting there
 * looking like live trust, and the same rule the server applies means a later read
 * cannot disagree.
 */
export function useStandingPermissions(): StandingPermissionsState {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { canGrant } = useStandingGrantPolicy();
  const now = useNow(EXPIRY_TICK_MS);

  const { data, isLoading, isError } = useQuery({
    queryKey: STANDING_PERMISSIONS_QUERY_KEY,
    queryFn: () => transport.listStandingPermissions(),
    enabled: canGrant,
  });

  useEventSubscription('approval_grant_changed', () => {
    void queryClient.invalidateQueries({ queryKey: STANDING_PERMISSIONS_QUERY_KEY });
  });

  const grants = data?.grants;
  const live = grants
    ? grants.filter((grant) => {
        const expiresAt = Date.parse(grant.expiresAt);
        // An unparseable expiry is shown rather than hidden. Hiding a real
        // permission because of a formatting bug is the worse failure: the person
        // would have no way to end it.
        return Number.isNaN(expiresAt) || expiresAt > now;
      })
    : [];

  return {
    permissions: canGrant ? live : [],
    isLoading: canGrant && isLoading,
    isError: canGrant && isError,
  };
}

/**
 * End one standing permission, so DorkOS asks again next time.
 *
 * The server broadcasts `approval_grant_changed`, which re-reads the list in every
 * open window; the local invalidation is the belt-and-braces path for a cockpit
 * whose event stream is momentarily down.
 */
export function useRevokeStandingPermission() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => transport.revokeStandingPermission(grantId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: STANDING_PERMISSIONS_QUERY_KEY });
    },
  });
}

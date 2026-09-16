/**
 * The plan-aware reads, as TanStack Query hooks.
 *
 * Every one of them answers `{ available: false }` on an install with no cloud
 * account, so the surfaces above simply do not render and nothing has to branch
 * on "are we linked" twice. Nothing here computes a price, names a plan, or
 * reads a plan identifier: the only strings that reach a screen are the
 * service's own `displayName` fields.
 *
 * @module features/cloud-plan/model/use-cloud-plan
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type {
  CloudCreditsStatus,
  CloudMembersResponse,
  CloudNudgeResponse,
  CloudOrgsResponse,
  CloudPlanResponse,
  CloudSeatsResponse,
  CloudUsageResponse,
} from '@dorkos/shared/cloud-schemas';

/** TanStack Query keys for the plan-aware reads. */
export const cloudPlanKeys = {
  all: ['cloud', 'plan-aware'] as const,
  plan: () => [...cloudPlanKeys.all, 'plan'] as const,
  usage: (groupBy: string) => [...cloudPlanKeys.all, 'usage', groupBy] as const,
  nudge: () => [...cloudPlanKeys.all, 'nudge'] as const,
  orgs: () => [...cloudPlanKeys.all, 'orgs'] as const,
  members: (orgId: string) => [...cloudPlanKeys.all, 'members', orgId] as const,
  seats: (orgId: string) => [...cloudPlanKeys.all, 'seats', orgId] as const,
  credits: () => [...cloudPlanKeys.all, 'credits'] as const,
};

/** How long a plan read stays fresh. Plans do not move minute to minute. */
const STALE_MS = 60_000;

/** Read the entitlement and credit position behind the plan card. */
export function useCloudPlan() {
  const transport = useTransport();
  return useQuery<CloudPlanResponse>({
    queryKey: cloudPlanKeys.plan(),
    queryFn: () => transport.getCloudPlan(),
    staleTime: STALE_MS,
  });
}

/**
 * Read one grouped usage window.
 *
 * @param groupBy - How to group the rows; `seat` is the per-agent breakdown.
 */
export function useCloudUsage(groupBy: 'seat' | 'model' | 'day' = 'seat') {
  const transport = useTransport();
  return useQuery<CloudUsageResponse>({
    queryKey: cloudPlanKeys.usage(groupBy),
    queryFn: () => transport.getCloudUsage(groupBy),
    staleTime: STALE_MS,
  });
}

/** Read the already-reduced comparison, when the service offers one. */
export function useCloudNudge() {
  const transport = useTransport();
  return useQuery<CloudNudgeResponse>({
    queryKey: cloudPlanKeys.nudge(),
    queryFn: () => transport.getCloudNudge(),
    staleTime: STALE_MS,
  });
}

/** Read the organizations this account belongs to. */
export function useCloudOrgs() {
  const transport = useTransport();
  return useQuery<CloudOrgsResponse>({
    queryKey: cloudPlanKeys.orgs(),
    queryFn: () => transport.getCloudOrgs(),
    staleTime: STALE_MS,
  });
}

/**
 * Read one organization's seats.
 *
 * @param orgId - The organization's opaque identifier, or `null` while unknown.
 */
export function useCloudSeats(orgId: string | null) {
  const transport = useTransport();
  return useQuery<CloudSeatsResponse>({
    queryKey: cloudPlanKeys.seats(orgId ?? ''),
    queryFn: () => transport.getCloudSeats(orgId as string),
    enabled: orgId !== null,
    staleTime: STALE_MS,
  });
}

/**
 * Read one organization's members, so a seat can be assigned to a real person.
 *
 * @param orgId - The organization's opaque identifier, or `null` while unknown.
 */
export function useCloudMembers(orgId: string | null) {
  const transport = useTransport();
  return useQuery<CloudMembersResponse>({
    queryKey: cloudPlanKeys.members(orgId ?? ''),
    queryFn: () => transport.getCloudMembers(orgId as string),
    enabled: orgId !== null,
    staleTime: STALE_MS,
  });
}

/** Read whether DorkOS credits are armed as an inference source on this server. */
export function useCloudCredits() {
  const transport = useTransport();
  return useQuery<CloudCreditsStatus>({
    queryKey: cloudPlanKeys.credits(),
    queryFn: () => transport.getCloudCredits(),
    staleTime: STALE_MS,
  });
}

/**
 * Select DorkOS credits as this server's inference source.
 *
 * It asks the server to obtain a token; the token itself never reaches the
 * client. Inert unless the server's own flag is on, and the answer is the same
 * report either way rather than an error.
 */
export function useSelectCloudCredits() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => transport.selectCloudCredits(),
    onSuccess: (report) => {
      queryClient.setQueryData(cloudPlanKeys.credits(), report);
    },
  });
}

/**
 * Assign or release a seat, refreshing the seat list and the entitlement after.
 *
 * The mutation RESOLVES on a refusal rather than rejecting, because a refusal a
 * plan change would lift is an answer the surface renders — in the service's own
 * words — and not an error to swallow.
 *
 * @param orgId - The organization whose seat list to refresh.
 */
export function useSeatActions(orgId: string | null) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: cloudPlanKeys.seats(orgId ?? '') }),
      queryClient.invalidateQueries({ queryKey: cloudPlanKeys.plan() }),
    ]);
  };

  const assign = useMutation({
    mutationFn: (input: { seatId: string; subject: { kind: 'agent' | 'user'; id: string } }) =>
      transport.assignCloudSeat(input.seatId, input.subject),
    onSuccess: refresh,
  });

  const release = useMutation({
    mutationFn: (seatId: string) => transport.releaseCloudSeat(seatId),
    onSuccess: refresh,
  });

  return { assign, release };
}

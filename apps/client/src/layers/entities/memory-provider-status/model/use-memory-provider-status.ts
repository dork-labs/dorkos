import { useQuery } from '@tanstack/react-query';
import type { MemoryProviderStatus } from '@dorkos/shared/memory-provider';
import { useTransport } from '@/layers/shared/model';

/** Query key for the memory-provider status read. */
const MEMORY_PROVIDER_STATUS_KEY = ['memory-provider-status'] as const;

/**
 * How long the answer is trusted without asking again.
 *
 * A bench, once it happens, lasts the rest of the server's process — there is
 * no server-pushed signal for the moment it flips, unlike the unattended-
 * autonomy aggregate, which rides three SSE events for exactly that reason. A
 * bench firing mid-session is rare (it needs a live fault from an otherwise
 * healthy backend), so a plain re-ask on a normal cadence — this staleTime plus
 * TanStack's default refetch-on-window-focus — is proportionate; a dedicated
 * event for a state that only ever moves once per process would outweigh what
 * it buys.
 */
const STALE_TIME_MS = 60_000;

/**
 * Which memory backend is configured, which one is actually serving agent
 * calls right now, and why they differ.
 *
 * Returns `undefined` until the first answer lands, which the banner treats as
 * "nothing to report" — the same convention `useUnattendedAutonomy` uses, so a
 * page load never flashes a false warning before the real answer arrives.
 */
export function useMemoryProviderStatus(): MemoryProviderStatus | undefined {
  const transport = useTransport();

  const { data } = useQuery({
    queryKey: [...MEMORY_PROVIDER_STATUS_KEY],
    queryFn: () => transport.getMemoryProviderStatus(),
    staleTime: STALE_TIME_MS,
  });

  return data;
}

import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/** Query key for the capabilities endpoint — static for the server lifetime. */
const CAPABILITIES_KEY = ['capabilities'] as const;

/**
 * Fetch runtime capabilities for all registered runtimes.
 *
 * Capabilities are static for the lifetime of a server process, so
 * `staleTime: Infinity` prevents unnecessary refetches. Re-fetch by
 * calling `queryClient.invalidateQueries({ queryKey: ['capabilities'] })`.
 */
export function useRuntimeCapabilities() {
  const transport = useTransport();

  return useQuery({
    queryKey: [...CAPABILITIES_KEY],
    queryFn: () => transport.getCapabilities(),
    staleTime: Infinity,
  });
}

/**
 * Returns the server-default runtime's capability flags.
 *
 * Only use on surfaces with NO session context (onboarding, first-run setup).
 * Every capability-gated component attached to a live session should call
 * {@link useActiveCapabilities} instead so the UI reflects the actual
 * session's runtime rather than the server default.
 *
 * Returns `undefined` while the capabilities are still loading.
 */
export function useDefaultCapabilities(): RuntimeCapabilities | undefined {
  const { data } = useRuntimeCapabilities();
  if (!data) return undefined;
  return data.capabilities[data.defaultRuntime];
}

/**
 * Returns capabilities for the active session's runtime.
 *
 * Resolves the session's runtime type (via `transport.getSessionRuntimeType`)
 * and looks up its capability entry in the per-runtime capabilities map.
 * Use this in every capability-gated component with a session context — it
 * tracks the active session's actual runtime, not the server default.
 *
 * Returns `undefined` when `sessionId` is undefined, while data is loading,
 * or when the resolved runtime is not present in the capabilities map.
 *
 * @param sessionId - Target session UUID, or `undefined` to skip the query
 */
export function useActiveCapabilities(
  sessionId: string | undefined
): RuntimeCapabilities | undefined {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: [...CAPABILITIES_KEY, 'active', sessionId],
    queryFn: async () => {
      // `enabled: !!sessionId` gates invocation — the runtime assertion is a
      // type narrow for the downstream call.
      if (!sessionId) return null;
      const [runtimeType, map] = await Promise.all([
        transport.getSessionRuntimeType(sessionId),
        transport.getCapabilities(),
      ]);
      return map.capabilities[runtimeType] ?? null;
    },
    enabled: !!sessionId,
    staleTime: Infinity,
  });
  return data ?? undefined;
}

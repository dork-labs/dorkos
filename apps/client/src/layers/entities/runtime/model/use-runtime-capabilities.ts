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
 * Returns the capability flags for one runtime type, from the static
 * per-runtime capabilities map.
 *
 * Pass the resolved runtime for the surface's session — the session row's
 * server-authoritative `runtime` once started, the pending pre-launch
 * selection before that (see `useSessionRuntime` in `entities/session`).
 * A nullish `runtimeType` resolves to the server-default runtime, which is
 * the honest fallback for surfaces with no session context and for sessions
 * that have not bound to a runtime yet.
 *
 * Deliberately a pure map lookup, not a per-session fetch: the session
 * runtime-type endpoint infers-on-miss (it never 404s), so caching a
 * pre-launch fetch with `staleTime: Infinity` could pin the WRONG runtime's
 * capabilities for the session's lifetime once it binds to a non-default
 * runtime (spec additional-agent-runtimes, task 4.2 fold-in).
 *
 * Returns `undefined` while the capabilities map is loading or when the
 * runtime type is not registered with this server.
 *
 * @param runtimeType - Runtime type (e.g. `'codex'`), or nullish for the server default
 */
export function useCapabilitiesForRuntime(
  runtimeType: string | null | undefined
): RuntimeCapabilities | undefined {
  const { data } = useRuntimeCapabilities();
  if (!data) return undefined;
  return data.capabilities[runtimeType ?? data.defaultRuntime];
}

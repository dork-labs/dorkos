import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/** Query key for the capabilities endpoint — static for the server lifetime. */
const CAPABILITIES_KEY = ['capabilities'] as const;

/** Fetch gate shared by {@link useRuntimeCapabilities} and {@link useCapabilitiesForRuntime}. */
export interface UseRuntimeCapabilitiesOptions {
  /**
   * Whether this caller may fetch. Defaults to true. A caller that only reports
   * on capabilities somebody else asked for can pass false: the query still
   * subscribes to the cache and re-renders when the map lands, it just never
   * issues a request of its own. The standing permission banner uses it so that
   * appearing on `/team` does not fetch a map that page has no use for.
   */
  enabled?: boolean;
}

/**
 * Fetch runtime capabilities for all registered runtimes.
 *
 * Capabilities are static for the lifetime of a server process, so
 * `staleTime: Infinity` prevents unnecessary refetches. Re-fetch by
 * calling `queryClient.invalidateQueries({ queryKey: ['capabilities'] })`.
 *
 * @param options - Fetch gate; see {@link UseRuntimeCapabilitiesOptions}.
 */
export function useRuntimeCapabilities(options?: UseRuntimeCapabilitiesOptions) {
  const transport = useTransport();

  return useQuery({
    queryKey: [...CAPABILITIES_KEY],
    queryFn: () => transport.getCapabilities(),
    staleTime: Infinity,
    enabled: options?.enabled ?? true,
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
 * Returns `undefined` while the capabilities map is loading, when the caller has
 * gated itself off with `enabled: false` and nobody else has loaded the map, or
 * when the runtime type is not registered with this server.
 *
 * **"Not registered" is an own-property question.** A runtime type is a free
 * string that arrives from stored data — a task's `runtime`, an agent manifest —
 * so `constructor`, `toString` and `__proto__` all reach this lookup, and a plain
 * index answers each of them with something inherited from `Object.prototype`.
 * That answer is truthy and shaped like nothing, so callers took it for a profile
 * and read fields that are not there. Unregistered is unregistered, whatever the
 * string spells.
 *
 * @param runtimeType - Runtime type (e.g. `'codex'`), or nullish for the server default
 * @param options - Fetch gate; see {@link UseRuntimeCapabilitiesOptions}.
 */
export function useCapabilitiesForRuntime(
  runtimeType: string | null | undefined,
  options?: UseRuntimeCapabilitiesOptions
): RuntimeCapabilities | undefined {
  const { data } = useRuntimeCapabilities(options);
  if (!data) return undefined;
  const type = runtimeType ?? data.defaultRuntime;
  return Object.hasOwn(data.capabilities, type) ? data.capabilities[type] : undefined;
}

import { useQuery } from '@tanstack/react-query';
import {
  useCoalescedInvalidation,
  useEventSubscription,
  useTransport,
  type QueryInvalidation,
} from '@/layers/shared/model';

export const LOCAL_BROWSER_STATE_KEY = ['local-browser', 'state'] as const;
export const LOCAL_BROWSER_HANDOFF_KEY = ['local-browser', 'handoff'] as const;
export const localBrowserStateKey = (sessionId: string | null) =>
  [...LOCAL_BROWSER_STATE_KEY, { sessionId }] as const;

/** Observe the real connection, including tabs closed or navigated by the person. */
export function useLocalBrowserState(enabled = true, sessionId: string | null = null) {
  const transport = useTransport();
  return useQuery({
    queryKey: localBrowserStateKey(sessionId),
    enabled,
    queryFn: () => transport.getLocalBrowserState(sessionId),
    refetchInterval: (query) => {
      const code = (query.state.error as { code?: string } | null)?.code;
      return code === 'operator_only' || code === 'owner_only' ? false : 1000;
    },
    retry: false,
  });
}

const STATE_CACHE: readonly QueryInvalidation[] = [
  { queryKey: LOCAL_BROWSER_STATE_KEY },
  { queryKey: LOCAL_BROWSER_HANDOFF_KEY },
];

/**
 * The person's browser state for surfaces outside the browser panel: one read, then
 * another each time the server says a handoff or sign-in moved. It never polls, so
 * every open chat can hold it. A phone gets `local_only` and shows nothing.
 */
export function useLocalBrowserPersonState(sessionId?: string | null) {
  const transport = useTransport();
  const schedule = useCoalescedInvalidation({ coalesceMs: 100 });
  useEventSubscription('local_browser_changed', () => schedule(STATE_CACHE));
  return useQuery({
    queryKey: sessionId === undefined ? LOCAL_BROWSER_HANDOFF_KEY : localBrowserStateKey(sessionId),
    queryFn: () =>
      sessionId === undefined
        ? transport.getLocalBrowserHandoffState()
        : transport.getLocalBrowserState(sessionId),
    retry: false,
  });
}

/** Setup choices and live state for the browser control panel. */
export function useLocalBrowser(sessionId: string | null = null) {
  const transport = useTransport();
  const state = useLocalBrowserState(true, sessionId);
  const capabilities = useQuery({
    queryKey: ['local-browser', 'capabilities'],
    queryFn: () => transport.getLocalBrowserCapabilities(),
    retry: false,
  });
  return { state, capabilities };
}

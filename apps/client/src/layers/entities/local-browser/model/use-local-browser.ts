import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export const LOCAL_BROWSER_STATE_KEY = ['local-browser', 'state'] as const;

/** Observe the real connection, including tabs closed or navigated by the person. */
export function useLocalBrowserState(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: LOCAL_BROWSER_STATE_KEY,
    enabled,
    queryFn: () => transport.getLocalBrowserState(),
    refetchInterval: (query) => {
      const code = (query.state.error as { code?: string } | null)?.code;
      return code === 'local_only' || code === 'owner_only' ? false : 1000;
    },
    retry: false,
  });
}

/** Setup choices and live state for the browser control panel. */
export function useLocalBrowser() {
  const transport = useTransport();
  const state = useLocalBrowserState();
  const capabilities = useQuery({
    queryKey: ['local-browser', 'capabilities'],
    queryFn: () => transport.getLocalBrowserCapabilities(),
    retry: false,
  });
  return { state, capabilities };
}

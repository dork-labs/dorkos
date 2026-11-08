import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export const LOCAL_BROWSER_PROFILES_KEY = ['local-browser', 'profiles'] as const;

/** Profile names and assignments, read only after the host authorizes browser controls. */
export function useBrowserProfiles(enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: LOCAL_BROWSER_PROFILES_KEY,
    queryFn: () => transport.listLocalBrowserProfiles(),
    enabled,
    retry: false,
  });
}

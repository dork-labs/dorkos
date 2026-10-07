import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { browserKeys } from '../api/query-keys';
import type { BrowserCloseRequest } from './types';

/** A cache scope supplied by the signed-in identity; it grants no server authority. */
type CacheOwner = string | null;

/** Read profiles only while the current person's identity is known. */
export function useBrowserProfiles(owner: CacheOwner) {
  const transport = useTransport();
  return useQuery({
    queryKey: browserKeys.profiles(owner),
    queryFn: ({ signal }) => {
      if (!owner) throw new Error('Browser access isn’t ready yet.');
      return transport.getBrowserProfiles(signal);
    },
    enabled: Boolean(owner),
    retry: false,
  });
}

/** Read current instances without carrying metadata across people. */
export function useBrowserInstances(owner: CacheOwner) {
  const transport = useTransport();
  return useQuery({
    queryKey: browserKeys.instances(owner),
    queryFn: ({ signal }) => {
      if (!owner) throw new Error('Browser access isn’t ready yet.');
      return transport.getBrowserInstances(signal);
    },
    enabled: Boolean(owner),
    retry: false,
  });
}

/** Read one profile; missing identity or selection performs no request. */
export function useBrowserProfile(owner: CacheOwner, profileId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: [...browserKeys.all(owner), 'profile', profileId],
    queryFn: ({ signal }) => {
      if (!owner || !profileId) throw new Error('Select a browser profile first.');
      return transport.getBrowserProfile(profileId, signal);
    },
    enabled: Boolean(owner && profileId),
    retry: false,
  });
}

/** Read exactly the selected original generation, never its replacement. */
export function useBrowserInstance(
  owner: CacheOwner,
  browserId: string | null,
  browserGeneration: number | null
) {
  const transport = useTransport();
  return useQuery({
    queryKey: [...browserKeys.all(owner), 'instance', browserId, browserGeneration],
    queryFn: ({ signal }) => {
      if (!owner || !browserId || browserGeneration === null)
        throw new Error('Select a browser instance first.');
      return transport.getBrowserInstance(browserId, browserGeneration, signal);
    },
    enabled: Boolean(owner && browserId && browserGeneration !== null),
    retry: false,
  });
}

/** Close once and preserve the server's cleanup receipt, including uncertainty. */
export function useCloseBrowserInstance(owner: CacheOwner) {
  const transport = useTransport();
  const cache = useQueryClient();
  return useMutation({
    mutationKey: [...browserKeys.all(owner), 'close'],
    mutationFn: (request: BrowserCloseRequest) => {
      if (!owner) throw new Error('Browser access isn’t ready yet.');
      return transport.closeBrowserInstance(request);
    },
    retry: false,
    onMutate: () => ({ owner }),
    // A failed request may have reached the server. Refresh metadata without
    // treating cancellation or an unverified receipt as observed cleanup.
    onSettled: (_receipt, _error, request, context) => {
      const originalOwner = context?.owner;
      if (!originalOwner) return;
      return Promise.all([
        cache.invalidateQueries({ queryKey: browserKeys.instances(originalOwner) }),
        // The authoritative profile can become available after the original close settles.
        // A failed or uncertain close still requires a fresh server read, never a local unlock.
        cache.invalidateQueries({ queryKey: browserKeys.profiles(originalOwner) }),
        cache.invalidateQueries({
          queryKey: browserKeys.instance(
            originalOwner,
            request.browserId,
            request.browserGeneration
          ),
        }),
      ]);
    },
  });
}

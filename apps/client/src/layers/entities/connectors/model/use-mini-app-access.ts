import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MINI_APP_ACCESS_PAGE_PATH,
  type MiniAppAccessList,
} from '@dorkos/shared/mini-app-access-schemas';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * What each mini app waits for, and what each may read now (DOR-3547).
 *
 * @param options - `enabled` skips the read for a reader that is not the owner.
 */
export function useMiniAppAccess(options: { enabled?: boolean } = {}) {
  const transport = useTransport();
  return useQuery<MiniAppAccessList>({
    queryKey: connectorKeys.miniAppAccess(),
    queryFn: () => transport.getMiniAppAccess(),
    enabled: options.enabled ?? true,
  });
}

/** Take one mini app's yes back. Its next read of that account is refused. */
export function useRevokeMiniAppAccess() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (approvalId: string) => transport.revokeMiniAppAccess(approvalId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: connectorKeys.miniAppAccess() }),
  });
}

/**
 * The page where a person decides whether a mini app may read an app. It is
 * a full page outside the app, so leave by loading it, never by routing: the
 * app's own window, and any mini app code in it, stays behind.
 *
 * @param extensionId - The mini app.
 * @param service - The app it reads.
 */
export function miniAppAccessPageUrl(extensionId: string, service: string): string {
  const query = new URLSearchParams({ extension: extensionId, service });
  return `${resolveApiBaseUrl()}${MINI_APP_ACCESS_PAGE_PATH}?${query}`;
}

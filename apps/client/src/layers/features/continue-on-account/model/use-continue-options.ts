/**
 * Where a limited session can carry over to, as the server ranks it.
 *
 * @module features/continue-on-account/model/use-continue-options
 */
import { useQuery } from '@tanstack/react-query';
import { accountKeys, useTransport } from '@/layers/shared/model';

/**
 * Read `GET /api/sessions/:id/continue-options`: the limit's plan, the
 * accounts the work can go to in the server's order, and whether an advisor
 * answered. Fetched only while `enabled` (the picker is open), and read fresh
 * each time it opens, since usage moves between opens.
 *
 * @param sessionId - The limited session.
 * @param enabled - Whether to fetch now.
 */
export function useContinueOptions(sessionId: string, enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: accountKeys.continueOptions(sessionId),
    queryFn: () => transport.getContinueOptions(sessionId),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

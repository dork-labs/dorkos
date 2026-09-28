/**
 * A session's resolved usage-limit episodes, for the transcript marker.
 *
 * @module features/continue-on-account/model/use-limit-history
 */
import { useQuery } from '@tanstack/react-query';
import { accountKeys, useTransport } from '@/layers/shared/model';

/**
 * Read `GET /api/sessions/:id/limit-history`: how each of the session's recent
 * limit episodes ended, oldest first. Only a turn that stopped on a
 * `rate_limit` error asks, so a session that never ran out makes no request.
 * The banner refetches it when a limit clears (`useLimitBanner`).
 *
 * @param sessionId - The session.
 */
export function useLimitHistory(sessionId: string) {
  const transport = useTransport();
  return useQuery({
    queryKey: accountKeys.limitHistory(sessionId),
    queryFn: () => transport.getLimitHistory(sessionId),
    enabled: sessionId !== '',
    retry: false,
  });
}

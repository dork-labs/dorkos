import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SessionConnectorAttachResult,
  SessionConnectorStatus,
} from '@dorkos/shared/connector-provider';
import { useTransport } from '@/layers/shared/model';
import { connectorKeys } from '../api/query-keys';

/**
 * Fetch one session's connector surface: attached accounts with exposure
 * state, plus per-account null-branch warnings.
 *
 * @param sessionId - The session to report on, or `null` to hold the query.
 */
export function useSessionConnectors(sessionId: string | null) {
  const transport = useTransport();
  return useQuery<SessionConnectorStatus>({
    queryKey: connectorKeys.session(sessionId ?? ''),
    queryFn: () => transport.getSessionConnectors(sessionId ?? ''),
    enabled: sessionId !== null && sessionId !== '',
  });
}

/**
 * Attach a connected account to a session — the consent point. The result
 * re-shows the custody disclosure; the caller renders it. Invalidates the
 * session's connector surface so the attached row appears immediately.
 */
export function useAttachSessionConnector() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<SessionConnectorAttachResult, Error, { sessionId: string; accountId: string }>(
    {
      mutationFn: ({ sessionId, accountId }) =>
        transport.attachSessionConnector(sessionId, accountId),
      meta: { errorLabel: "Couldn't attach the account" },
      onSuccess: (_result, { sessionId }) => {
        void queryClient.invalidateQueries({ queryKey: connectorKeys.session(sessionId) });
      },
    }
  );
}

/**
 * Detach an account from a session. Idempotent server-side; invalidates the
 * session's connector surface.
 */
export function useDetachSessionConnector() {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<void, Error, { sessionId: string; accountId: string }>({
    mutationFn: ({ sessionId, accountId }) =>
      transport.detachSessionConnector(sessionId, accountId),
    meta: { errorLabel: "Couldn't detach the account" },
    onSuccess: (_result, { sessionId }) => {
      void queryClient.invalidateQueries({ queryKey: connectorKeys.session(sessionId) });
    },
  });
}

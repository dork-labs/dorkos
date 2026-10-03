/**
 * DorkOS credits as one entry in a runtime's Runs on list (ADR 261001-000811):
 * the status the server reports, and the person's choices about it.
 *
 * Lives in `shared/` because three features read or write it (Settings →
 * Runtimes, the DorkOS account panel, and the chat's refused-turn card), and a
 * feature may not import another feature's hooks. Every write refreshes the
 * config too: the Runs on list reads the credits entry off `GET /api/config`.
 *
 * @module shared/model/server-config/use-cloud-credits
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CloudCreditsNoticeDismissRequest,
  CloudCreditsStatus,
} from '@dorkos/shared/cloud-schemas';
import { MODELS_KEY } from '../../lib/models-query-key';
import { useTransport } from '../TransportContext';
import { accountKeys, configKeys } from './query-keys';

/** The one query key the credits status is read under. */
const cloudCreditsKeys = {
  status: () => ['cloud', 'plan-aware', 'credits'] as const,
};

/** How long a credits read stays fresh: choices move only when a person moves them. */
const STALE_MS = 30_000;

/** Read whether DorkOS credits can be chosen here, who chose them, and the notices owed. */
export function useCloudCredits() {
  const transport = useTransport();
  return useQuery<CloudCreditsStatus>({
    queryKey: cloudCreditsKeys.status(),
    queryFn: () => transport.getCloudCredits(),
    staleTime: STALE_MS,
  });
}

/**
 * Write the answer into the status cache, and refresh the config's Runs on
 * entry and the model menus: a session left on the default reads the models
 * credits cover only while credits are the default (DOR-2636).
 */
function useSettle() {
  const queryClient = useQueryClient();
  return (status: CloudCreditsStatus) => {
    queryClient.setQueryData(cloudCreditsKeys.status(), status);
    void queryClient.invalidateQueries({ queryKey: configKeys.all });
    void queryClient.invalidateQueries({ queryKey: MODELS_KEY });
  };
}

/** A person's choice for one runtime's default: credits, or its own sign-in. */
export function useSetCreditsDefault() {
  const transport = useTransport();
  const settle = useSettle();
  return useMutation({
    mutationFn: ({ runtime, useCredits }: { runtime: string; useCredits: boolean }) =>
      transport.setCloudCreditsDefault(runtime, useCredits),
    onSuccess: settle,
  });
}

/** Put back every runtime DorkOS set to credits on a new link ("Undo all"). */
export function useUndoFilledCredits() {
  const transport = useTransport();
  const settle = useSettle();
  return useMutation({
    mutationFn: () => transport.undoFilledCloudCredits(),
    onSuccess: settle,
  });
}

/** Settle one credits notice without changing any choice. */
export function useDismissCreditsNotice() {
  const transport = useTransport();
  const settle = useSettle();
  return useMutation({
    mutationFn: (request: CloudCreditsNoticeDismissRequest) =>
      transport.dismissCloudCreditsNotice(request),
    onSuccess: settle,
  });
}

/**
 * Keep DorkOS credits out of the project a session's folder is in: a project
 * rule, so the folder's own sign-in (or the next account allowed there) runs
 * its work from now on. Answers with what a new chat there runs on now.
 */
export function useKeepCreditsOutOfProject() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) => transport.keepCreditsOutOfProject(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accountKeys.all });
      void queryClient.invalidateQueries({ queryKey: configKeys.all });
    },
  });
}

/**
 * This computer's switch for chatting from the web (step B3, DOR-2946): where
 * the link stands (`GET /api/session-relay/status`) and the five changes only
 * the person at this computer may make. The owner's password, asked for to
 * link, resume or raise the level, goes straight into the request and is never
 * kept.
 *
 * Read only while the `sessionRelay.enabled` experiment is on and the server
 * is not a hub; otherwise the routes answer 404 and there is nothing to show.
 *
 * @module features/web-access/model/use-web-access
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  SessionRelayLevel,
  SessionRelayLinkBody,
  SessionRelayStatus,
} from '@dorkos/shared/session-relay-link';
import { useExperimentEnabledState, useIsHub, useLocalCaller } from '@/layers/entities/config';
import { useTransport } from '@/layers/shared/model';
import { WEB_ACCESS_STATUS_KEY as statusKey } from './query-keys';

/** The experiment's setting path (`UserConfigSchema` `sessionRelay.enabled`). */
export const SESSION_RELAY_EXPERIMENT = 'sessionRelay.enabled';

/** What the section reads and does. */
export interface WebAccess {
  /** Whether the section shows at all: the experiment is on, and this is not a hub. */
  available: boolean;
  /** Whether this browser is on the computer DorkOS runs on. */
  atThisComputer: boolean;
  /** Where the link stands; `undefined` until loaded. */
  status: SessionRelayStatus | undefined;
  /** The last change's failure, in a sentence; `null` when none. */
  error: string | null;
  /** Whether a change is on its way. */
  busy: boolean;
  /** Link to a hub with a pasted code and the owner's password. */
  link: (body: SessionRelayLinkBody) => void;
  /** Choose what the web may do here; raising it needs the owner's password. */
  setLevel: (level: SessionRelayLevel, password?: string) => void;
  /** Pause chatting from the web. */
  pause: () => void;
  /** Resume chatting from the web, with the owner's password. */
  resume: (password: string) => void;
  /** Forget the hub. */
  unlink: () => void;
}

/** The server's own sentence for a refusal, or a plain fallback. */
function sentenceOf(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message && !/^HTTP \d+$/.test(message) ? message : 'Couldn’t change that. Try again.';
}

/** Read and change this computer's link to its hub. */
export function useWebAccess(): WebAccess {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const { enabled } = useExperimentEnabledState(SESSION_RELAY_EXPERIMENT);
  const isHub = useIsHub();
  const atThisComputer = useLocalCaller();
  const available = enabled && !isHub;
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => transport.getSessionRelayStatus(),
    enabled: available,
    retry: false,
    staleTime: 10_000,
  });

  const change = useMutation({
    mutationFn: (run: () => Promise<SessionRelayStatus>) => run(),
    onMutate: () => setError(null),
    onSuccess: (next) => queryClient.setQueryData(statusKey, next),
    onError: (failure) => setError(sentenceOf(failure)),
  });

  return {
    available: available && status.isSuccess,
    atThisComputer,
    status: status.data,
    error,
    busy: change.isPending,
    link: (body) => change.mutate(() => transport.linkSessionRelay(body)),
    setLevel: (level, password) =>
      change.mutate(() => transport.setSessionRelayLevel(level, password)),
    pause: () => change.mutate(() => transport.pauseSessionRelay()),
    resume: (password) => change.mutate(() => transport.resumeSessionRelay(password)),
    unlink: () => change.mutate(() => transport.unlinkSessionRelay()),
  };
}

/**
 * Whether someone is using this computer from the web right now (step B3,
 * DOR-2946): read once from `GET /api/session-relay/presence`, then kept
 * current by the `session_relay_presence` event, which carries the whole
 * presence and is written straight into the cache. Also the browsers seen
 * here, and "End now", which closes the relay and pauses the link.
 *
 * Read only while the `sessionRelay.enabled` experiment is on and the server
 * is not a hub; otherwise the routes answer 404 and there is nothing to show.
 *
 * @module features/web-access/model/use-remote-presence
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SessionRelayPresenceSchema,
  type SessionRelayDevice,
  type SessionRelayPresence,
} from '@dorkos/shared/session-relay-link';
import { useExperimentEnabledState, useIsHub, useLocalCaller } from '@/layers/entities/config';
import { useEventSubscription, useTransport } from '@/layers/shared/model';
import { SESSION_RELAY_EXPERIMENT } from './use-web-access';
import {
  WEB_ACCESS_DEVICES_KEY,
  WEB_ACCESS_PRESENCE_KEY,
  WEB_ACCESS_STATUS_KEY,
} from './query-keys';

/**
 * How long an answer is trusted without asking again. Long, because the event
 * is the real freshness mechanism; this only backstops one lost while the
 * stream was down.
 */
const STALE_TIME_MS = 5 * 60_000;

/** What the indicator reads and does. */
export interface RemotePresence {
  /** Where it stands; `undefined` until loaded, or when there is nothing to show. */
  presence: SessionRelayPresence | undefined;
  /** Whether this browser is on the computer DorkOS runs on, where "End now" works. */
  atThisComputer: boolean;
  /** Close the relay and pause the link. */
  end: () => void;
  /** Whether "End now" is on its way. */
  ending: boolean;
  /** Its failure, in a sentence; `null` when none. */
  error: string | null;
}

/** Whether chat from the web can be on here: the experiment, and not a hub. */
function useAvailable(): boolean {
  const { enabled } = useExperimentEnabledState(SESSION_RELAY_EXPERIMENT);
  const isHub = useIsHub();
  return enabled && !isHub;
}

/** Read whether a remote session is active, and end it. */
export function useRemotePresence(): RemotePresence {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const available = useAvailable();
  const atThisComputer = useLocalCaller();
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: WEB_ACCESS_PRESENCE_KEY,
    queryFn: () => transport.getSessionRelayPresence(),
    enabled: available,
    retry: false,
    staleTime: STALE_TIME_MS,
  });

  useEventSubscription('session_relay_presence', (data) => {
    const parsed = SessionRelayPresenceSchema.safeParse(data);
    if (!parsed.success) return;
    queryClient.setQueryData(WEB_ACCESS_PRESENCE_KEY, parsed.data);
    void queryClient.invalidateQueries({ queryKey: WEB_ACCESS_DEVICES_KEY });
  });

  const end = useMutation({
    mutationFn: () => transport.endSessionRelayPresence(),
    onMutate: () => setError(null),
    onSuccess: (next) => {
      queryClient.setQueryData(WEB_ACCESS_PRESENCE_KEY, next);
      // The link is paused now.
      void queryClient.invalidateQueries({ queryKey: WEB_ACCESS_STATUS_KEY });
    },
    onError: () => setError('Couldn’t end it. Try again.'),
  });

  return {
    presence: available ? query.data : undefined,
    atThisComputer,
    end: () => end.mutate(),
    ending: end.isPending,
    error,
  };
}

/**
 * Every browser that has used chat from the web here, most recent first;
 * empty until loaded or when there is nothing to show.
 *
 * @param enabled - Whether to read them: only once the computer is linked.
 */
export function useSeenDevices(enabled: boolean): SessionRelayDevice[] {
  const transport = useTransport();
  const available = useAvailable();
  const { data } = useQuery({
    queryKey: WEB_ACCESS_DEVICES_KEY,
    queryFn: () => transport.listSessionRelayDevices(),
    enabled: available && enabled,
    retry: false,
    staleTime: STALE_TIME_MS,
  });
  return data?.devices ?? [];
}

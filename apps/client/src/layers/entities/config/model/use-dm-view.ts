/**
 * The two switches behind the DM view (DOR-3074): the experiment that draws a
 * chat with one agent like a direct message, and the person's own Show sessions
 * setting that keeps the working session behind it one click away.
 *
 * Both live in server config, so the choice follows the person to every client
 * on this machine and an agent can flip either when asked. `PATCH /api/config`
 * deep-merges plain objects, so a `{ ui: { showSessions } }` patch touches no
 * other `ui` key.
 *
 * @module entities/config/model/use-dm-view
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { CONFIG_WRITE_MUTATION_KEY, DM_VIEW_EXPERIMENT, useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';
import { useExperimentEnabledState } from './use-experiment-enabled';

/**
 * Whether a chat with one agent reads like a direct message (`ui.dmView`).
 *
 * `false` until the config arrives, so nothing about a chat changes until the
 * server has said the experiment is on: off is the shipped default, and the
 * common person never sees the view swap under them.
 */
export function useDmViewEnabled(): boolean {
  return useExperimentEnabledState(DM_VIEW_EXPERIMENT).enabled;
}

/**
 * Whether this person can open the working session behind a chat
 * (`ui.showSessions`). `false` until the config arrives, the shipped default.
 */
export function useShowSessions(): boolean {
  const { data } = useConfig();
  return data?.ui?.showSessions === true;
}

/** Public shape of {@link useUpdateShowSessions}. */
export interface UpdateShowSessions {
  /** Turn Show sessions on or off, and persist it. */
  setShowSessions: (on: boolean) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Persist the Show sessions setting with an optimistic cache update, so the
 * switch answers at once; rolls back on error and re-reads on settle.
 */
export function useUpdateShowSessions(): UpdateShowSessions {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<void, Error, boolean, { previous: ServerConfig | undefined }>({
    mutationKey: CONFIG_WRITE_MUTATION_KEY,
    mutationFn: (showSessions) => transport.updateConfig({ ui: { showSessions } }),
    onMutate: async (showSessions) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        old?.ui ? { ...old, ui: { ...old.ui, showSessions } } : old
      );
      return { previous };
    },
    onError: (_error, _on, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const setShowSessions = useCallback((on: boolean) => mutation.mutate(on), [mutation]);
  return { setShowSessions, isPending: mutation.isPending };
}

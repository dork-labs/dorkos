/**
 * The two switches behind the DM view (DOR-3074): the setting that draws a chat
 * with one agent like a direct message, and the Show sessions setting that keeps
 * the working session behind it one click away.
 *
 * Both live in server config, so they hold for everyone using this DorkOS, on
 * every client. Only a person changes either: both are operator-only to an
 * agent's config patch. `PATCH /api/config` deep-merges plain objects, so a
 * `{ ui: { showSessions } }` patch touches no other `ui` key.
 *
 * @module entities/config/model/use-dm-view
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { CONFIG_WRITE_MUTATION_KEY, useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/**
 * Whether a chat with one agent reads like a direct message (`ui.dmView`).
 *
 * `false` until the config arrives, so a door never opens a DM on a server that
 * has not said the view is on. The shipped default is on.
 */
export function useDmViewEnabled(): boolean {
  const { data } = useConfig();
  return data?.ui?.dmView === true;
}

/** Public shape of {@link useDmViewState}. */
export interface DmViewState {
  /** Whether a chat with one agent reads like a direct message. */
  enabled: boolean;
  /** Whether the server has said so. Until then a surface draws neither view. */
  settled: boolean;
}

/**
 * The DM view setting, and whether it is known yet.
 *
 * Off is not a safe guess: it draws the session's chrome, and the view is on for
 * nearly everyone, so a chat would jump from session to DM on every load. A boot
 * cache from before this setting existed has no answer either, until the read
 * it sets off lands. A read that failed settles as off, so a chat still draws.
 */
export function useDmViewState(): DmViewState {
  const { data, isPending, isFetching } = useConfig();
  const dmView = data?.ui?.dmView;
  return { enabled: dmView === true, settled: dmView !== undefined || !(isPending || isFetching) };
}

/**
 * Whether the working session behind a chat can be opened, for everyone using
 * this DorkOS (`ui.showSessions`). `false` until the config arrives, the shipped default.
 */
export function useShowSessions(): boolean {
  const { data } = useConfig();
  return data?.ui?.showSessions === true;
}

/**
 * Persist one `ui` switch with an optimistic cache update, so it answers at
 * once; rolls back on error and re-reads on settle.
 */
function useUiSwitchWrite(key: 'dmView' | 'showSessions') {
  const transport = useTransport();
  const queryClient = useQueryClient();

  return useMutation<void, Error, boolean, { previous: ServerConfig | undefined }>({
    mutationKey: CONFIG_WRITE_MUTATION_KEY,
    mutationFn: (on) => transport.updateConfig({ ui: { [key]: on } }),
    onMutate: async (on) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        old?.ui ? { ...old, ui: { ...old.ui, [key]: on } } : old
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
}

/** Public shape of {@link useUpdateDmView}. */
export interface UpdateDmView {
  /** Turn the DM view on or off, and persist it. */
  setDmView: (on: boolean) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/** Persist the DM view setting. */
export function useUpdateDmView(): UpdateDmView {
  const mutation = useUiSwitchWrite('dmView');
  const setDmView = useCallback((on: boolean) => mutation.mutate(on), [mutation]);
  return { setDmView, isPending: mutation.isPending };
}

/** Public shape of {@link useUpdateShowSessions}. */
export interface UpdateShowSessions {
  /** Turn Show sessions on or off, and persist it. */
  setShowSessions: (on: boolean) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/** Persist the Show sessions setting. */
export function useUpdateShowSessions(): UpdateShowSessions {
  const mutation = useUiSwitchWrite('showSessions');
  const setShowSessions = useCallback((on: boolean) => mutation.mutate(on), [mutation]);
  return { setShowSessions, isPending: mutation.isPending };
}

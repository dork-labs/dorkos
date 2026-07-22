/**
 * Status-bar visibility state (DOR-431): read + mutate `ui.statusBar` with
 * optimistic writes.
 *
 * Promoted from client `localStorage` into server config so the toggles sync
 * across devices and an agent can flip them via `config_patch` (spec
 * agents-as-operators). `PATCH /api/config` deep-merges plain objects, and the
 * `ui.statusBar` section holds no arrays, so a single-key patch composes
 * cleanly on the server — one item can be toggled without round-tripping the
 * whole section. Optimistic cache updates keep toggling instant.
 *
 * @module entities/config/model/use-status-bar-prefs
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { StatusBarPrefs } from '@dorkos/shared/config-schema';
import { STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/** A single toggleable status-bar item key (one of the `ui.statusBar` booleans). */
export type StatusBarPrefKey = keyof StatusBarPrefs;

/** Resolve the status-bar prefs from a (possibly-undefined) server config. */
function selectStatusBar(config: ServerConfig | undefined): StatusBarPrefs {
  return config?.ui?.statusBar ?? STATUS_BAR_PREFS_DEFAULTS;
}

/**
 * Read the current status-bar visibility prefs (`ui.statusBar`).
 *
 * Selects from the shared {@link useConfig} query. Schema defaults guarantee the
 * section is present once config loads; a stable all-visible default is returned
 * while it is still loading (so the status bar renders before the first read).
 */
export function useStatusBarPrefs(): StatusBarPrefs {
  const { data } = useConfig();
  return selectStatusBar(data);
}

/** Public shape of {@link useUpdateStatusBarPrefs}. */
export interface UpdateStatusBarPrefs {
  /** Toggle one status-bar item's visibility and persist it. */
  setVisibility: (key: StatusBarPrefKey, visible: boolean) => void;
  /** Restore every item to its default (all visible) in one write. */
  reset: () => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Persist status-bar visibility changes with an optimistic cache update.
 *
 * `setVisibility(key, visible)` writes the single key optimistically into the
 * config query, sends it as a partial `{ ui: { statusBar: { [key]: visible } } }`
 * PATCH (deep-merged server-side — no other key is touched), rolls back on
 * error, and re-validates by invalidating the config query on settle.
 * `reset()` sends the full defaults section the same way.
 */
export function useUpdateStatusBarPrefs(): UpdateStatusBarPrefs {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<
    void,
    Error,
    Partial<StatusBarPrefs>,
    { previous: ServerConfig | undefined }
  >({
    mutationFn: (patch) => transport.updateConfig({ ui: { statusBar: patch } }),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        // Merge the partial patch into `ui.statusBar`, preserving the rest of
        // `ui`. When `ui` is absent from the cache there is nothing to patch
        // optimistically (the settle-time invalidate refetches it), so leave it
        // undefined rather than fabricate a partial `ui`.
        old?.ui
          ? {
              ...old,
              ui: {
                ...old.ui,
                statusBar: { ...(old.ui.statusBar ?? STATUS_BAR_PREFS_DEFAULTS), ...patch },
              },
            }
          : old
      );
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const setVisibility = useCallback(
    (key: StatusBarPrefKey, visible: boolean) => mutation.mutate({ [key]: visible }),
    [mutation]
  );

  const reset = useCallback(() => mutation.mutate({ ...STATUS_BAR_PREFS_DEFAULTS }), [mutation]);

  return { setVisibility, reset, isPending: mutation.isPending };
}

/**
 * Status-line pins (`ui.statusBar.pins`, DOR-431 → DOR-452): read + mutate with
 * optimistic writes.
 *
 * Pins live in server config rather than client `localStorage` so the choice
 * syncs across every client and an agent can set it via `config_patch` (spec
 * agents-as-operators). `PATCH /api/config` deep-merges plain objects and
 * replaces arrays wholesale, so a `{ ui: { statusBar: { pins } } }` patch sets
 * the whole list without touching the rest of `ui` — which is the right
 * semantics for "keep these items in the line". Optimistic cache updates keep
 * pinning instant.
 *
 * @module entities/config/model/use-status-bar-prefs
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { StatusBarPin, StatusBarPrefs } from '@dorkos/shared/config-schema';
import { STATUS_BAR_PREFS_DEFAULTS } from '@dorkos/shared/config-schema';
import { useTransport } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/** Resolve the status-bar prefs from a (possibly-undefined) server config. */
function selectStatusBar(config: ServerConfig | undefined): StatusBarPrefs {
  return config?.ui?.statusBar ?? STATUS_BAR_PREFS_DEFAULTS;
}

/**
 * Read the current status-line pins (`ui.statusBar`).
 *
 * Selects from the shared {@link useConfig} query. Schema defaults guarantee the
 * section is present once config loads; a stable nothing-pinned default is
 * returned while it is still loading, so the line renders before the first read
 * rather than flashing pinned items in and out.
 */
export function useStatusBarPrefs(): StatusBarPrefs {
  const { data } = useConfig();
  return selectStatusBar(data);
}

/** Public shape of {@link useUpdateStatusBarPrefs}. */
export interface UpdateStatusBarPrefs {
  /** Replace the pin list and persist it. */
  setPins: (pins: readonly StatusBarPin[]) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Persist status-line pin changes with an optimistic cache update.
 *
 * `setPins(pins)` writes the list optimistically into the config query, sends it
 * as `{ ui: { statusBar: { pins } } }` (deep-merged server-side, so no other
 * `ui` key is touched), rolls back on error, and re-validates by invalidating
 * the config query on settle.
 */
export function useUpdateStatusBarPrefs(): UpdateStatusBarPrefs {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<
    void,
    Error,
    readonly StatusBarPin[],
    { previous: ServerConfig | undefined }
  >({
    mutationFn: (pins) => transport.updateConfig({ ui: { statusBar: { pins: [...pins] } } }),
    onMutate: async (pins) => {
      await queryClient.cancelQueries({ queryKey: configKeys.current() });
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      queryClient.setQueryData<ServerConfig>(configKeys.current(), (old) =>
        // Replace `ui.statusBar.pins`, preserving the rest of `ui`. When `ui` is
        // absent from the cache there is nothing to patch optimistically (the
        // settle-time invalidate refetches it), so leave it undefined rather
        // than fabricate a partial `ui`.
        old?.ui ? { ...old, ui: { ...old.ui, statusBar: { pins: [...pins] } } } : old
      );
      return { previous };
    },
    onError: (_error, _pins, context) => {
      if (context && context.previous !== undefined) {
        queryClient.setQueryData(configKeys.current(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const setPins = useCallback((pins: readonly StatusBarPin[]) => mutation.mutate(pins), [mutation]);

  return { setPins, isPending: mutation.isPending };
}

/**
 * Where each mini app's right-panel tab shows (`ui.panelTabs`, spec
 * `mini-app-placement`): read the saved choices and change one.
 *
 * Saved in server config, not the browser, so the choice is the same on every
 * device and an agent can read or set it with `config_patch`. `PATCH
 * /api/config` replaces lists whole, so a write sends the full list with one
 * entry changed; that is also the only way "Reset" (dropping an entry) can be
 * written. The cache updates first, so a tab hides or shows at once.
 *
 * @module entities/config/model/use-panel-tab-placements
 */
import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { MiniAppPlacement, SavedPlacement } from '@dorkos/shared/mini-app-placement';
import { useTransport, CONFIG_WRITE_MUTATION_KEY } from '@/layers/shared/model';
import { configKeys } from '../api/query-keys';
import { useConfig } from './use-config';

/** Stable empty list, so readers do not re-render on every config fetch. */
const NONE: readonly SavedPlacement[] = Object.freeze([]);

/**
 * The saved placement choices, one per tab that has one. Empty while config
 * loads and when nobody has chosen anything.
 */
export function usePanelTabPlacements(): readonly SavedPlacement[] {
  const { data } = useConfig();
  return data?.ui?.panelTabs ?? NONE;
}

/**
 * The list after setting one tab's choice: replaced in place when it had one,
 * appended when it did not, and removed when `placement` is null.
 *
 * @param list - The saved choices now.
 * @param tab - The tab, `<extensionId>:<tabId>`.
 * @param placement - Its new placement, or null to drop the saved choice.
 * @internal Exported for testing only.
 */
export function withPanelTabPlacement(
  list: readonly SavedPlacement[],
  tab: string,
  placement: MiniAppPlacement | null
): SavedPlacement[] {
  const rest = list.filter((entry) => entry.tab !== tab);
  if (!placement) return rest;
  const entry: SavedPlacement = { tab, show: placement.show, hide: placement.hide };
  const at = list.findIndex((existing) => existing.tab === tab);
  if (at === -1) return [...rest, entry];
  return [...rest.slice(0, at), entry, ...rest.slice(at)];
}

/** What {@link useSetPanelTabPlacement} returns. */
export interface SetPanelTabPlacement {
  /** Save one tab's placement, or drop its saved choice with `null`. */
  setPlacement: (tab: string, placement: MiniAppPlacement | null) => void;
  /** Whether a write is in flight. */
  isPending: boolean;
}

/**
 * Change one tab's saved placement, optimistically.
 *
 * Builds the new list from the cached config at the moment of the call and
 * writes it to the cache at once, so two quick changes in a row both land and
 * the panel redraws before anything else reads it. A change written meanwhile
 * by an agent is picked up on the refetch that follows every write.
 */
export function useSetPanelTabPlacement(): SetPanelTabPlacement {
  const transport = useTransport();
  const queryClient = useQueryClient();

  const mutation = useMutation<
    void,
    Error,
    { next: SavedPlacement[]; previous: ServerConfig | undefined },
    void
  >({
    mutationKey: CONFIG_WRITE_MUTATION_KEY,
    mutationFn: ({ next }) => transport.updateConfig({ ui: { panelTabs: next } }),
    onError: (_error, { previous }) => {
      if (previous !== undefined) queryClient.setQueryData(configKeys.current(), previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
    },
  });

  const { mutate } = mutation;
  const setPlacement = useCallback(
    (tab: string, placement: MiniAppPlacement | null) => {
      // The cache is written HERE, synchronously, not in `onMutate`: a caller
      // that selects the tab right after showing it ("Show here") must find it
      // visible on the very next render, or the panel's auto-select moves off
      // it before the cache catches up. An in-flight config read is cancelled
      // first so it cannot land on top of this write.
      const previous = queryClient.getQueryData<ServerConfig>(configKeys.current());
      // Before config has loaded there is no list to change one entry of, and
      // sending a one-entry list would replace everybody's saved choices.
      if (!previous?.ui) return;
      void queryClient.cancelQueries({ queryKey: configKeys.current() });
      const next = withPanelTabPlacement(previous.ui.panelTabs ?? NONE, tab, placement);
      queryClient.setQueryData<ServerConfig>(configKeys.current(), {
        ...previous,
        ui: { ...previous.ui, panelTabs: next },
      });
      mutate({ next, previous });
    },
    [mutate, queryClient]
  );

  return { setPlacement, isPending: mutation.isPending };
}

/**
 * The apps, live: the one read the Apps door, the Apps page and ⌘K share
 * (DOR-3970), and the pins that sit under the door.
 *
 * @module entities/extension/model/use-app-catalog
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MAX_PINNED_APPS } from '@dorkos/shared/config-schema';
import { useSidebarPrefs, useUpdateSidebarPrefs } from '@/layers/entities/config';
import { requestExtensionRemount, useExtensionLoadFailed } from '@/layers/shared/lib';
import { useExtensionRegistry, useMenuExtensionPages } from '@/layers/shared/model';
import {
  buildAppCatalog,
  firstPages,
  pinnedApps,
  type AppCatalog,
  type AppEntry,
} from '../lib/app-catalog';
import {
  forgetUninstalledApps,
  getKnownApps,
  rememberApps,
  subscribeKnownApps,
  updateKnownApps,
} from './known-apps';
import { useExtensionList } from './use-extension-list';
import {
  extensionQueryKeys,
  usePendingExtensionApprovals,
} from './use-pending-extension-approvals';

/** The toast a sixth pin is refused with (spec §2). */
export const PIN_CAP_TOAST = 'You can pin up to 5 apps. Unpin one first.';

/** Shared empty list. */
const NO_PINS: readonly string[] = [];

/** {@link useAppCatalog}'s answer: the catalog plus the pinned apps in pin order. */
export interface AppCatalogState extends AppCatalog {
  /** The pinned apps, in pin order, `off` ones left out. */
  pinned: readonly AppEntry[];
  /** The stored pin ids (absent from config reads as none). */
  pins: readonly string[];
}

/**
 * Every app, with its state, and the pinned ones.
 *
 * Reads the extension list, the approvals waiting on a person, the registry's
 * listed pages and their badges, and the loader's failure signal. Also keeps
 * {@link KnownApps} up to date as pages register.
 */
export function useAppCatalog(): AppCatalogState {
  const list = useExtensionList();
  const { approvals } = usePendingExtensionApprovals();
  const pages = useMenuExtensionPages();
  const badges = useExtensionRegistry((state) => state.pageBadges);
  const loadFailed = useExtensionLoadFailed();
  const pins = useSidebarPrefs().pinnedApps ?? NO_PINS;
  const known = useSyncExternalStore(subscribeKnownApps, getKnownApps, getKnownApps);

  useEffect(() => {
    const seen: Record<string, { name: string; path: string }> = {};
    for (const [id, page] of firstPages(pages)) seen[id] = { name: page.title, path: page.path };
    updateKnownApps((previous) => rememberApps(previous, seen));
  }, [pages]);

  useEffect(() => {
    if (list.data === undefined) return;
    const installed = new Set(list.data.map((ext) => ext.id));
    updateKnownApps((previous) => forgetUninstalledApps(previous, installed));
  }, [list.data]);

  const waitingIds = useMemo(() => new Set(approvals.map((approval) => approval.id)), [approvals]);

  return useMemo(() => {
    const catalog = buildAppCatalog({
      extensions: list.data,
      // A list that answered before still draws while a later poll fails: the
      // failure state is for "could not tell", never for a stale-but-real list.
      failed: loadFailed || (list.isError && list.data === undefined),
      waitingIds,
      pages,
      badges,
      known,
      pins,
    });
    return { ...catalog, pinned: pinnedApps(catalog.apps, pins), pins };
  }, [list.data, list.isError, loadFailed, waitingIds, pages, badges, known, pins]);
}

/** What {@link useAppPins} answers with. */
export interface AppPinActions {
  /** Pin an app at the end. Refused with a toast at the cap. */
  pin: (id: string) => void;
  /** Unpin an app. */
  unpin: (id: string) => void;
  /** Replace the stored pins whole, e.g. to seed them once. */
  setPins: (ids: readonly string[]) => void;
}

/** Pin, unpin and seed the apps under the Apps door. */
export function useAppPins(): AppPinActions {
  const { update } = useUpdateSidebarPrefs();
  const pin = useCallback(
    (id: string) => {
      update((prev) => {
        const current = prev.pinnedApps ?? [];
        if (current.includes(id)) return prev;
        if (current.length >= MAX_PINNED_APPS) {
          toast(PIN_CAP_TOAST);
          return prev;
        }
        return { ...prev, pinnedApps: [...current, id] };
      });
    },
    [update]
  );
  const unpin = useCallback(
    (id: string) => {
      update((prev) => ({
        ...prev,
        pinnedApps: (prev.pinnedApps ?? []).filter((pinned) => pinned !== id),
      }));
    },
    [update]
  );
  const setPins = useCallback(
    (ids: readonly string[]) => {
      update((prev) => ({ ...prev, pinnedApps: ids.slice(0, MAX_PINNED_APPS) }));
    },
    [update]
  );
  return { pin, unpin, setPins };
}

/**
 * Try loading the apps again: reload every extension and re-read the list.
 * Resolves once both are done, whatever they found.
 */
export function useRetryApps(): () => Promise<void> {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.allSettled([
      requestExtensionRemount(),
      queryClient.refetchQueries({ queryKey: extensionQueryKeys.list() }),
    ]);
  }, [queryClient]);
}

/** What {@link useAppCatalogSnapshot} holds before anything published. */
const NO_APPS: readonly AppEntry[] = [];

/**
 * The last app list the shell published, for readers that must not run the
 * extension queries themselves (the ⌘K palette: one list, read many times,
 * with no query of its own). The shell publishes it with
 * {@link usePublishAppCatalog}.
 */
const useAppSnapshotStore = create<{ apps: readonly AppEntry[] }>(() => ({ apps: NO_APPS }));

/** The apps, as the shell last published them. Empty until it has. */
export function useAppCatalogSnapshot(): readonly AppEntry[] {
  return useAppSnapshotStore((state) => state.apps);
}

/**
 * Publish this catalog's apps for {@link useAppCatalogSnapshot} readers.
 *
 * @param apps - The apps to publish.
 */
export function usePublishAppCatalog(apps: readonly AppEntry[]): void {
  useEffect(() => {
    useAppSnapshotStore.setState({ apps });
  }, [apps]);
}

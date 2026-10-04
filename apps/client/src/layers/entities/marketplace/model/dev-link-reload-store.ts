import { create } from 'zustand';
import type { DevLinkReloadedEvent } from '@dorkos/shared/marketplace-schemas';

/** Which dev link: its name, scope and project, as one map key. */
export function devLinkKey(link: {
  name: string;
  scope: 'global' | 'project';
  projectPath?: string;
}): string {
  return `${link.scope}\u0000${link.projectPath ?? ''}\u0000${link.name}`;
}

interface DevLinkReloadState {
  /** The last reload each dev link reported since the app opened, by {@link devLinkKey}. */
  latest: Record<string, DevLinkReloadedEvent>;
  /** Keep a reload the server just reported. */
  record: (event: DevLinkReloadedEvent) => void;
  /**
   * Forget what was kept for a dev link that was just made or removed, so a
   * build error from an earlier link never shows on the next one.
   */
  forget: (link: { name: string; scope: 'global' | 'project'; projectPath?: string }) => void;
}

/**
 * The last `marketplace_dev_link_reloaded` event per dev link (DOR-2696). The
 * listing only carries when a link last reloaded; whether that reload had a
 * build error lives only in the event, so it is kept here for the Installed
 * row to say "Couldn't reload" until the next edit reloads cleanly.
 */
export const useDevLinkReloadStore = create<DevLinkReloadState>((set) => ({
  latest: {},
  record: (event) => set((state) => ({ latest: { ...state.latest, [devLinkKey(event)]: event } })),
  forget: (link) =>
    set((state) => {
      const key = devLinkKey(link);
      if (!(key in state.latest)) return state;
      const { [key]: _forgotten, ...rest } = state.latest;
      return { latest: rest };
    }),
}));

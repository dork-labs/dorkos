/**
 * The permission set a person was shown when their yes was refused as stale
 * (DOR-2686), kept in this window so the redrawn card can lead with what
 * changed even on a first ask, where the server has no earlier approval to
 * compare against and sends `added: null`.
 *
 * Only this window saw that card, so only this window remembers it; a later
 * yes that lands forgets it.
 *
 * @module entities/extension/model/seen-before-stale-store
 */
import { create } from 'zustand';
import {
  permissionsAddedSince,
  type ExtensionPermissionAdditions,
  type ExtensionPermissionSet,
} from '../lib/permission-lines';

interface SeenBeforeStaleState {
  /** The set each extension's refused card showed, by extension id. */
  seen: Record<string, ExtensionPermissionSet>;
  /** Remember what a refused card showed. */
  remember: (id: string, set: ExtensionPermissionSet) => void;
  /** Forget it once a yes lands. */
  forget: (id: string) => void;
}

/** What refused cards showed in this window. */
export const useSeenBeforeStaleStore = create<SeenBeforeStaleState>((set) => ({
  seen: {},
  remember: (id, shown) => set((state) => ({ seen: { ...state.seen, [id]: shown } })),
  forget: (id) =>
    set((state) => {
      if (!(id in state.seen)) return state;
      const { [id]: _gone, ...rest } = state.seen;
      return { seen: rest };
    }),
}));

/**
 * What an extension asks for now that the card a person saw before a stale
 * refusal did not list, or `null` when nothing (or nothing was refused).
 *
 * @param id - The extension id.
 * @param now - What it declares now, or `undefined` when unknown.
 */
export function useAddedSinceSeen(
  id: string,
  now: ExtensionPermissionSet | undefined
): ExtensionPermissionAdditions | null {
  const seen = useSeenBeforeStaleStore((state) => state.seen[id]);
  if (!seen || !now) return null;
  return permissionsAddedSince(seen, now);
}

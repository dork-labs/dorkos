/**
 * The extensions whose last Allow ended on "Confirm it's you" closed without
 * confirming (DOR-4909), kept in this window so the card can say nothing was
 * allowed and how to try again. Before this, the card stayed exactly as it
 * was, and "Not now" looked like the way out.
 *
 * Only this window saw the sheet close, so only this window remembers it. It
 * is kept per version: a newer copy asks afresh. The next answer to the same
 * extension, either one, and any yes that lands, forget it.
 *
 * @module entities/extension/model/allow-not-confirmed-store
 */
import { create } from 'zustand';

interface AllowNotConfirmedState {
  /** The version whose last Allow was not confirmed, by extension id. */
  versions: Record<string, string>;
  /** Remember that an Allow for this version was not confirmed. */
  remember: (id: string, version: string) => void;
  /** Forget it once the person answers again, or a yes lands. */
  forget: (id: string) => void;
}

/** Which Allows this window saw end unconfirmed. */
export const useAllowNotConfirmedStore = create<AllowNotConfirmedState>((set) => ({
  versions: {},
  remember: (id, version) =>
    set((state) =>
      state.versions[id] === version ? state : { versions: { ...state.versions, [id]: version } }
    ),
  forget: (id) =>
    set((state) => {
      if (!(id in state.versions)) return state;
      const { [id]: _gone, ...rest } = state.versions;
      return { versions: rest };
    }),
}));

/**
 * Whether this extension's last Allow, for this very version, ended on
 * "Confirm it's you" closed without confirming, so nothing was allowed.
 *
 * @param id - The extension id, or `undefined` when the row has none.
 * @param version - The version the row shows.
 */
export function useAllowNotConfirmed(id: string | undefined, version: string | undefined): boolean {
  return useAllowNotConfirmedStore((state) =>
    id === undefined || version === undefined ? false : state.versions[id] === version
  );
}

/** The version whose last Allow was not confirmed, by extension id, for a list of rows. */
export function useAllowsNotConfirmed(): Readonly<Record<string, string>> {
  return useAllowNotConfirmedStore((state) => state.versions);
}

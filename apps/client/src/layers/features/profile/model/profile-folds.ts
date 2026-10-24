/**
 * Which of an agent profile's folds (Work, Setup, Files) are open — remembered
 * per VIEWER, not per agent, so a person who keeps Setup open finds it open on
 * every agent they look at.
 *
 * Kept in `localStorage["dorkos.profile.groups.<viewerAuthorId>"]` as
 * `{ work, setup, files }`. A read that fails (private mode, a full quota, a
 * value someone hand-edited) is every fold closed, which is the default.
 *
 * @module features/profile/model/profile-folds
 */
import { create } from 'zustand';
import type { ProfileFoldId } from '../lib/profile-rows';

/** Open or closed, for each fold. */
export type ProfileFoldState = Record<ProfileFoldId, boolean>;

/** Every fold closed: the first visit, and the answer to any unreadable value. */
const ALL_CLOSED: ProfileFoldState = { work: false, setup: false, files: false };

/** Where one viewer's folds are kept. */
export function profileFoldsKey(viewerId: string): string {
  return `dorkos.profile.groups.${viewerId}`;
}

/** Read one viewer's folds, falling back to all closed. */
function readFolds(viewerId: string): ProfileFoldState {
  try {
    const raw = JSON.parse(localStorage.getItem(profileFoldsKey(viewerId)) ?? 'null') as unknown;
    if (typeof raw !== 'object' || raw === null) return ALL_CLOSED;
    const stored = raw as Partial<Record<ProfileFoldId, unknown>>;
    return {
      work: stored.work === true,
      setup: stored.setup === true,
      files: stored.files === true,
    };
  } catch {
    return ALL_CLOSED;
  }
}

/** Save one viewer's folds. A failed write keeps the in-memory answer for this visit. */
function writeFolds(viewerId: string, folds: ProfileFoldState): void {
  try {
    localStorage.setItem(profileFoldsKey(viewerId), JSON.stringify(folds));
  } catch {
    /* Remembered for this visit only. */
  }
}

interface ProfileFoldStore {
  /** Each viewer's folds, read from storage the first time that viewer is asked about. */
  byViewer: Record<string, ProfileFoldState>;
  /** Open or close one fold for one viewer, and remember it. */
  setFold: (viewerId: string, fold: ProfileFoldId, open: boolean) => void;
}

/** The folds, shared by the rows that draw them and the links that open them. */
export const useProfileFoldStore = create<ProfileFoldStore>()((set, get) => ({
  byViewer: {},
  setFold: (viewerId, fold, open) => {
    const current = get().byViewer[viewerId] ?? readFolds(viewerId);
    if (current[fold] === open && get().byViewer[viewerId]) return;
    const next = { ...current, [fold]: open };
    writeFolds(viewerId, next);
    set((state) => ({ byViewer: { ...state.byViewer, [viewerId]: next } }));
  },
}));

/**
 * One viewer's folds.
 *
 * @param viewerId - The person looking, by roster id.
 */
export function useProfileFolds(viewerId: string): ProfileFoldState {
  const stored = useProfileFoldStore((s) => s.byViewer[viewerId]);
  return stored ?? readFolds(viewerId);
}

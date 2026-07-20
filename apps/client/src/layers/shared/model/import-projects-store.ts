import { create } from 'zustand';

/**
 * Global open/close state for the "bring in existing projects" dialog.
 *
 * Import is its own flow — it leaves the agent-creation dialog (ADR: agent
 * creation, reborn, contract item 8) and gains a completion state. This store
 * lives in `shared/model` so any feature (the gallery's import lead-out, the
 * naming step's "Import instead?", the sidebar's Add menu, the command palette,
 * the agents empty-state) can open the single import surface without a
 * feature-to-feature model import.
 */
interface ImportProjectsState {
  isOpen: boolean;
  /** Open the import dialog. */
  open: () => void;
  /** Close the import dialog. */
  close: () => void;
}

/** Global dialog state for {@link ImportProjectsDialog}. */
export const useImportProjectsStore = create<ImportProjectsState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));

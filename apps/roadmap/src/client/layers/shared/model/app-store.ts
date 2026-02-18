import { create } from 'zustand';
import { persist, devtools } from 'zustand/middleware';

/** Available view modes for the roadmap. */
export type ViewMode = 'table' | 'kanban' | 'moscow' | 'gantt';

/** Theme preference for the roadmap UI. */
export type Theme = 'light' | 'dark' | 'system';

interface AppState {
  /** Current active view mode. */
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  /** ID of the roadmap item currently being edited, or null if none. */
  editingItemId: string | null;
  setEditingItemId: (id: string | null) => void;

  /** Path to the spec file currently being viewed in the detail panel, or null if none. */
  viewingSpecPath: string | null;
  setViewingSpecPath: (path: string | null) => void;

  /** UI theme preference. */
  theme: Theme;
  setTheme: (theme: Theme) => void;
}

/**
 * Global UI store for the roadmap app.
 *
 * Persists viewMode and theme to localStorage via zustand/persist.
 */
export const useAppStore = create<AppState>()(
  devtools(
    persist(
      (set) => ({
        viewMode: 'table',
        setViewMode: (mode) => set({ viewMode: mode }),

        editingItemId: null,
        setEditingItemId: (id) => set({ editingItemId: id }),

        viewingSpecPath: null,
        setViewingSpecPath: (path) => set({ viewingSpecPath: path }),

        theme: 'system',
        setTheme: (theme) => set({ theme }),
      }),
      {
        name: 'roadmap-app-store',
        // Only persist view preferences, not transient UI state
        partialize: (state) => ({
          viewMode: state.viewMode,
          theme: state.theme,
        }),
      }
    ),
    { name: 'roadmap-app-store' }
  )
);

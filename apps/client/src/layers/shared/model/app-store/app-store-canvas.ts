/**
 * Canvas slice — per-session canvas state for the app store.
 *
 * Canvas open/content state is persisted per-session via localStorage using the
 * canvas session helpers in app-store-helpers.ts.
 *
 * @module shared/model/app-store-canvas
 */
import type { StateCreator } from 'zustand';
import type { UiCanvasContent } from '@dorkos/shared/types';
import { readCanvasSession, writeCanvasSession } from './app-store-helpers';
import type { AppState } from './app-store-types';

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface CanvasSlice {
  canvasOpen: boolean;
  setCanvasOpen: (open: boolean) => void;
  canvasContent: UiCanvasContent | null;
  setCanvasContent: (content: UiCanvasContent | null) => void;
  /**
   * Transient edit-mode flag for the markdown canvas. NOT persisted (live UI
   * state for the active canvas only). While true, the agent write path skips
   * canvas content updates (see the ui-action-dispatcher "protect the edit"
   * guard) so the in-canvas editor is the sole writer of that content.
   */
  canvasEditing: boolean;
  setCanvasEditing: (editing: boolean) => void;
  canvasPreferredWidth: number | null;
  setCanvasPreferredWidth: (width: number | null) => void;
  /** Active session ID for canvas persistence; null until `loadCanvasForSession` is called. */
  canvasSessionId: string | null;
  /** Load canvas state for a session (or reset to defaults if no prior state exists). */
  loadCanvasForSession: (sessionId: string) => void;
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the canvas slice (persisted per-session canvas UI state). */
export const createCanvasSlice: StateCreator<
  AppState,
  [['zustand/devtools', never]],
  [],
  CanvasSlice
> = (set) => ({
  canvasOpen: false,
  setCanvasOpen: (open) =>
    set((s) => {
      if (s.canvasSessionId) {
        writeCanvasSession(s.canvasSessionId, {
          open,
          content: s.canvasContent,
          accessedAt: Date.now(),
        });
      }
      return { canvasOpen: open };
    }),

  canvasContent: null,
  setCanvasContent: (content) =>
    set((s) => {
      if (s.canvasSessionId) {
        writeCanvasSession(s.canvasSessionId, {
          open: s.canvasOpen,
          content,
          accessedAt: Date.now(),
        });
      }
      return { canvasContent: content };
    }),

  // Transient (never written through writeCanvasSession): the markdown editor
  // sets this while the user edits, gating the agent write path.
  canvasEditing: false,
  setCanvasEditing: (editing) => set({ canvasEditing: editing }),

  canvasPreferredWidth: null,
  setCanvasPreferredWidth: (width) => set({ canvasPreferredWidth: width }),

  canvasSessionId: null,
  loadCanvasForSession: (sessionId) => {
    const entry = readCanvasSession(sessionId);
    // Always clear the transient edit flag on a session swap so a new session
    // never inherits the previous one's edit mode.
    if (entry) {
      set({
        canvasOpen: entry.open,
        canvasContent: entry.content,
        canvasSessionId: sessionId,
        canvasEditing: false,
      });
    } else {
      set({
        canvasOpen: false,
        canvasContent: null,
        canvasSessionId: sessionId,
        canvasEditing: false,
      });
    }
  },
});

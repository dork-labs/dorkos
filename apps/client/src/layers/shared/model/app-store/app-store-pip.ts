/**
 * PIP slice — floating picture-in-picture panel state for the app store.
 *
 * The panel shows one thing at a time: `pipContent` is a serializable
 * descriptor of what to render (never a React node, ideation D4), and
 * `openPip` unconditionally replaces it (single-instance replace-on-open,
 * decision D3 — no stacking, no dedup, unlike canvas's per-source-key dedup in
 * `app-store-canvas.ts`). `pipGeometry` is the panel's persisted position and
 * size; it hydrates from localStorage unclamped and survives close/reopen —
 * clamping a stale, off-screen geometry back into the viewport is the
 * floating-panel primitive's job on mount (task 1.1), not this slice's.
 *
 * @module shared/model/app-store-pip
 */
import type { StateCreator } from 'zustand';
import type { FloatingPanelGeometry } from '@/layers/shared/ui';
import { readPipGeometry, writePipGeometry } from './app-store-helpers';
import type { AppState } from './app-store-types';

// ---------------------------------------------------------------------------
// Content model
// ---------------------------------------------------------------------------

/**
 * Serializable descriptor for what the PIP panel currently shows — never a
 * React node (ideation D4), so it can be persisted, inspected, and
 * round-tripped like any other store value. The `demo` kind drives the Dev
 * Playground showcase (task 3.1) and tests; `mcp_app` (DOR-297) pops an
 * interactive MCP App into the floating panel.
 *
 * The `mcp_app` descriptor carries everything `McpAppFrame` needs to re-mount
 * itself in the panel — `sessionId` scopes the server-side fetch, and `title`
 * is always resolved (call sites fall back to the uri/server name), so the
 * panel header never renders empty.
 *
 * DOR-298 will add `{ kind: 'widget'; sessionId; ... }`.
 */
export type PipContent =
  | { kind: 'demo'; title: string }
  | { kind: 'mcp_app'; sessionId: string; serverName: string; uri: string; title: string };

// ---------------------------------------------------------------------------
// Slice interface
// ---------------------------------------------------------------------------

export interface PipSlice {
  /** What the floating panel currently shows, or null when it is closed. */
  pipContent: PipContent | null;
  /**
   * The panel's persisted position and size, or null to dock at the default
   * bottom-right position (the host computes that default — see task 2.1's
   * `PipHost`).
   */
  pipGeometry: FloatingPanelGeometry | null;
  /** Open the panel with `content`, replacing whatever is already showing (D3). */
  openPip: (content: PipContent) => void;
  /** Close the panel. Leaves {@link pipGeometry} untouched so position survives close/reopen. */
  closePip: () => void;
  /**
   * Update and persist the panel's geometry. The floating-panel primitive
   * (task 1.1) calls this exactly once per drag/resize gesture, at pointerup —
   * never per-frame — since every call here writes to localStorage.
   */
  setPipGeometry: (g: FloatingPanelGeometry) => void;
}

// ---------------------------------------------------------------------------
// Slice creator
// ---------------------------------------------------------------------------

/** Creates the PIP slice (transient content, persisted geometry). */
export const createPipSlice: StateCreator<AppState, [['zustand/devtools', never]], [], PipSlice> = (
  set
) => ({
  pipContent: null,
  pipGeometry: readPipGeometry(),

  openPip: (content) => set({ pipContent: content }),
  closePip: () => set({ pipContent: null }),
  setPipGeometry: (g) => {
    writePipGeometry(g);
    set({ pipGeometry: g });
  },
});

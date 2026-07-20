import type { ComponentType } from 'react';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import type { ExtensionEventsAPI } from './extension-events.js';

/** Slot identifiers matching the Phase 2 registry. */
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'sidebar.tabs'
  | 'dashboard.sections'
  | 'header.actions'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'right-panel';

/** Read-only projection of host state. */
export interface ExtensionReadableState {
  currentCwd: string | null;
  activeSessionId: string | null;
  agentId: string | null;
}

/** The contract extensions receive on activation. */
export interface ExtensionAPI {
  /** This extension's ID from the manifest. */
  readonly id: string;

  // --- UI Contributions (wraps Phase 2 registry) ---

  /**
   * Register a React component in a UI slot.
   * Returns an unsubscribe function (auto-called on deactivate).
   *
   * @param slot - The UI slot to contribute to.
   * @param id - Slot-local id; the host namespaces it as `${extId}:${id}`.
   * @param component - The React component to render.
   * @param options - `priority` orders the contribution (lower = earlier).
   *   `label` is the human name shown where the slot has a label or tab (e.g.
   *   the sidebar tab strip); it defaults to the namespaced id when omitted, so
   *   set it for any tabbed or labelled slot. `icon` is the tab-strip icon for
   *   slots that render one (currently `right-panel`); it is any component the
   *   host renders with a `className` for sizing — a `lucide-react` icon
   *   satisfies this. Omit it and the host falls back to a default puzzle-piece.
   */
  registerComponent(
    slot: ExtensionPointId,
    id: string,
    component: ComponentType,
    options?: { priority?: number; label?: string; icon?: ComponentType<{ className?: string }> }
  ): () => void;

  /**
   * Register a command palette item.
   * Returns an unsubscribe function.
   */
  registerCommand(
    id: string,
    label: string,
    callback: () => void,
    options?: { icon?: string; shortcut?: string }
  ): () => void;

  /**
   * Register a dialog component.
   * Returns an object with open/close controls.
   */
  registerDialog(id: string, component: ComponentType): { open: () => void; close: () => void };

  /**
   * Register a tab in the settings dialog.
   * Returns an unsubscribe function.
   */
  registerSettingsTab(id: string, label: string, component: ComponentType): () => void;

  // --- UI Control (wraps Phase 1 dispatcher) ---

  /** Execute a UI command (open panel, show toast, etc.). */
  executeCommand(command: UiCommand): void;

  /** Open the canvas with the given content. */
  openCanvas(content: UiCanvasContent): void;

  /** Navigate to a client-side route. */
  navigate(path: string): void;

  // --- State ---

  /** Get a read-only snapshot of host state. */
  getState(): ExtensionReadableState;

  /**
   * Subscribe to state changes. The selector picks a value; the callback
   * fires when that value changes. Returns an unsubscribe function.
   */
  subscribe(
    selector: (state: ExtensionReadableState) => unknown,
    callback: (value: unknown) => void
  ): () => void;

  // --- Events (curated, privacy-safe push channel) ---

  /**
   * Subscribe to curated host events (session/turn/tool lifecycle, relay
   * notifications). This is NOT the raw session stream — every event is a
   * privacy-safe summary that carries no conversation content (see
   * {@link ExtensionEventsAPI} and the `extension-events` module). Access is
   * gated by the manifest's `capabilities.events` declaration.
   */
  readonly events: ExtensionEventsAPI;

  // --- Storage (scoped to this extension) ---

  /** Load persistent data for this extension. Returns null if no data saved. */
  loadData<T>(): Promise<T | null>;

  /** Save persistent data for this extension. */
  saveData<T>(data: T): Promise<void>;

  // --- Notifications ---

  /** Show a toast notification. */
  notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void;

  // --- Context ---

  /** Check if a UI slot is rendered in the current host context. */
  isSlotAvailable(slot: ExtensionPointId): boolean;
}

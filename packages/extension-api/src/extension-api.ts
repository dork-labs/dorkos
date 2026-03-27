import type { ComponentType } from 'react';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';

/** Slot identifiers matching the Phase 2 registry. */
export type ExtensionPointId =
  | 'sidebar.footer'
  | 'sidebar.tabs'
  | 'dashboard.sections'
  | 'header.actions'
  | 'command-palette.items'
  | 'dialog'
  | 'settings.tabs'
  | 'session.canvas';

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
   */
  registerComponent(
    slot: ExtensionPointId,
    id: string,
    component: ComponentType,
    options?: { priority?: number }
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

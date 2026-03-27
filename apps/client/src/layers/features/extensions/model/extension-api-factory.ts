import type { ComponentType } from 'react';
import type { ExtensionAPI, ExtensionPointId, ExtensionReadableState } from '@dorkos/extension-api';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import type { CommandPaletteContribution } from '@/layers/shared/model';
import { executeUiCommand } from '@/layers/shared/lib/ui-action-dispatcher';
import { toast } from 'sonner';
import type { ExtensionAPIDeps } from './types';

/** Default priority for extension contributions (mid-range, after built-ins). */
const DEFAULT_PRIORITY = 50;

/** Lucide icon name used as a fallback for extension commands. */
const FALLBACK_ICON = 'puzzle';

/**
 * Construct a per-extension API object wrapping host primitives.
 *
 * Every `register*` call is tracked in the returned cleanups array.
 * On deactivation, the caller runs all cleanups automatically —
 * matching the Obsidian plugin cleanup model.
 *
 * @param extId - Extension ID from the manifest
 * @param deps - Host primitives injected by the loader
 * @returns The API object and collected cleanup functions
 */
export function createExtensionAPI(
  extId: string,
  deps: ExtensionAPIDeps
): { api: ExtensionAPI; cleanups: Array<() => void> } {
  const cleanups: Array<() => void> = [];

  const api: ExtensionAPI = {
    id: extId,

    registerComponent(
      slot: ExtensionPointId,
      id: string,
      component: ComponentType,
      options?: { priority?: number }
    ): () => void {
      const contribution = adaptToContribution(slot, `${extId}:${id}`, component, options);
      const unsub = deps.registry.register(slot, contribution);
      cleanups.push(unsub);
      return unsub;
    },

    registerCommand(
      id: string,
      label: string,
      callback: () => void,
      options?: { icon?: string; shortcut?: string }
    ): () => void {
      const actionId = `ext:${extId}:${id}`;
      const contribution: CommandPaletteContribution = {
        id: `${extId}:${id}`,
        label,
        icon: options?.icon ?? FALLBACK_ICON,
        action: actionId,
        shortcut: options?.shortcut,
        category: 'feature',
      };
      const unsub = deps.registry.register('command-palette.items', contribution);
      cleanups.push(unsub);
      deps.registerCommandHandler(actionId, callback);
      return unsub;
    },

    registerDialog(id: string, component: ComponentType): { open: () => void; close: () => void } {
      const dialogId = `${extId}:${id}`;
      const contribution = {
        id: dialogId,
        component,
        openStateKey: `ext-dialog:${dialogId}`,
      };
      const unsub = deps.registry.register('dialog', contribution);
      cleanups.push(unsub);

      // Track open state locally — dialog open/close is managed here since
      // DialogContribution.openStateKey ties into the app store, but extensions
      // provide their own open control surface.
      let openState = false;
      return {
        open: () => {
          openState = true;
        },
        close: () => {
          openState = false;
        },
        // Expose for testing without polluting the public interface type
        get _openState() {
          return openState;
        },
      } as { open: () => void; close: () => void };
    },

    registerSettingsTab(id: string, label: string, component: ComponentType): () => void {
      const contribution = {
        id: `${extId}:${id}`,
        label,
        // LucideIcon is a React component type; extensions supply raw components,
        // so icon is intentionally absent here — the registry accepts undefined.
        icon: undefined as unknown as import('lucide-react').LucideIcon,
        component,
      };
      const unsub = deps.registry.register('settings.tabs', contribution);
      cleanups.push(unsub);
      return unsub;
    },

    executeCommand(command: UiCommand): void {
      executeUiCommand(deps.dispatcherContext, command);
    },

    openCanvas(content: UiCanvasContent): void {
      executeUiCommand(deps.dispatcherContext, {
        action: 'open_canvas',
        content,
      });
    },

    navigate(path: string): void {
      deps.navigate({ to: path });
    },

    getState(): ExtensionReadableState {
      const store = deps.appStore.getState();
      return projectState(store);
    },

    subscribe(
      selector: (state: ExtensionReadableState) => unknown,
      callback: (value: unknown) => void
    ): () => void {
      // Zustand's subscribe takes a selector over the raw store state.
      // We project it to ExtensionReadableState before passing to the extension selector.
      const unsub = deps.appStore.subscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rawState: any) => selector(projectState(rawState)),
        callback
      );
      cleanups.push(unsub);
      return unsub;
    },

    async loadData<T>(): Promise<T | null> {
      const res = await fetch(`/api/extensions/${extId}/data`);
      if (res.status === 204) return null;
      return res.json() as Promise<T>;
    },

    async saveData<T>(data: T): Promise<void> {
      await fetch(`/api/extensions/${extId}/data`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    },

    notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void {
      const type = options?.type ?? 'info';
      toast[type](message);
    },

    isSlotAvailable(slot: ExtensionPointId): boolean {
      return deps.availableSlots.has(slot);
    },
  };

  return { api, cleanups };
}

// --- Internal helpers ---

/**
 * Project raw app store state into the read-only extension state shape.
 *
 * Maps the app store's `selectedCwd` and `sessionId` fields to the
 * `ExtensionReadableState` interface. `agentId` is not yet tracked in the
 * app store so it always resolves to null.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectState(store: any): ExtensionReadableState {
  return {
    currentCwd: store.selectedCwd ?? null,
    activeSessionId: store.sessionId ?? null,
    // agentId not yet in app store — reserved for future tracking
    agentId: null,
  };
}

/**
 * Adapt a generic component registration into the Phase 2 registry's per-slot
 * contribution shape. Each slot has its own required fields.
 */
function adaptToContribution(
  slot: ExtensionPointId,
  id: string,
  component: ComponentType,
  options?: { priority?: number }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const base = { id, priority: options?.priority ?? DEFAULT_PRIORITY };

  switch (slot) {
    case 'dashboard.sections':
      return { ...base, component };
    case 'sidebar.tabs':
      // LucideIcon required by registry; extensions can patch icon separately.
      return {
        ...base,
        component,
        label: id,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'sidebar.footer':
      return {
        ...base,
        onClick: () => {},
        label: id,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'header.actions':
      return {
        ...base,
        onClick: () => {},
        label: id,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'session.canvas':
      return { ...base, component, contentType: 'extension' };
    case 'settings.tabs':
      return {
        ...base,
        component,
        label: id,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'dialog':
      return { ...base, component, openStateKey: `ext:${id}` };
    case 'command-palette.items':
      return {
        ...base,
        label: id,
        icon: FALLBACK_ICON,
        action: `ext:${id}`,
        category: 'feature' as const,
      };
    default: {
      // Exhaustive check for future slot additions
      const _exhaustive: never = slot;
      console.warn('[ExtensionAPI] Unknown slot:', _exhaustive);
      return { ...base, component };
    }
  }
}

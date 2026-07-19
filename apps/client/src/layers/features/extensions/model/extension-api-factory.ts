import type { ComponentType } from 'react';
import type {
  ExtensionAPI,
  ExtensionPointId,
  ExtensionReadableState,
  ExtensionEvent,
  ExtensionEventKind,
  ExtensionEventDeclaration,
} from '@dorkos/extension-api';
import { isExtensionEventDeclared } from '@dorkos/extension-api';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import type { CommandPaletteContribution } from '@/layers/shared/model';
import { executeUiCommand } from '@/layers/shared/lib/ui-action-dispatcher';
import { toast } from 'sonner';
import type { ExtensionAPIDeps } from './types';
import { extensionApiUrl } from './extension-api-url';

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
 * @param declaredEvents - The manifest's `capabilities.events` entries. Gates
 *   `api.events.subscribe`: a subscribe request for a kind not covered here (by
 *   kind name or category) is rejected. Defaults to none.
 * @returns The API object and collected cleanup functions
 */
export function createExtensionAPI(
  extId: string,
  deps: ExtensionAPIDeps,
  declaredEvents: readonly ExtensionEventDeclaration[] = []
): { api: ExtensionAPI; cleanups: Array<() => void> } {
  const cleanups: Array<() => void> = [];

  const api: ExtensionAPI = {
    id: extId,

    registerComponent(
      slot: ExtensionPointId,
      id: string,
      component: ComponentType,
      options?: { priority?: number; label?: string }
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
      deps.registerCommandHandler(actionId, callback);
      const fullCleanup = () => {
        unsub();
        deps.unregisterCommandHandler(actionId);
      };
      cleanups.push(fullCleanup);
      return fullCleanup;
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
      // Origin 'agent': extension code is programmatic — not an explicit human
      // tab pick — so it must not persist over the user's per-agent right-panel
      // tab preference (DOR-227).
      executeUiCommand(deps.dispatcherContext, command, 'agent');
    },

    openCanvas(content: UiCanvasContent): void {
      // Origin 'agent': programmatic reveal, same reasoning as executeCommand.
      executeUiCommand(
        deps.dispatcherContext,
        {
          action: 'open_canvas',
          content,
        },
        'agent'
      );
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
      // The app store exposes the plain single-listener subscribe, so the
      // selector-diffing extensions expect lives here: project the raw state,
      // run the extension's selector, and fire only when the selected value
      // changes (Object.is). Seed `current` from the store so the first real
      // change — not the initial value — triggers the callback.
      let current = selector(projectState(deps.appStore.getState()));
      const unsub = deps.appStore.subscribe((rawState: unknown) => {
        const next = selector(projectState(rawState));
        if (!Object.is(next, current)) {
          current = next;
          callback(next);
        }
      });
      cleanups.push(unsub);
      return unsub;
    },

    events: {
      subscribe(kinds: ExtensionEventKind[], handler: (event: ExtensionEvent) => void): () => void {
        const allowed = kinds.filter((kind) => isExtensionEventDeclared(kind, declaredEvents));
        const rejected = kinds.filter((kind) => !isExtensionEventDeclared(kind, declaredEvents));
        if (rejected.length > 0) {
          console.warn(
            `[ExtensionAPI] ${extId}: events.subscribe rejected undeclared kind(s): ` +
              `${rejected.join(', ')}. Add them to manifest capabilities.events.`
          );
        }
        // Every requested kind was undeclared — nothing to deliver, so the
        // unsubscribe is a real no-op rather than a bridge subscription.
        if (allowed.length === 0) return () => {};

        const unsub = deps.eventBridge.subscribe(allowed, handler);
        cleanups.push(unsub);
        return unsub;
      },
    },

    async loadData<T>(): Promise<T | null> {
      const res = await fetch(extensionApiUrl(`/extensions/${extId}/data`));
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`loadData failed: ${res.status}`);
      return res.json() as Promise<T>;
    },

    async saveData<T>(data: T): Promise<void> {
      const res = await fetch(extensionApiUrl(`/extensions/${extId}/data`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`saveData failed: ${res.status}`);
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
 * Maps the app store's `selectedCwd`, `sessionId`, and `currentAgentId` fields
 * to the `ExtensionReadableState` interface. `currentAgentId` is resolved from
 * the selected cwd by `useSyncCurrentAgentId`; it is null when no agent is
 * registered there or resolution hasn't completed.
 */
function projectState(store: unknown): ExtensionReadableState {
  const s = (store ?? {}) as {
    selectedCwd?: string | null;
    sessionId?: string | null;
    currentAgentId?: string | null;
  };
  return {
    currentCwd: s.selectedCwd ?? null,
    activeSessionId: s.sessionId ?? null,
    agentId: s.currentAgentId ?? null,
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
  options?: { priority?: number; label?: string }
): Record<string, unknown> {
  const base = { id, priority: options?.priority ?? DEFAULT_PRIORITY };
  // Human label for labelled/tabbed slots; namespaced id is the honest fallback.
  const label = options?.label ?? id;

  switch (slot) {
    case 'dashboard.sections':
      return { ...base, component };
    case 'sidebar.tabs':
      // `icon` is optional on SidebarTabContribution — the tab strip renders a
      // default puzzle-piece icon for extension tabs that supply none.
      return { ...base, component, label };
    case 'sidebar.footer':
      return {
        ...base,
        onClick: () => {},
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'header.actions':
      return {
        ...base,
        onClick: () => {},
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'right-panel':
      // Third-party right-panel tabs register only their content component. The
      // container owns the shared header (tab strip + close), so an extension
      // tab can never trap the user — no per-tab header wiring is required.
      // `headerActions` is reserved for built-ins that need header controls.
      return {
        ...base,
        component,
        title: label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
        headerActions: undefined,
        visibleWhen: undefined,
      };
    case 'settings.tabs':
      return {
        ...base,
        component,
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'dialog':
      return { ...base, component, openStateKey: `ext:${id}` };
    case 'command-palette.items':
      return {
        ...base,
        label,
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

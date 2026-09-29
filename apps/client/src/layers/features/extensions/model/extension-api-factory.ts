import type { ComponentType } from 'react';
import type {
  DecisionAnswer,
  DecisionAnswerResult,
  ExtensionAPI,
  ExtensionDecisionView,
  ExtensionPointId,
  ExtensionReadableState,
  ExtensionEvent,
  ExtensionEventKind,
  ExtensionEventDeclaration,
  ExtensionPageOptions,
  ExtensionPageProps,
  ProjectRef,
  StatusBarItemOptions,
  StatusBarSlotContext,
} from '@dorkos/extension-api';
import { isExtensionEventDeclared } from '@dorkos/extension-api';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import {
  DecisionActionResponseSchema,
  ListExtensionDecisionsResponseSchema,
  ProjectSettingsResponseSchema,
} from '@dorkos/shared/extension-decision-schemas';
import type {
  CommandPaletteContribution,
  ExtensionPageContribution,
  StatusBarContribution,
} from '@/layers/shared/model';
import { executeUiCommand } from '@/layers/shared/lib/ui-action-dispatcher';
import { internalRoutePath } from '@/layers/shared/lib/link-navigation';
import {
  EXTENSION_PAGE_PATH_PATTERN,
  parseExtensionPagePath,
} from '@/layers/shared/lib/extension-page-path';
import { toast } from 'sonner';
import type { ExtensionAPIDeps } from './types';
import { extensionApiUrl } from './extension-api-url';

/** Default priority for extension contributions (mid-range, after built-ins). */
const DEFAULT_PRIORITY = 50;

/** Lucide icon name used as a fallback for extension commands. */
const FALLBACK_ICON = 'puzzle';

/** Default order of an extension's status-bar item among the others (spec §11.1). */
const DEFAULT_STATUS_BAR_PRIORITY = 100;

/**
 * Construct a per-extension API object wrapping host primitives.
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
  let markersQueuedForCleanup = false;

  const api: ExtensionAPI = {
    id: extId,

    registerComponent(
      slot: ExtensionPointId,
      id: string,
      component: ComponentType,
      options?: {
        priority?: number;
        label?: string;
        icon?: ComponentType<{ className?: string }>;
        group?: string;
        visibleWhen?: () => boolean;
      }
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

    registerSettingsTab(
      id: string,
      label: string,
      component: ComponentType,
      options?: { group?: string }
    ): () => void {
      const contribution = {
        id: `${extId}:${id}`,
        label,
        // LucideIcon is a React component type; extensions supply raw components,
        // so icon is intentionally absent here — the registry accepts undefined.
        icon: undefined as unknown as import('lucide-react').LucideIcon,
        component,
        // Absent group means "Add-ons"; the Settings dialog applies that default
        // when it renders, so we forward whatever the extension asked for.
        group: options?.group,
      };
      const unsub = deps.registry.register('settings.tabs', contribution);
      cleanups.push(unsub);
      return unsub;
    },

    registerPage(
      path: string,
      component: ComponentType<ExtensionPageProps>,
      options: ExtensionPageOptions
    ): () => void {
      if (!EXTENSION_PAGE_PATH_PATTERN.test(path)) {
        throw new Error(
          `[extensions] ${extId}: registerPage path ${JSON.stringify(path)} is not '' or ` +
            "lowercase segments and ':param' placeholders, e.g. 'p/:name'"
        );
      }
      // The title names the page in its bar, its tab, the palette and the phone
      // menu, and the menus sort by it. An untyped extension can hand anything
      // here, so a page with no usable title is refused rather than drawn blank
      // (or crashing a sort) in four places.
      const title = typeof options?.title === 'string' ? options.title.trim() : '';
      if (!title) {
        console.warn(
          `[extensions] ${extId}: registerPage('${path}') needs options.title, a non-empty string; the page was not added`
        );
        return () => {};
      }
      const id = `${extId}:${path}`;
      if (deps.registry.getContributions('pages').some((page) => page.id === id)) {
        console.warn(
          `[extensions] ${extId} registered the page '${path}' twice; the later one wins`
        );
      }
      const contribution: ExtensionPageContribution = {
        id,
        extensionId: extId,
        path,
        component,
        title,
        // Kept as given: every surface draws it through `ContributedIcon`, which
        // falls back to a puzzle piece for anything it cannot render.
        icon: options.icon,
        menu: options.menu !== false,
      };
      const unsub = deps.registry.register('pages', contribution);
      cleanups.push(unsub);
      return unsub;
    },

    registerStatusBarItem(
      id: string,
      component: ComponentType<StatusBarSlotContext>,
      options: StatusBarItemOptions
    ): () => void {
      const contribution: StatusBarContribution = {
        id: `${extId}:${id}`,
        extensionId: extId,
        label: options.label,
        priority: options.priority ?? DEFAULT_STATUS_BAR_PRIORITY,
        component,
        // Bound to `options` so an author may write them as methods that use
        // `this`; the host calls them bare.
        when: options.when?.bind(options),
        urgent: options.urgent?.bind(options),
      };
      const unsub = deps.registry.register('status-bar', contribution);
      cleanups.push(unsub);
      return unsub;
    },

    setTabMarker(tabId: string, marker: 'attention' | null): void {
      const contributionId = `${extId}:${tabId}`;
      const owned = deps.registry
        .getContributions('right-panel')
        .some((contribution) => contribution.id === contributionId);
      if (!owned) {
        console.warn(
          `[extensions] ${extId} asked to mark the tab '${tabId}', which it has not registered ` +
            "with registerComponent('right-panel', …)"
        );
        return;
      }
      // Marks live in the registry, apart from the contributions they sit on,
      // so they are cleared with the extension (spec §6.7). Queued once, the
      // first time this extension marks anything.
      if (!markersQueuedForCleanup) {
        markersQueuedForCleanup = true;
        cleanups.push(() => deps.registry.clearTabMarkers(extId));
      }
      deps.registry.setTabMarker(contributionId, marker);
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
      // An extension wrote this string, so it is checked against the routes the
      // app actually serves before the router is handed it (DOR-924). An
      // unknown path, another origin, or a scheme the link seam refuses is a
      // no-op that says so rather than a navigation to nowhere.
      const target = internalRoutePath(path);
      if (target === null) {
        console.warn(`[extensions] ${extId} asked to navigate to an unknown route:`, path);
        return;
      }
      // Pages under `/x/` are scoped: an extension may send you to its own,
      // never to another extension's (spec `flow-multiproject` invariant 11).
      const page = parseExtensionPagePath(new URL(target, 'http://x.invalid').pathname);
      if (page !== null && page.extensionId !== extId) {
        console.warn(`[extensions] ${extId} asked to navigate to another extension's page:`, path);
        return;
      }
      deps.navigate({ to: target });
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

    // --- Inbox decisions and per-project settings (spec flow-multiproject §7) ---
    // Every URL carries THIS extension's id; the server scopes each route to it.

    async answerDecision(
      decisionId: string,
      answer: DecisionAnswer
    ): Promise<DecisionAnswerResult> {
      const res = await fetch(
        extensionApiUrl(`/extensions/${extId}/decisions/${encodeURIComponent(decisionId)}/action`),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(answer),
        }
      );
      if (!res.ok) throw await requestError(res, 'answerDecision');
      const body = DecisionActionResponseSchema.parse(await res.json());
      // The server checked it is an in-app path. Follow it the way the
      // extension's own `navigate` would: core routes, and this extension's
      // own `/x/<id>/…` pages.
      if (body.navigate) api.navigate(body.navigate);
      return {
        resolved: body.resolved,
        message: body.message,
        navigate: body.navigate,
        watch: body.watch,
      };
    },

    async listDecisions(): Promise<ExtensionDecisionView[]> {
      const res = await fetch(extensionApiUrl(`/extensions/${extId}/decisions`));
      if (!res.ok) throw await requestError(res, 'listDecisions');
      return ListExtensionDecisionsResponseSchema.parse(await res.json()).decisions.map(
        (decision) => ({
          id: decision.id,
          key: decision.key,
          title: decision.title,
          why: decision.why,
          detail: decision.detail,
          project: decision.project,
          projectLabel: decision.projectLabel,
          since: decision.since,
          actions: decision.actions,
          link: decision.link,
          raisedAt: decision.raisedAt,
        })
      );
    },

    projectSettings: {
      async get<T = unknown>(projectRoot: string): Promise<T | null> {
        const query = new URLSearchParams({ project: projectRoot });
        const res = await fetch(
          extensionApiUrl(`/extensions/${extId}/project-settings?${query.toString()}`)
        );
        if (!res.ok) throw await requestError(res, 'projectSettings.get');
        const body = ProjectSettingsResponseSchema.parse(await res.json());
        return (body.value as T | null) ?? null;
      },
      async set(projectRoot: string, value: unknown): Promise<void> {
        const res = await fetch(extensionApiUrl(`/extensions/${extId}/project-settings`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: projectRoot, value }),
        });
        if (!res.ok) throw await requestError(res, 'projectSettings.set');
      },
    },
  };

  return { api, cleanups };
}

// --- Internal helpers ---

/**
 * An Error carrying the server's own sentence and code, so an extension can
 * tell "not running" from "already settled" (`err.code`).
 *
 * @param res - The refused response.
 * @param method - Which API member asked, for the fallback message.
 */
async function requestError(
  res: Response,
  method: string
): Promise<Error & { code?: string; status: number }> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  const error = new Error(body.error ?? `${method} failed: ${res.status}`) as Error & {
    code?: string;
    status: number;
  };
  error.status = res.status;
  if (body.code) error.code = body.code;
  return error;
}

/**
 * Project raw app store state into the read-only extension state shape.
 *
 * Maps the app store's `selectedCwd`, `sessionId`, `currentAgentId` and
 * `currentProject` and `requireLogin` fields to the `ExtensionReadableState` interface. `currentAgentId` is resolved from
 * the selected cwd by `useSyncCurrentAgentId`; it is null when no agent is
 * registered there or resolution hasn't completed.
 */
function projectState(store: unknown): ExtensionReadableState {
  const s = (store ?? {}) as {
    selectedCwd?: string | null;
    sessionId?: string | null;
    currentAgentId?: string | null;
    currentProject?: ProjectRef | null;
    requireLogin?: boolean;
  };
  return {
    currentCwd: s.selectedCwd ?? null,
    activeSessionId: s.sessionId ?? null,
    agentId: s.currentAgentId ?? null,
    // The store's own object, never a copy: `subscribe` diffs by identity, and
    // the store only replaces it when the root or name really changed.
    currentProject: s.currentProject ?? null,
    requireLogin: s.requireLogin === true,
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
  options?: {
    priority?: number;
    label?: string;
    icon?: ComponentType<{ className?: string }>;
    group?: string;
    visibleWhen?: () => boolean;
  }
): Record<string, unknown> {
  const base = { id, priority: options?.priority ?? DEFAULT_PRIORITY };
  // Human label for labelled/tabbed slots; namespaced id is the honest fallback.
  const label = options?.label ?? id;

  switch (slot) {
    case 'dashboard.sections':
      // `visibleWhen` is forwarded, not dropped: the section renders on the
      // Activity tab, which re-evaluates the predicate on every render, so an
      // extension can hide its own section without unregistering it.
      return { ...base, component, visibleWhen: options?.visibleWhen };
    case 'sidebar.footer':
      return {
        ...base,
        onClick: () => {},
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
      };
    case 'right-panel':
      // Third-party right-panel tabs register their content component and, if
      // they choose, a tab icon; the strip falls back to a puzzle-piece when
      // `icon` is omitted. The container owns the shared header (tab strip +
      // close), so an extension tab can never trap the user — no per-tab header
      // wiring is required. `headerActions` is reserved for built-ins that need
      // header controls.
      return {
        ...base,
        component,
        title: label,
        icon: options?.icon,
        headerActions: undefined,
        visibleWhen: undefined,
      };
    case 'settings.tabs':
      return {
        ...base,
        component,
        label,
        icon: undefined as unknown as import('lucide-react').LucideIcon,
        // Absent group is resolved to "Add-ons" by the Settings dialog itself.
        group: options?.group,
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
    case 'status-bar':
      // `registerStatusBarItem` is the documented way in; this keeps
      // `registerComponent('status-bar', …)` from registering something the bar
      // cannot draw. Always shown, never urgent.
      return {
        ...base,
        extensionId: id.slice(0, id.indexOf(':')),
        label,
        priority: options?.priority ?? DEFAULT_STATUS_BAR_PRIORITY,
        component,
      };
    default: {
      // Exhaustive check for future slot additions
      const _exhaustive: never = slot;
      console.warn('[ExtensionAPI] Unknown slot:', _exhaustive);
      return { ...base, component };
    }
  }
}

import type {
  ExtensionAPI,
  ExtensionReadableState,
  ExtensionEvent,
  ExtensionEventKind,
  ExtensionEventDeclaration,
  ExtensionPointId,
  ProjectRef,
} from '@dorkos/extension-api';
import { isExtensionEventDeclared } from '@dorkos/extension-api';
import type { UiCommand, UiCanvasContent } from '@dorkos/shared/types';
import { executeUiCommand, internalRoutePath, parseExtensionPagePath } from '@/layers/shared/lib';
import { toast } from 'sonner';
import type { ExtensionAPIDeps } from './types';
import { createHostEntry, type HostEntry } from './extension-api-host';
import type { EffectOwner } from '@/layers/shared/lib';
import { createContributions } from './extension-api-contributions';
import { createRemoteAPI } from './extension-api-remote';
/** Create one lifetime-owned API; the guard is always supplied by the loader. */
export function createExtensionAPI(
  extId: string,
  deps: ExtensionAPIDeps,
  declaredEvents: readonly ExtensionEventDeclaration[],
  requireCurrent: () => void
): { api: ExtensionAPI; cleanups: Array<() => void> } {
  const cleanups: Array<() => void> = [];
  const host = createHostEntry(requireCurrent, cleanups);
  const hostCall = host.call;
  const effectOwner = host.effectOwner;
  const dispatcher = deps.dispatcherContext;
  const context = {
    extId,
    deps,
    declaredEvents,
    requireCurrent,
    cleanups,
    hostCall,
    effectOwner,
    dispatcher,
  };
  const local = createLocalAPI(context);
  const contributions = createContributions({ extId, deps, hostCall, cleanups, requireCurrent });
  const remote = createRemoteAPI({
    extId,
    hostFetch: host.fetch,
    requireCurrent,
    navigate: local.navigate,
  });
  const api: ExtensionAPI = { ...local, ...contributions, ...remote };
  return { api, cleanups };
}

function createLocalAPI(context: LocalContext) {
  const { extId } = context;
  return {
    id: extId,
    executeCommand(command: UiCommand): void {
      return localExecuteCommand(context, command);
    },
    openCanvas(content: UiCanvasContent): void {
      return localOpenCanvas(context, content);
    },
    navigate(path: string): void {
      return localNavigate(context, path);
    },
    getState(): ExtensionReadableState {
      return localGetState(context);
    },
    subscribe(
      selector: (state: ExtensionReadableState) => unknown,
      callback: (value: unknown) => void
    ): () => void {
      return localSubscribe(context, selector, callback);
    },
    events: {
      subscribe: (kinds: ExtensionEventKind[], handler: (event: ExtensionEvent) => void) =>
        localEventsSubscribe(context, kinds, handler),
    },
    notify(message: string, options?: { type?: 'info' | 'success' | 'error' }): void {
      return localNotify(context, message, options);
    },
    isSlotAvailable(slot: ExtensionPointId): boolean {
      return localIsSlotAvailable(context, slot);
    },
  };
}
function localEventsSubscribe(
  context: LocalContext,
  kinds: ExtensionEventKind[],
  handler: (event: ExtensionEvent) => void
): () => void {
  const { extId, deps, declaredEvents, hostCall, cleanups } = context;
  const allowed = kinds.filter((kind) => isExtensionEventDeclared(kind, declaredEvents));
  const rejected = kinds.filter((kind) => !isExtensionEventDeclared(kind, declaredEvents));
  if (rejected.length > 0) {
    hostCall(console, console.warn, [
      `[ExtensionAPI] ${extId}: events.subscribe rejected undeclared kind(s): ` +
        `${rejected.join(', ')}. Add them to manifest capabilities.events.`,
    ]);
  }
  // Every requested kind was undeclared — nothing to deliver, so the
  // unsubscribe is a real no-op rather than a bridge subscription.
  if (allowed.length === 0) return () => {};

  const unsub = hostCall(deps.eventBridge, deps.eventBridge.subscribe, [allowed, handler]);
  cleanups.push(unsub);
  return unsub;
}
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

interface LocalContext {
  extId: string;
  deps: ExtensionAPIDeps;
  declaredEvents: readonly ExtensionEventDeclaration[];
  requireCurrent: () => void;
  cleanups: Array<() => void>;
  hostCall: HostEntry['call'];
  effectOwner: EffectOwner;
  dispatcher: ExtensionAPIDeps['dispatcherContext'];
}

function localExecuteCommand(context: LocalContext, command: UiCommand): void {
  const { effectOwner, dispatcher } = context;

  // Origin 'agent': extension code is programmatic — not an explicit human
  // tab pick — so it must not persist over the user's per-agent right-panel
  // tab preference (DOR-227).
  executeUiCommand(dispatcher, command, 'agent', effectOwner);
}
function localOpenCanvas(context: LocalContext, content: UiCanvasContent): void {
  const { effectOwner, dispatcher } = context;

  // Origin 'agent': programmatic reveal, same reasoning as executeCommand.
  executeUiCommand(
    dispatcher,
    {
      action: 'open_canvas',
      content,
    },
    'agent',
    effectOwner
  );
}
function localNavigate(context: LocalContext, path: string): void {
  const { extId, deps, hostCall } = context;

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
  const method = deps.navigate;
  const destination = { to: target };
  hostCall(deps, method, [destination]);
}
function localGetState(context: LocalContext): ExtensionReadableState {
  const { deps, hostCall } = context;

  const store = hostCall(deps.appStore, deps.appStore.getState, []);
  return projectState(store);
}
function localSubscribe(
  context: LocalContext,
  selector: (state: ExtensionReadableState) => unknown,
  callback: (value: unknown) => void
): () => void {
  const { deps, requireCurrent, cleanups, hostCall } = context;

  // The app store exposes the plain single-listener subscribe, so the
  // selector-diffing extensions expect lives here: project the raw state,
  // run the extension's selector, and fire only when the selected value
  // changes (Object.is). Seed `current` from the store so the first real
  // change — not the initial value — triggers the callback.
  let current = selector(projectState(hostCall(deps.appStore, deps.appStore.getState, [])));
  const listener = (rawState: unknown) => {
    requireCurrent();
    const next = selector(projectState(rawState));
    requireCurrent();
    if (!Object.is(next, current)) {
      current = next;
      callback(next);
    }
  };
  const method = deps.appStore.subscribe;
  const unsub = hostCall(deps.appStore, method, [listener]);
  cleanups.push(unsub);
  return unsub;
}
function localNotify(
  context: LocalContext,
  message: string,
  options?: { type?: 'info' | 'success' | 'error' }
): void {
  const { hostCall } = context;

  const type = options?.type ?? 'info';
  const method = toast[type];
  hostCall(toast, method, [message]);
}
function localIsSlotAvailable(context: LocalContext, slot: ExtensionPointId): boolean {
  const { deps, hostCall } = context;

  return hostCall(deps.availableSlots, deps.availableSlots.has, [slot]);
}

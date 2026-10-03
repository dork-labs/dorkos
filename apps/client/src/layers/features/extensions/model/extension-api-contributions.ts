import { createElement, type ComponentType } from 'react';
import type {
  ExtensionRecordPublic,
  SecretDeclaration,
  SettingDeclaration,
} from '@dorkos/extension-api';
import { ManifestSettingsPanel, ManifestSettingsIcon } from '../ui/ManifestSettingsPanel';
import type { ExtensionAPI, ExtensionPointId } from '@dorkos/extension-api';
import type {
  CommandPaletteContribution,
  ExtensionPageContribution,
  StatusBarContribution,
} from '@/layers/shared/model';
import { EXTENSION_PAGE_PATH_PATTERN } from '@/layers/shared/lib';
import type { ExtensionAPIDeps } from './types';
import {
  prepareCommandRegistration,
  enterContribution,
  disposeTogether,
  subscribeOwned,
  type HostEntry,
} from './extension-api-host';
const DEFAULT_PRIORITY = 50;
const FALLBACK_ICON = 'puzzle';
const DEFAULT_STATUS_BAR_PRIORITY = 100;
type Contributions = Pick<
  ExtensionAPI,
  | 'registerComponent'
  | 'registerCommand'
  | 'registerDialog'
  | 'registerSettingsTab'
  | 'registerPage'
  | 'registerStatusBarItem'
  | 'setTabMarker'
>;
interface ContributionContext {
  extId: string;
  deps: ExtensionAPIDeps;
  hostCall: HostEntry['call'];
  cleanups: Array<() => void>;
  requireCurrent: () => void;
  markersQueuedForCleanup: boolean;
}
/** Build registrations that share the same load owner and cleanup ledger. */
export function createContributions(
  input: Omit<ContributionContext, 'markersQueuedForCleanup'>
): Contributions {
  const context = { ...input, markersQueuedForCleanup: false };
  return {
    registerComponent: (...args) => registerComponent(context, ...args),
    registerCommand: (...args) => registerCommand(context, ...args),
    registerDialog: (...args) => registerDialog(context, ...args),
    registerSettingsTab: (...args) => registerSettingsTab(context, ...args),
    registerPage: (...args) => registerPage(context, ...args),
    registerStatusBarItem: (...args) => registerStatusBarItem(context, ...args),
    setTabMarker: (...args) => setTabMarker(context, ...args),
  };
}
function registerComponent(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['registerComponent']>
): ReturnType<ExtensionAPI['registerComponent']> {
  const { extId } = context;
  const [slot, id, component, options] = args;

  const contribution = adaptToContribution(slot, `${extId}:${id}`, component, options);
  const unsub = registerContribution(context, slot, contribution);
  return unsub;
}

function registerCommand(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['registerCommand']>
): ReturnType<ExtensionAPI['registerCommand']> {
  const { extId, deps, hostCall, cleanups } = context;
  const [id, label, callback, options] = args;

  const actionId = `ext:${extId}:${id}`;
  const contribution: CommandPaletteContribution = {
    id: `${extId}:${id}`,
    label,
    icon: options?.icon ?? FALLBACK_ICON,
    action: actionId,
    shortcut: options?.shortcut,
    category: 'feature',
  };
  const unsub = registerContribution(context, 'command-palette.items', contribution);
  context.requireCurrent();
  const registration = registrationContexts.get(deps);
  const target = registration?.deps ?? deps;
  const command = prepareCommandRegistration(target, actionId, () => {
    if (registration ? registration.owner.isCurrent() : isContributionCurrent(context)) callback();
  });
  cleanups.push(command.cleanup); // Before handler entry, including an unacknowledged throw.
  hostCall(target, command.enter, []);
  context.requireCurrent();
  return () => disposeTogether([unsub, command.cleanup]);
}

function registerDialog(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['registerDialog']>
): ReturnType<ExtensionAPI['registerDialog']> {
  const { extId, requireCurrent } = context;
  const [id, component] = args;

  const dialogId = `${extId}:${id}`;
  const contribution = {
    id: dialogId,
    component,
    openStateKey: `ext-dialog:${dialogId}`,
  };
  registerContribution(context, 'dialog', contribution);

  // Track open state locally — dialog open/close is managed here since
  // DialogContribution.openStateKey ties into the app store, but extensions
  // provide their own open control surface.
  let openState = false;
  return {
    open: () => {
      requireCurrent();
      openState = true;
    },
    close: () => {
      requireCurrent();
      openState = false;
    },
    // Expose for testing without polluting the public interface type
    get _openState() {
      return openState;
    },
  } as { open: () => void; close: () => void };
}

function registerSettingsTab(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['registerSettingsTab']>
): ReturnType<ExtensionAPI['registerSettingsTab']> {
  const { extId } = context;
  const [id, label, component, options] = args;

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
  const unsub = registerContribution(context, 'settings.tabs', contribution);
  return unsub;
}

function registerPage(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['registerPage']>
): ReturnType<ExtensionAPI['registerPage']> {
  const { extId, deps } = context;
  const [path, component, options] = args;

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
    console.warn(`[extensions] ${extId} registered the page '${path}' twice; the later one wins`);
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
  const unsub = registerContribution(context, 'pages', contribution);
  return unsub;
}

function registerStatusBarItem(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['registerStatusBarItem']>
): ReturnType<ExtensionAPI['registerStatusBarItem']> {
  const { extId } = context;
  const [id, component, options] = args;

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
  const unsub = registerContribution(context, 'status-bar', contribution);
  return unsub;
}

function setTabMarker(
  context: ContributionContext,
  ...args: Parameters<ExtensionAPI['setTabMarker']>
): ReturnType<ExtensionAPI['setTabMarker']> {
  const { extId, deps, hostCall, cleanups } = context;
  const [tabId, marker] = args;

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
  if (!context.markersQueuedForCleanup) {
    context.markersQueuedForCleanup = true;
    cleanups.push(() => deps.registry.clearTabMarkers(extId));
  }
  hostCall(deps.registry, deps.registry.setTabMarker, [contributionId, marker]);
}
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
): Record<string, unknown> & { id: string } {
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
      return sidebarContribution(base, label);
    case 'right-panel':
      return rightPanelContribution(base, component, label, options);
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
      return statusContribution(base, component, label, options);
    default:
      return unknownSlotContribution(base, component, slot);
  }
}

/** Register the manifest-owned settings contribution through the loader's guarded ports. */
export function registerManifestConfigTab(
  rec: ExtensionRecordPublic,
  cleanups: Array<() => void>,
  deps: ExtensionAPIDeps
): void {
  const secrets = rec.manifest.serverCapabilities?.secrets;
  const settings = rec.manifest.serverCapabilities?.settings;
  if (!secrets?.length && !settings?.length) return;

  const extensionId = rec.id;
  const tabId = `${extensionId}:settings`;
  const frozenSecrets: SecretDeclaration[] = secrets ?? [];
  const frozenSettings: SettingDeclaration[] = settings ?? [];

  const unsub = deps.registry.register('settings.tabs', {
    id: tabId,
    label: rec.manifest.name,
    icon: ManifestSettingsIcon,
    component: function AutoConfigTab() {
      return createElement(ManifestSettingsPanel, {
        extensionId,
        secrets: frozenSecrets,
        settings: frozenSettings,
      });
    },
    priority: 90,
    group: 'Add-ons',
  });

  cleanups.push(unsub);
}

interface RegistrationOwner {
  requireCurrent: () => void;
  isCurrent: () => boolean;
  track: (cleanup: () => void) => () => void;
}
interface RegistrationContext {
  deps: ExtensionAPIDeps;
  owner: RegistrationOwner;
}
function ownedEvents(context: RegistrationContext): ExtensionAPIDeps['eventBridge'] {
  const events = context.deps.eventBridge;
  return {
    subscribe: (kinds, callback) => {
      const method = events.subscribe;
      return subscribeOwned(context, events, method as (...args: unknown[]) => () => void, [
        kinds,
        (event: unknown) => {
          if (context.owner.isCurrent()) callback(event as never);
        },
      ]);
    },
  };
}
function ownedStore(context: RegistrationContext): ExtensionAPIDeps['appStore'] {
  const store = context.deps.appStore;
  return {
    ...store,
    subscribe: (callback) => {
      const method = store.subscribe;
      return subscribeOwned(context, store, method as (...args: unknown[]) => () => void, [
        (state: unknown, previous: unknown) => {
          if (context.owner.isCurrent()) callback(state, previous);
        },
      ]);
    },
  };
}
/** Guard registration ports with the loader's exact existing owner and cleanup ledger. */
export function createOwnedRegistrationDeps(
  deps: ExtensionAPIDeps,
  owner: RegistrationOwner
): ExtensionAPIDeps {
  const context = { deps, owner };
  const registry = deps.registry;
  const prepared = {
    ...deps,
    registry: {
      ...registry,
      register: (
        slot: Parameters<ExtensionAPIDeps['registry']['register']>[0],
        contribution: Parameters<ExtensionAPIDeps['registry']['register']>[1]
      ) => {
        const method = registry.register;
        const cleanup = enterContribution(
          registry,
          method as (slot: string, contribution: { id: string }) => () => void,
          {
            slot,
            contribution: contribution as { id: string },
            requireCurrent: owner.requireCurrent,
          }
        );
        owner.track(cleanup);
        owner.requireCurrent();
        return cleanup;
      },
    },
    eventBridge: ownedEvents(context),
    appStore: ownedStore(context),
  };
  registrationContexts.set(prepared, context);
  return prepared;
}

const registrationContexts = new WeakMap<ExtensionAPIDeps, RegistrationContext>();
function isContributionCurrent(context: ContributionContext): boolean {
  try {
    context.requireCurrent();
    return true;
  } catch {
    return false;
  }
}

function registerContribution(
  context: ContributionContext,
  slot: string,
  contribution: { id: string }
): () => void {
  const registry = context.deps.registry;
  const method = registry.register;
  const cleanup = registrationContexts.has(context.deps)
    ? context.hostCall(registry, method, [slot, contribution as never])
    : enterContribution(
        registry,
        method as (slot: string, contribution: { id: string }) => () => void,
        { slot, contribution, requireCurrent: context.requireCurrent }
      );
  context.cleanups.push(cleanup);
  context.requireCurrent();
  return cleanup;
}

function rightPanelContribution(
  base: { id: string; priority: number },
  component: ComponentType,
  label: string,
  options: Parameters<ExtensionAPI['registerComponent']>[3]
): Record<string, unknown> & { id: string } {
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
}

function sidebarContribution(
  base: { id: string; priority: number },
  label: string
): Record<string, unknown> & { id: string } {
  return {
    ...base,
    onClick: () => {},
    label,
    icon: undefined as unknown as import('lucide-react').LucideIcon,
  };
}

function unknownSlotContribution(
  base: { id: string; priority: number },
  component: ComponentType,
  slot: never
): Record<string, unknown> & { id: string } {
  console.warn('[ExtensionAPI] Unknown slot:', slot);
  return { ...base, component };
}

function statusContribution(
  base: { id: string; priority: number },
  component: ComponentType,
  label: string,
  options: Parameters<ExtensionAPI['registerComponent']>[3]
): Record<string, unknown> & { id: string } {
  const id = base.id;
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
}

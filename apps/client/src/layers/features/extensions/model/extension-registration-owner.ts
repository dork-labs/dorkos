import { createElement } from 'react';
import type {
  ExtensionAPI,
  ExtensionRecordPublic,
  SecretDeclaration,
  SettingDeclaration,
} from '@dorkos/extension-api';
import type { ExtensionAPIDeps } from './types';
import { ManifestSettingsPanel, ManifestSettingsIcon } from '../ui/ManifestSettingsPanel';

const commandSlots = new WeakMap<object, Map<string, object>>();
/** Capture a cleanup for one entered command occurrence, never a later same-ID replacement. */
export function prepareCommandRegistration(
  target: {
    registerCommandHandler: (id: string, callback: () => void) => void;
    unregisterCommandHandler: (id: string) => void;
  },
  id: string,
  callback: () => void
): { enter: () => void; cleanup: () => void } {
  const register = target.registerCommandHandler;
  const remove = target.unregisterCommandHandler;
  let slots = commandSlots.get(target);
  if (!slots) commandSlots.set(target, (slots = new Map()));
  const occurrence = {};
  let entered = false;
  return {
    enter: () => {
      slots.set(id, occurrence);
      entered = true;
      Reflect.apply(register, target, [id, callback]);
    },
    cleanup: retainCleanup(() => {
      if (!entered) return;
      if (slots.get(id) !== occurrence) return;
      slots.delete(id);
      return Reflect.apply(remove, target, [id]);
    }),
  };
}
const contributionSlots = new WeakMap<object, Map<string, Map<string, object>>>();
/** Retain an idempotent original contribution receipt with callback-free slot correspondence. */
export function enterContribution(
  target: object,
  method: (slot: string, contribution: { id: string }) => () => void,
  input: {
    slot: string;
    contribution: { id: string };
    requireCurrent: () => void;
    track: (cleanup: () => void) => void;
  }
): () => void {
  const { slot, contribution, requireCurrent, track } = input;
  const id = contribution.id;
  let all = contributionSlots.get(target);
  if (!all) contributionSlots.set(target, (all = new Map()));
  let slots = all.get(slot);
  if (!slots) all.set(slot, (slots = new Map()));
  const occurrence = {};
  let entered = false;
  const receipt: { remove?: () => void } = {};
  let missingReceiptAttempted = false;
  const cleanup = retainCleanup(() => {
    if (!entered) return;
    // A port may commit before throwing: missing receipt never proves zero effects.
    if (!receipt.remove) {
      missingReceiptAttempted = true;
      throw new Error('Extension registration cleanup is unknown.');
    }
    if (slots.get(id) !== occurrence) return;
    slots.delete(id);
    return Reflect.apply(receipt.remove, undefined, []);
  });
  track(cleanup);
  requireCurrent();
  slots.set(id, occurrence);
  entered = true;
  receipt.remove = Reflect.apply(method, target, [slot, contribution]);
  if (missingReceiptAttempted) {
    // The earlier unknown result stays sticky; retain the actual late receipt separately.
    const remove = receipt.remove;
    track(
      retainCleanup(() => {
        if (slots.get(id) !== occurrence) return;
        slots.delete(id);
        return Reflect.apply(remove, undefined, []);
      })
    );
  }
  return cleanup;
}
/** Every captured obligation is attempted even when an earlier one throws. */
export function disposeTogether(callbacks: Array<() => void>): void {
  let failed = false;
  let first: unknown;
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  if (failed) throw first;
}

/** Preserve the first cleanup result or failure without replaying its native obligation. */
export function retainCleanup(release: () => void): () => void {
  let attempted = false;
  let failed = false;
  let result: void;
  let cause: unknown;
  return () => {
    if (!attempted) {
      attempted = true;
      try {
        result = Reflect.apply(release, undefined, []);
      } catch (error) {
        failed = true;
        cause = error;
      }
    }
    if (failed) throw cause;
    return result;
  };
}

/** Register and retain the exact subscription before any post-entry owner observation. */
export function subscribeOwned(
  context: { owner: { requireCurrent: () => void; track: (cleanup: () => void) => () => void } },
  port: object,
  method: (...args: unknown[]) => () => void,
  args: unknown[]
): () => void {
  context.owner.requireCurrent();
  const release = Reflect.apply(method, port, args);
  const cleanup = retainCleanup(release);
  // A started registration may return after retirement; retain its exact obligation.
  context.owner.track(cleanup);
  context.owner.requireCurrent();
  return cleanup;
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
    getState: () => {
      const method = store.getState;
      context.owner.requireCurrent();
      const state = Reflect.apply(method, store, []);
      context.owner.requireCurrent();
      return state;
    },
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
  const commandCleanups = new Map<string, () => void>();
  const prepared: ExtensionAPIDeps = {
    ...deps,
    navigate: (input) => {
      const method = deps.navigate;
      owner.requireCurrent();
      Reflect.apply(method, deps, [input]);
    },
    registerCommandHandler: (id, callback) => {
      const command = prepareCommandRegistration(deps, id, () => {
        if (owner.isCurrent()) callback();
      });
      const cleanup = owner.track(command.cleanup);
      commandCleanups.set(id, cleanup);
      owner.requireCurrent();
      command.enter();
      owner.requireCurrent();
    },
    unregisterCommandHandler: (id) => {
      commandCleanups.get(id)?.();
    },
    registry: {
      ...registry,
      getContributions: (slot) => {
        const method = registry.getContributions;
        owner.requireCurrent();
        const result = Reflect.apply(method, registry, [slot]);
        owner.requireCurrent();
        return result;
      },
      setTabMarker: (id, marker) => {
        const method = registry.setTabMarker;
        owner.requireCurrent();
        Reflect.apply(method, registry, [id, marker]);
      },
      clearTabMarkers: (id) => {
        const method = registry.clearTabMarkers;
        owner.requireCurrent();
        Reflect.apply(method, registry, [id]);
      },
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
            track: owner.track,
          }
        );
        owner.requireCurrent();
        return cleanup;
      },
    },
    eventBridge: ownedEvents(context),
    appStore: ownedStore(context),
  };
  return prepared;
}

/** Guard synchronous API entry; async app-action continuations remain a separate boundary. */
export function guardExtensionAPI(api: ExtensionAPI, requireCurrent: () => void): ExtensionAPI {
  const wrap = (object: object): object =>
    new Proxy(object, {
      get(target, key) {
        requireCurrent();
        const value = Reflect.get(target, key, target);
        requireCurrent();
        if (typeof value === 'function')
          return (...args: unknown[]) => {
            requireCurrent();
            const result = Reflect.apply(value, target, args);
            requireCurrent();
            return key === 'registerDialog' && result && typeof result === 'object'
              ? wrap(result)
              : result;
          };
        return value && typeof value === 'object' ? wrap(value) : value;
      },
    });
  return wrap(api) as ExtensionAPI;
}

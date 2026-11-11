import {
  needsClientUpdate,
  type ExtensionManifest,
  type ExtensionRecordPublic,
  type ExtensionModule,
  type SecretDeclaration,
  type SettingDeclaration,
} from '@dorkos/extension-api';
import { createExtensionAPI } from './extension-api-factory';
import type { ExtensionAPIDeps, LoadedExtension } from './types';
import { createElement } from 'react';
import { ManifestSettingsPanel, ManifestSettingsIcon } from '../ui/ManifestSettingsPanel';
import { extensionApiUrl } from './extension-api-url';
import { setExtensionClientState } from '@/layers/shared/lib/extension-client-state';
import { setExtensionNames } from '@/layers/shared/lib/extension-names';
import { ExtensionLoadFailure } from '../ui/ExtensionLoadFailure';
import { importExtensionModule } from './extension-bundle-import';
import { AppNeedsUpdateNotice, runningCopiesOnly } from '@/layers/entities/extension';

/**
 * Fetch the extension list from the server.
 *
 * Returns `null` when the server refuses or fails the request, so a caller can
 * tell "the list could not be read" from "there are no extensions". A network
 * error still rejects.
 */
async function fetchExtensions(): Promise<ExtensionRecordPublic[] | null> {
  const res = await fetch(extensionApiUrl('/extensions'));
  if (!res.ok) {
    console.error('[extensions] Failed to fetch extension list:', res.status);
    return null;
  }
  return runningCopiesOnly((await res.json()) as ExtensionRecordPublic[]);
}

/**
 * Fetch the extension list from the server, rejecting on an HTTP error status.
 *
 * Used by {@link ExtensionLoader.reloadAll}, whose fetch-then-swap contract
 * needs a failed fetch to be distinguishable from a genuinely empty extension
 * set — an empty array must mean "this cwd has no extensions", never "the
 * request failed".
 */
async function fetchExtensionsOrThrow(): Promise<ExtensionRecordPublic[]> {
  const res = await fetch(extensionApiUrl('/extensions'));
  if (!res.ok) {
    throw new Error(`Failed to fetch extension list: ${res.status}`);
  }
  return runningCopiesOnly((await res.json()) as ExtensionRecordPublic[]);
}

/** Maximum wait for one local bundle, including a cold load of a large app. */
export const EXTENSION_IMPORT_TIMEOUT_MS = 15_000;

/** Import one bundle, returning null on failure or timeout. */
async function importBundle(
  id: string,
  cacheBust: boolean,
  manifest: ExtensionManifest
): Promise<ExtensionModule | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Local bundles can be large; 15 seconds allows a cold load without letting
    // a top-level await hold the app forever. Import cannot be cancelled: the
    // race discards late results, and only this settled result may activate.
    return await Promise.race([
      importExtensionModule(
        extensionApiUrl(`/extensions/${id}/bundle${cacheBust ? `?t=${Date.now()}` : ''}`),
        manifest
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Bundle import timed out')),
          EXTENSION_IMPORT_TIMEOUT_MS
        );
      }),
    ]);
  } catch (err) {
    console.error(`[extensions] Failed to ${cacheBust ? 'hot-reload' : 'import'} ${id}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run an extension's registration cleanups, logging any that throw so the rest
 * still run.
 *
 * @param id - The extension, for the log.
 * @param cleanups - The unsubscribe functions its registrations returned.
 */
function runCleanups(id: string, cleanups: ReadonlyArray<() => void>): void {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[extensions] Error in cleanup for ${id}:`, err);
    }
  }
}

/**
 * Signal the server to initialize the server-side component of an extension.
 *
 * This is a fire-and-forget coordination signal for dynamic enable/reload
 * scenarios. Failures are logged but never block client-side activation.
 */
async function initServerExtension(rec: ExtensionRecordPublic): Promise<void> {
  if (!rec.hasServerEntry && !rec.hasDataProxy) return;

  try {
    const res = await fetch(extensionApiUrl(`/extensions/${rec.id}/init-server`), {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: 'Unknown error' }));
      console.warn(
        `[extensions] Server init failed for ${rec.id}:`,
        (body as { error?: string }).error ?? res.statusText
      );
    }
  } catch (err) {
    console.error(`[extensions] Server init error for ${rec.id}:`, err);
  }
}

/**
 * Handles the client-side extension lifecycle: fetch the extension list,
 * dynamically import compiled bundles, activate extensions with their API
 * objects, and track loaded extensions for cleanup.
 *
 * Each extension receives its own `ExtensionAPI` instance constructed by
 * the factory. Activation errors are isolated — one bad extension cannot
 * prevent others from loading.
 */
export class ExtensionLoader {
  private loaded: Map<string, LoadedExtension> = new Map();
  private readonly deps: ExtensionAPIDeps;
  private failedSettings = new Map<string, () => void>();
  private attempts = new Map<string, number>();
  private nextAttempt = 0;
  /**
   * Set by {@link deactivateAll} to prevent a stale loader from completing
   * async work after React StrictMode unmounts the owning component.
   */
  private disposed = false;
  /**
   * Full loads increment this token, so a cwd switch supersedes every old
   * import. Targeted reloads use per-app attempt tokens instead: retrying one
   * app must not strand another app that is still loading.
   */
  private generation = 0;

  constructor(deps: ExtensionAPIDeps) {
    this.deps = deps;
  }

  /**
   * Fetch the extension list, import compiled bundles in parallel, and activate.
   *
   * @returns All discovered extension records, the map of successfully loaded
   *   extensions, and whether the list itself could not be read (`failed`), so
   *   the caller never mistakes a refused list for an empty one
   */
  async initialize(): Promise<{
    extensions: ExtensionRecordPublic[];
    loaded: Map<string, LoadedExtension>;
    failed: boolean;
  }> {
    // Claim this load; any newer load supersedes it.
    const gen = ++this.generation;

    const extensions = await fetchExtensions();
    if (extensions === null) return { extensions: [], loaded: this.loaded, failed: true };
    return { ...(await this.activateFrom(extensions, gen)), failed: false };
  }

  /**
   * Import and activate every ready extension from a pre-fetched list.
   *
   * Shared by {@link initialize} (initial load) and {@link reloadAll} (cwd
   * switch), which fetch the list themselves so each can apply its own error
   * policy before any activation happens.
   *
   * @param extensions - The extension records to load from
   * @param gen - The generation this load claimed on entry; activation stops
   *   if a newer load has claimed a later generation in the meantime
   * @param cacheBust - Import a fresh URL when retrying.
   * @param requestedAttempts - Tokens of the individual apps being retried.
   * @returns The provided extension list and the map of loaded extensions
   */
  private async activateFrom(
    extensions: ExtensionRecordPublic[],
    gen: number,
    cacheBust = false,
    requestedAttempts?: ReadonlyMap<string, number>
  ): Promise<{ extensions: ExtensionRecordPublic[]; loaded: Map<string, LoadedExtension> }> {
    if (this.disposed || gen !== this.generation) return { extensions, loaded: this.loaded };
    // Retry uses exactly the same readiness and approval check as first load.
    // The server still verifies the exact bytes before serving any bundle.
    const ready = extensions.filter(
      (ext) => ext.status === 'compiled' && ext.bundleReady && ext.approvedToRun
    );
    if (ready.length === 0) {
      console.log('[extensions] No extensions to load');
      return { extensions, loaded: this.loaded };
    }
    const activated: string[] = [];
    await Promise.all(
      ready.map(async (rec) => {
        const attempt = requestedAttempts?.get(rec.id) ?? ++this.nextAttempt;
        if (requestedAttempts && this.attempts.get(rec.id) !== attempt) return;
        this.attempts.set(rec.id, attempt);
        if (needsClientUpdate(rec.manifest)) {
          // No code of this app is ever fetched; its tile, page and Settings
          // row say it needs an update, from the record alone.
          this.markNeedsUpdate(rec);
          return;
        }
        setExtensionClientState(rec.id, 'starting');
        const module = await importBundle(rec.id, cacheBust, rec.manifest);
        if (this.disposed || gen !== this.generation || this.attempts.get(rec.id) !== attempt)
          return;
        this.failedSettings.get(rec.id)?.();
        this.failedSettings.delete(rec.id);
        if (!module) {
          this.markFailed(rec);
          return;
        }
        const { api, cleanups } = createExtensionAPI(
          rec.id,
          this.deps,
          rec.manifest.capabilities?.events ?? []
        );
        try {
          const deactivate = await module.activate(api);
          if (this.disposed || gen !== this.generation || this.attempts.get(rec.id) !== attempt) {
            if (typeof deactivate === 'function') deactivate();
            runCleanups(rec.id, cleanups);
            return;
          }
          this.autoRegisterConfigTab(rec, cleanups);
          this.loaded.set(rec.id, {
            id: rec.id,
            manifest: rec.manifest,
            module,
            api,
            cleanups,
            deactivate: typeof deactivate === 'function' ? deactivate : undefined,
          });
          setExtensionClientState(rec.id, 'ready');
          activated.push(rec.manifest.name + ' v' + rec.manifest.version);
          // A coordination signal, never a reason to hold back registered screens.
          void initServerExtension(rec);
        } catch (err) {
          console.error(`[extensions] Failed to activate ${rec.id}:`, err);
          runCleanups(rec.id, cleanups);
          this.markFailed(rec);
        }
      })
    );
    if (activated.length > 0) console.log('[extensions] Activated: ' + activated.join(', '));
    return { extensions, loaded: this.loaded };
  }

  /**
   * An app built for an older extension API keeps the right-panel tab it
   * declares, saying in the same words as its tile that it needs an update, so
   * the tab never vanishes or shows an empty frame (DOR-3293).
   */
  private markNeedsUpdate(rec: ExtensionRecordPublic): void {
    this.failedSettings.get(rec.id)?.();
    this.failedSettings.delete(rec.id);
    if (rec.manifest.contributions?.['right-panel'] !== true) return;
    const name = rec.manifest.name;
    const unsubscribe = this.deps.registry.register('right-panel', {
      id: `${rec.id}:needs-update`,
      priority: 100,
      title: name,
      component: () => createElement(AppNeedsUpdateNotice, { name, className: 'p-4' }),
      extensionId: rec.id,
    });
    this.failedSettings.set(rec.id, unsubscribe);
  }

  /** Keep a failed app visible in its own Settings section, with a bounded retry. */
  private markFailed(rec: ExtensionRecordPublic): void {
    this.failedSettings.get(rec.id)?.();
    setExtensionClientState(rec.id, 'error');
    const unsubscribe = this.deps.registry.register('settings.tabs', {
      id: `${rec.id}:load-error`,
      label: rec.manifest.name,
      group: 'Apps',
      component: () =>
        createElement(ExtensionLoadFailure, {
          retry: () => this.reloadExtensions([rec.id]),
        }),
    });
    this.failedSettings.set(rec.id, unsubscribe);
  }

  /**
   * Permanently dispose the loader: mark it disposed (so any in-flight
   * {@link initialize} stops activating) and tear down every loaded extension
   * via {@link teardownLoaded}. Used as the owning component's unmount cleanup.
   */
  deactivateAll(): void {
    this.disposed = true;
    this.teardownLoaded();
  }

  /**
   * Swap the loaded extension set for the server's current one (fetch-then-swap).
   *
   * The new working directory's extension list is fetched FIRST; only once it
   * resolves does the loader tear down the current extensions (running each
   * cleanup, so all registry contributions and event/state subscriptions are
   * removed) and import + activate the fresh set. A failed fetch rejects before
   * any teardown, leaving every current extension live and registered — the
   * caller reports the error and the UI keeps the previous set instead of
   * ending up with empty slots. Slot hosts observe the contributions leave the
   * reactive registry and return, so extension components remount cleanly with
   * no state carried over from the previous working directory.
   *
   * Bundles are imported without cache-busting on purpose: a cwd switch changes
   * WHICH extensions load, not their compiled content — recompile-driven
   * cache-busting belongs to the SSE hot-reload path ({@link reloadExtensions}).
   *
   * Used by the CWD sync when the working directory changes and its scoped
   * extension set differs — a live swap that replaces the old page reload.
   *
   * @returns The refreshed extension list and the map of re-activated extensions
   */
  async reloadAll(): Promise<{
    extensions: ExtensionRecordPublic[];
    loaded: Map<string, LoadedExtension>;
  }> {
    // Claim this load; any newer load supersedes it.
    const gen = ++this.generation;

    // Fetch-then-swap: resolve the new set before touching the current one.
    const extensions = await fetchExtensionsOrThrow();

    // Superseded while fetching (rapid cwd switch) — the newer load owns the
    // teardown and activation now; touch nothing.
    if (this.disposed || gen !== this.generation) {
      return { extensions, loaded: this.loaded };
    }
    // DorkOS's own names for its apps, for surfaces that say which app did something.
    setExtensionNames(Object.fromEntries(extensions.map((ext) => [ext.id, ext.manifest.name])));

    this.teardownLoaded();
    return this.activateFrom(extensions, gen);
  }

  /**
   * Deactivate every loaded extension and empty the loaded map.
   *
   * Calls each extension's optional `deactivate()` first, then runs all
   * registered cleanup functions. Errors in individual teardowns are caught and
   * logged so they cannot prevent the remaining extensions from being torn down.
   * Shared by {@link deactivateAll} and {@link reloadAll}; does not touch the
   * `disposed` flag, so a reload can re-activate afterwards.
   */
  private teardownLoaded(): void {
    for (const [id, ext] of this.loaded) {
      try {
        ext.deactivate?.();
      } catch (err) {
        console.error(`[extensions] Error calling deactivate for ${id}:`, err);
      }

      runCleanups(id, ext.cleanups);
    }

    this.loaded.clear();
    for (const cleanup of this.failedSettings.values()) cleanup();
    this.failedSettings.clear();
    for (const id of this.attempts.keys()) setExtensionClientState(id, undefined);
    this.attempts.clear();
  }

  /**
   * Hot-reload specific extensions: deactivate, re-import, and reactivate.
   *
   * Extensions not in the provided list are untouched — their state and
   * registrations are preserved. Cache busting is achieved by appending
   * `?t=${Date.now()}` to the bundle URL, which forces fresh ESM evaluation
   * even when the server sets `Cache-Control: no-store`.
   *
   * @param ids - Extension IDs to reload
   * @returns Updated loaded map and refreshed extension list
   */
  async reloadExtensions(ids: string[]): Promise<{
    extensions: ExtensionRecordPublic[];
    loaded: Map<string, LoadedExtension>;
  }> {
    // A retry supersedes only its own apps. A full cwd swap still invalidates
    // this load through generation, including while its list fetch is pending.
    const gen = this.generation;
    const requestedAttempts = new Map(
      ids.map((id) => {
        const attempt = ++this.nextAttempt;
        this.attempts.set(id, attempt);
        return [id, attempt] as const;
      })
    );

    // 1. Deactivate only the specified extensions
    for (const id of ids) {
      const ext = this.loaded.get(id);
      if (ext) {
        try {
          ext.deactivate?.();
        } catch (err) {
          console.error(`[extensions] Error deactivating ${id}:`, err);
        }

        runCleanups(id, ext.cleanups);

        this.loaded.delete(id);
      }
    }

    // Fetch before importing: a retry never reuses an earlier approval answer.
    const extensions = (await fetchExtensions()) ?? [];
    if (this.disposed || gen !== this.generation) return { extensions, loaded: this.loaded };
    for (const id of ids) {
      if (this.attempts.get(id) !== requestedAttempts.get(id)) continue;
      this.failedSettings.get(id)?.();
      this.failedSettings.delete(id);
    }
    await this.activateFrom(
      extensions.filter((record) => ids.includes(record.id)),
      gen,
      true,
      requestedAttempts
    );
    return { extensions, loaded: this.loaded };
  }

  /** Return the map of all currently loaded extensions. */
  getLoaded(): Map<string, LoadedExtension> {
    return this.loaded;
  }

  /**
   * Auto-register a host-generated settings tab for extensions that declare
   * secrets or settings in their manifest. This gives extension authors a
   * polished UI using the design system — zero settings code required.
   *
   * Called after `module.activate(api)` so the extension can override by
   * registering its own tab with the same ID (idempotent registry replaces).
   */
  private autoRegisterConfigTab(rec: ExtensionRecordPublic, cleanups: Array<() => void>): void {
    const secrets = rec.manifest.serverCapabilities?.secrets;
    const settings = rec.manifest.serverCapabilities?.settings;
    if (!secrets?.length && !settings?.length) return;

    const extensionId = rec.id;
    const tabId = `${extensionId}:settings`;
    const frozenSecrets: SecretDeclaration[] = secrets ?? [];
    const frozenSettings: SettingDeclaration[] = settings ?? [];

    const unsub = this.deps.registry.register('settings.tabs', {
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
}

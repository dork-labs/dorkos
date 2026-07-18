import type {
  ExtensionRecordPublic,
  ExtensionModule,
  SecretDeclaration,
  SettingDeclaration,
} from '@dorkos/extension-api';
import { createExtensionAPI } from './extension-api-factory';
import type { ExtensionAPIDeps, LoadedExtension } from './types';
import { createElement } from 'react';
import { ManifestSettingsPanel, ManifestSettingsIcon } from '../ui/ManifestSettingsPanel';
import { extensionApiUrl } from './extension-api-url';

/**
 * Fetch the extension list from the server.
 *
 * Returns an empty array on network or server errors so callers can
 * proceed safely without extensions.
 */
async function fetchExtensions(): Promise<ExtensionRecordPublic[]> {
  const res = await fetch(extensionApiUrl('/extensions'));
  if (!res.ok) {
    console.error('[extensions] Failed to fetch extension list:', res.status);
    return [];
  }
  return res.json() as Promise<ExtensionRecordPublic[]>;
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
  return res.json() as Promise<ExtensionRecordPublic[]>;
}

/**
 * Dynamically import a compiled extension bundle from the server.
 *
 * Returns `null` on import failure so the caller can skip and report the error.
 */
async function importBundle(id: string): Promise<ExtensionModule | null> {
  try {
    return (await import(
      /* @vite-ignore */ extensionApiUrl(`/extensions/${id}/bundle`)
    )) as ExtensionModule;
  } catch (err) {
    console.error(`[extensions] Failed to import ${id}:`, err);
    return null;
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

/** Result of a single bundle load attempt. */
interface BundleResult {
  rec: ExtensionRecordPublic;
  module: ExtensionModule | null;
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
  /**
   * Set by {@link deactivateAll} to prevent a stale loader from completing
   * async work after React StrictMode unmounts the owning component.
   */
  private disposed = false;
  /**
   * Monotonic load token. Every load path — {@link initialize},
   * {@link reloadAll}, and {@link reloadExtensions} — claims the current value
   * on entry by incrementing it, so starting any load supersedes all older
   * in-flight loads. A superseded load stops activating instead of registering
   * contributions that a newer load (e.g. a cwd switch) has made stale.
   */
  private generation = 0;

  constructor(deps: ExtensionAPIDeps) {
    this.deps = deps;
  }

  /**
   * Fetch the extension list, import compiled bundles in parallel, and activate.
   *
   * @returns All discovered extension records and the map of successfully loaded extensions
   */
  async initialize(): Promise<{
    extensions: ExtensionRecordPublic[];
    loaded: Map<string, LoadedExtension>;
  }> {
    // Claim this load; any newer load supersedes it.
    const gen = ++this.generation;

    const extensions = await fetchExtensions();
    return this.activateFrom(extensions, gen);
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
   * @returns The provided extension list and the map of loaded extensions
   */
  private async activateFrom(
    extensions: ExtensionRecordPublic[],
    gen: number
  ): Promise<{
    extensions: ExtensionRecordPublic[];
    loaded: Map<string, LoadedExtension>;
  }> {
    // Only load extensions that have been compiled and have a ready bundle.
    const ready = extensions.filter((ext) => ext.status === 'compiled' && ext.bundleReady);

    if (ready.length === 0) {
      console.log('[extensions] No extensions to load');
      return { extensions, loaded: this.loaded };
    }

    // Load all bundles in parallel to minimise startup time.
    const bundleResults: BundleResult[] = await Promise.all(
      ready.map(
        async (rec): Promise<BundleResult> => ({
          rec,
          module: await importBundle(rec.id),
        })
      )
    );

    const activated: string[] = [];

    const serverInits: Promise<void>[] = [];

    for (const { rec, module } of bundleResults) {
      // Stop activating if this load was torn down (deactivateAll on a
      // StrictMode unmount) or superseded by a newer load (reloadAll on a rapid
      // CWD switch) while the async work was in flight — otherwise we would
      // register stale contributions from a previous working directory.
      if (this.disposed || gen !== this.generation) break;

      if (!module) {
        // importBundle already logged the error; nothing more to do here.
        continue;
      }

      try {
        const { api, cleanups } = createExtensionAPI(
          rec.id,
          this.deps,
          rec.manifest.capabilities?.events ?? []
        );
        const deactivateFn = module.activate(api);

        // Auto-register a secrets settings tab from the manifest if the
        // extension didn't register one itself. This gives extension authors
        // a polished settings UI for free — zero code required.
        this.autoRegisterConfigTab(rec, cleanups);

        const loaded: LoadedExtension = {
          id: rec.id,
          manifest: rec.manifest,
          module,
          api,
          cleanups,
          deactivate: typeof deactivateFn === 'function' ? deactivateFn : undefined,
        };

        this.loaded.set(rec.id, loaded);
        activated.push(`${rec.manifest.name} v${rec.manifest.version}`);

        // After client-side activation succeeds, signal the server to
        // initialize its side. Non-blocking — failures are logged only.
        serverInits.push(initServerExtension(rec));
      } catch (err) {
        console.error(`[extensions] Failed to activate ${rec.id}:`, err);
      }
    }

    await Promise.all(serverInits);

    if (activated.length > 0) {
      console.log(`[extensions] Activated: ${activated.join(', ')}`);
    }

    // If this load was superseded mid-flight, `extensions` reflects the fetch
    // this load performed, not necessarily the newest one — the returned list is
    // best-effort context state; the TanStack extension-list query (invalidated
    // by every reload caller) is the source of truth for list consumers. The
    // `loaded` map is the loader's single live instance, so it is always current.
    return { extensions, loaded: this.loaded };
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

      for (const cleanup of ext.cleanups) {
        try {
          cleanup();
        } catch (err) {
          console.error(`[extensions] Error in cleanup for ${id}:`, err);
        }
      }
    }

    this.loaded.clear();
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
    // Claim this load; any newer load supersedes it. Without this, an
    // SSE-triggered reload that was awaiting its fetch when a cwd-switch
    // reloadAll() ran would resurrect the pre-switch extensions into the
    // fresh set.
    const gen = ++this.generation;

    // 1. Deactivate only the specified extensions
    for (const id of ids) {
      const ext = this.loaded.get(id);
      if (ext) {
        try {
          ext.deactivate?.();
        } catch (err) {
          console.error(`[extensions] Error deactivating ${id}:`, err);
        }

        for (const cleanup of ext.cleanups) {
          try {
            cleanup();
          } catch (err) {
            console.error(`[extensions] Error in cleanup for ${id}:`, err);
          }
        }

        this.loaded.delete(id);
      }
    }

    // 2. Fetch updated extension list from server
    const extensions = await fetchExtensions();

    // 3. Re-import and reactivate the specified extensions
    for (const id of ids) {
      // Stop reactivating if a newer load (cwd-switch reloadAll, unmount) has
      // superseded this one — it owns the loaded map now.
      if (this.disposed || gen !== this.generation) break;

      const rec = extensions.find((e) => e.id === id);
      if (!rec || rec.status !== 'compiled' || !rec.bundleReady) {
        continue;
      }

      try {
        // Cache-bust: append timestamp to force fresh ESM module evaluation.
        // The browser's module registry keys by URL, so a new query string
        // yields a new module instance distinct from the pre-reload one.
        const module = (await import(
          /* @vite-ignore */ extensionApiUrl(`/extensions/${id}/bundle?t=${Date.now()}`)
        )) as ExtensionModule;

        // Re-check after the import await — a newer load may have started
        // while the bundle was in flight.
        if (this.disposed || gen !== this.generation) break;

        const { api, cleanups } = createExtensionAPI(id, this.deps);
        const deactivateFn = module.activate(api);

        this.autoRegisterConfigTab(rec, cleanups);

        this.loaded.set(id, {
          id,
          manifest: rec.manifest,
          module,
          api,
          cleanups,
          deactivate: typeof deactivateFn === 'function' ? deactivateFn : undefined,
        });

        // Signal server init after successful client-side reactivation.
        await initServerExtension(rec);

        console.log(`[extensions] Hot-reloaded: ${rec.manifest.name} v${rec.manifest.version}`);
      } catch (err) {
        console.error(`[extensions] Failed to hot-reload ${id}:`, err);
      }
    }

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
    });

    cleanups.push(unsub);
  }
}

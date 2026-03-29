import type {
  ExtensionRecordPublic,
  ExtensionModule,
  SecretDeclaration,
} from '@dorkos/extension-api';
import { createExtensionAPI } from './extension-api-factory';
import type { ExtensionAPIDeps, LoadedExtension } from './types';
import { createElement } from 'react';
import { ManifestSecretsPanel, ManifestSecretsIcon } from '../ui/ManifestSecretsPanel';

/**
 * Fetch the extension list from the server.
 *
 * Returns an empty array on network or server errors so callers can
 * proceed safely without extensions.
 */
async function fetchExtensions(): Promise<ExtensionRecordPublic[]> {
  const res = await fetch('/api/extensions');
  if (!res.ok) {
    console.error('[extensions] Failed to fetch extension list:', res.status);
    return [];
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
    return (await import(/* @vite-ignore */ `/api/extensions/${id}/bundle`)) as ExtensionModule;
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
    const res = await fetch(`/api/extensions/${rec.id}/init-server`, {
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
    const extensions = await fetchExtensions();

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
      // If deactivateAll() was called (e.g. React StrictMode unmount) while
      // the async initialize was in flight, stop activating further extensions.
      if (this.disposed) break;

      if (!module) {
        // importBundle already logged the error; nothing more to do here.
        continue;
      }

      try {
        const { api, cleanups } = createExtensionAPI(rec.id, this.deps);
        const deactivateFn = module.activate(api);

        // Auto-register a secrets settings tab from the manifest if the
        // extension didn't register one itself. This gives extension authors
        // a polished settings UI for free — zero code required.
        this.autoRegisterSecretsTab(rec, cleanups);

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

    return { extensions, loaded: this.loaded };
  }

  /**
   * Deactivate all loaded extensions.
   *
   * Calls each extension's optional `deactivate()` function first, then runs
   * all registered cleanup functions. Errors in individual cleanups are caught
   * and logged so they cannot prevent the remaining extensions from being torn down.
   */
  deactivateAll(): void {
    this.disposed = true;

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
      const rec = extensions.find((e) => e.id === id);
      if (!rec || rec.status !== 'compiled' || !rec.bundleReady) {
        continue;
      }

      try {
        // Cache-bust: append timestamp to force fresh ESM module evaluation.
        // The browser's module registry keys by URL, so a new query string
        // yields a new module instance distinct from the pre-reload one.
        const module = (await import(
          /* @vite-ignore */ `/api/extensions/${id}/bundle?t=${Date.now()}`
        )) as ExtensionModule;

        const { api, cleanups } = createExtensionAPI(id, this.deps);
        const deactivateFn = module.activate(api);

        this.autoRegisterSecretsTab(rec, cleanups);

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
   * secrets in their manifest. This gives extension authors a polished UI
   * using the design system — zero settings code required.
   *
   * Called after `module.activate(api)` so the extension can override by
   * registering its own tab with the same ID (idempotent registry replaces).
   */
  private autoRegisterSecretsTab(rec: ExtensionRecordPublic, cleanups: Array<() => void>): void {
    const secrets = rec.manifest.serverCapabilities?.secrets;
    if (!secrets?.length) return;

    const extensionId = rec.id;
    const tabId = `${extensionId}:settings`;
    const frozenSecrets: SecretDeclaration[] = secrets;

    const unsub = this.deps.registry.register('settings.tabs', {
      id: tabId,
      label: rec.manifest.name,
      icon: ManifestSecretsIcon,
      component: function AutoSecretsTab() {
        return createElement(ManifestSecretsPanel, {
          extensionId,
          secrets: frozenSecrets,
        });
      },
      priority: 90,
    });

    cleanups.push(unsub);
  }
}

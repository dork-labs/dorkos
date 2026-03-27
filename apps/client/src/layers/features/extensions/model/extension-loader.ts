import type { ExtensionRecordPublic, ExtensionModule } from '@dorkos/extension-api';
import { createExtensionAPI } from './extension-api-factory';
import type { ExtensionAPIDeps, LoadedExtension } from './types';

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

    for (const { rec, module } of bundleResults) {
      if (!module) {
        // importBundle already logged the error; nothing more to do here.
        continue;
      }

      try {
        const { api, cleanups } = createExtensionAPI(rec.id, this.deps);
        const deactivateFn = module.activate(api);

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
      } catch (err) {
        console.error(`[extensions] Failed to activate ${rec.id}:`, err);
      }
    }

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

  /** Return the map of all currently loaded extensions. */
  getLoaded(): Map<string, LoadedExtension> {
    return this.loaded;
  }
}

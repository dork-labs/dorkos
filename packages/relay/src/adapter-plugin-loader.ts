/**
 * Dynamic adapter plugin loader.
 *
 * Loads RelayAdapter instances from three sources:
 * 1. Built-in adapters (from a provided factory map)
 * 2. npm packages (via dynamic import)
 * 3. Local file paths (via dynamic import with pathToFileURL)
 *
 * Loading errors are non-fatal — logs a warning and skips the failing adapter.
 *
 * @module relay/adapter-plugin-loader
 */
import { pathToFileURL } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { AdapterManifestSchema } from '@dorkos/shared/relay-schemas';
import type { Logger } from '@dorkos/shared/logger';
import type { RelayAdapter } from './types.js';
import { RELAY_ADAPTER_API_VERSION } from './version.js';

/** Configuration entry for a single adapter to load. */
export interface PluginAdapterConfig {
  id: string;
  type: string;
  enabled?: boolean;
  builtin?: boolean;
  plugin?: { package?: string; path?: string };
  config: Record<string, unknown>;
}

/** Expected module shape from a plugin package. */
export interface AdapterPluginModule {
  default: (id: string, config: Record<string, unknown>) => RelayAdapter;
  getManifest?: () => AdapterManifest;
}

/** Result of loading an adapter, including optional manifest metadata. */
export interface LoadedAdapter {
  adapter: RelayAdapter;
  manifest?: AdapterManifest;
}

/**
 * Load adapter instances from config entries.
 *
 * Handles three sources:
 * 1. builtin: true — imported from built-in adapter map
 * 2. plugin.package — dynamic import(packageName)
 * 3. plugin.path — dynamic import(pathToFileURL(absolutePath))
 *
 * Loading errors are non-fatal — logs and skips.
 *
 * @param configs - Array of adapter configuration entries
 * @param builtinMap - Map of type string to factory function for built-in adapters
 * @param configDir - Base directory for resolving relative plugin paths
 * @returns Array of successfully loaded adapter instances with optional manifests
 */
export async function loadAdapters(
  configs: PluginAdapterConfig[],
  builtinMap: Map<string, (id: string, config: Record<string, unknown>) => RelayAdapter>,
  configDir: string,
  logger: Logger = console
): Promise<LoadedAdapter[]> {
  const results: LoadedAdapter[] = [];

  for (const entry of configs) {
    if (entry.enabled === false) continue;

    try {
      let adapter: RelayAdapter | null = null;
      let manifest: AdapterManifest | undefined;

      if (entry.builtin && builtinMap.has(entry.type)) {
        // Built-in adapter from the provided factory map
        // Built-in manifests are handled by AdapterManager, not plugin loader
        const factory = builtinMap.get(entry.type)!;
        adapter = factory(entry.id, entry.config);
      } else if (entry.plugin?.package) {
        // npm package via dynamic import
        const mod = (await import(entry.plugin.package)) as AdapterPluginModule;
        adapter = validateAndCreate(mod, entry);
        manifest = extractManifest(mod, entry, logger);
        if (manifest) checkApiVersion(manifest, entry.id, logger);
      } else if (entry.plugin?.path) {
        // Local file via dynamic import with pathToFileURL
        const absPath = isAbsolute(entry.plugin.path)
          ? entry.plugin.path
          : resolve(configDir, entry.plugin.path);
        const mod = (await import(pathToFileURL(absPath).href)) as AdapterPluginModule;
        adapter = validateAndCreate(mod, entry);
        manifest = extractManifest(mod, entry, logger);
        if (manifest) checkApiVersion(manifest, entry.id, logger);
      }

      if (adapter) {
        results.push({ adapter, manifest });
      }
    } catch (err) {
      // Non-fatal: log warning and continue loading remaining adapters
      logger.warn(`[PluginLoader] Failed to load adapter '${entry.id}':`, err);
    }
  }

  return results;
}

/**
 * Duck-type validate and create adapter from a loaded module.
 *
 * @param mod - The dynamically imported module
 * @param entry - The config entry for error reporting
 * @returns A validated RelayAdapter instance
 * @throws If the module doesn't export a default factory function
 */
function validateAndCreate(mod: unknown, entry: PluginAdapterConfig): RelayAdapter {
  const m = mod as Record<string, unknown>;
  if (typeof m.default !== 'function') {
    throw new Error(`Module for '${entry.id}' does not export a default factory function`);
  }
  const factory = m.default as (id: string, config: Record<string, unknown>) => RelayAdapter;
  const adapter = factory(entry.id, entry.config);
  validateAdapterShape(adapter, entry.id);
  return adapter;
}

/**
 * Extract and validate an AdapterManifest from a loaded plugin module.
 *
 * If the module exports `getManifest()`, calls it and validates with Zod.
 * Falls back to a minimal manifest generated from the config entry.
 *
 * @param mod - The dynamically imported module
 * @param entry - The config entry for fallback metadata
 * @returns A validated manifest, or a minimal fallback
 */
function extractManifest(
  mod: unknown,
  entry: PluginAdapterConfig,
  logger: Logger = console
): AdapterManifest | undefined {
  const m = mod as Record<string, unknown>;
  if (typeof m.getManifest === 'function') {
    try {
      const raw = (m.getManifest as () => unknown)();
      const parsed = AdapterManifestSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data;
      }
      logger.warn(
        `[PluginLoader] Manifest from '${entry.id}' failed validation:`,
        parsed.error.flatten()
      );
    } catch (err) {
      logger.warn(`[PluginLoader] Failed to get manifest from '${entry.id}':`, err);
    }
  }

  // Fallback: generate minimal manifest
  return {
    type: entry.type,
    displayName: entry.id,
    description: 'Custom adapter',
    category: 'custom',
    builtin: false,
    configFields: [],
    multiInstance: false,
  };
}

/**
 * Check the adapter's declared API version against the host version.
 *
 * Emits a warning-level log on major version mismatch (breaking change) or
 * when the adapter targets a newer minor version than the host supports.
 * Never throws — version mismatches produce warnings, not hard failures.
 * Modeled on VS Code's `engines.vscode` behavior.
 *
 * @param manifest - The adapter's manifest
 * @param adapterId - The adapter ID for log messages
 * @param logger - Logger instance
 */
function checkApiVersion(manifest: AdapterManifest, adapterId: string, logger: Logger): void {
  if (!manifest.apiVersion) return; // no version declared — skip check

  const [hostMajor, hostMinor] = RELAY_ADAPTER_API_VERSION.split('.').map(Number);
  const [adapterMajor, adapterMinor] = manifest.apiVersion.split('.').map(Number);

  if (hostMajor !== adapterMajor) {
    logger.warn(
      `[PluginLoader] Adapter '${adapterId}' targets API v${manifest.apiVersion} ` +
        `but host is v${RELAY_ADAPTER_API_VERSION} (major version mismatch)`
    );
  } else if (adapterMinor > hostMinor) {
    logger.warn(
      `[PluginLoader] Adapter '${adapterId}' targets API v${manifest.apiVersion} ` +
        `but host is v${RELAY_ADAPTER_API_VERSION} (adapter expects newer features)`
    );
  }
}

/**
 * Validate that an object implements the RelayAdapter interface shape.
 *
 * Uses duck-type checking to verify required properties and methods
 * exist without relying on TypeScript's structural typing at runtime.
 *
 * @param obj - The object to validate
 * @param id - The adapter ID for error messages
 * @throws If the object is missing required RelayAdapter members
 */
export function validateAdapterShape(obj: unknown, id: string): asserts obj is RelayAdapter {
  const a = obj as Record<string, unknown>;
  if (typeof a.id !== 'string') throw new Error(`Adapter '${id}': missing 'id' property`);
  if (typeof a.subjectPrefix !== 'string' && !Array.isArray(a.subjectPrefix))
    throw new Error(`Adapter '${id}': missing 'subjectPrefix'`);
  if (typeof a.displayName !== 'string') throw new Error(`Adapter '${id}': missing 'displayName'`);
  if (typeof a.start !== 'function') throw new Error(`Adapter '${id}': missing 'start()' method`);
  if (typeof a.stop !== 'function') throw new Error(`Adapter '${id}': missing 'stop()' method`);
  if (typeof a.deliver !== 'function')
    throw new Error(`Adapter '${id}': missing 'deliver()' method`);
  if (typeof a.getStatus !== 'function')
    throw new Error(`Adapter '${id}': missing 'getStatus()' method`);
}

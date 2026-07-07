/**
 * Adapter configuration file I/O, validation, masking, and hot-reload.
 *
 * Extracted from adapter-manager.ts to keep file sizes manageable.
 * All functions are stateless and operate on passed-in data.
 *
 * @module services/relay/adapter-config
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { z } from 'zod';
import type { AdapterConfig } from '@dorkos/relay';
import { AdaptersConfigFileSchema } from '@dorkos/shared/relay-schemas';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { logger } from '../../lib/logger.js';

/** Chokidar stability threshold before triggering hot-reload (ms). */
const CONFIG_STABILITY_THRESHOLD_MS = 150;

/** Chokidar poll interval for write-finish detection (ms). */
const CONFIG_POLL_INTERVAL_MS = 50;

/**
 * Adapter `type` values that once existed on disk but have since been removed
 * from the product. Stored configs carrying one of these types are dropped
 * (never registered) with a one-line migration hint, so a single retired
 * adapter never fails the whole config parse and takes every other adapter
 * down with it.
 */
const REMOVED_ADAPTER_TYPES: Record<string, string> = {
  'telegram-chatsdk':
    "the Telegram (Chat SDK) adapter was removed — re-create the adapter with type 'telegram'",
};

/**
 * Drop adapter entries whose `type` has been removed from the product,
 * logging a migration hint for each. Returns the parsed JSON with those
 * entries filtered out of `adapters`.
 *
 * Runs before schema validation so a retired type (no longer in the
 * `AdapterType` enum) does not fail the entire file parse.
 *
 * @param raw - The parsed (untyped) adapters config JSON
 * @returns The same object with removed-type adapters stripped
 */
function stripRemovedAdapterTypes(raw: unknown): unknown {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { adapters?: unknown }).adapters)
  ) {
    return raw;
  }
  const record = raw as { adapters: unknown[] };
  const kept = record.adapters.filter((entry) => {
    const type = (entry as { type?: unknown; id?: unknown })?.type;
    if (typeof type === 'string' && type in REMOVED_ADAPTER_TYPES) {
      const id = (entry as { id?: unknown }).id;
      const idSuffix = typeof id === 'string' ? ` '${id}'` : '';
      logger.warn(
        `[AdapterConfig] Ignoring removed adapter${idSuffix}: ${REMOVED_ADAPTER_TYPES[type]}`
      );
      return false;
    }
    return true;
  });
  return { ...record, adapters: kept };
}

/**
 * Read and parse the adapter config file.
 *
 * Handles missing file (empty adapter list) and malformed JSON (logs
 * warning and falls back to empty list). Never throws.
 *
 * @param configPath - Absolute path to adapters.json
 * @returns Parsed adapter configs, or empty array on failure
 */
export async function loadAdapterConfig(configPath: string): Promise<AdapterConfig[]> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    const sanitized = stripRemovedAdapterTypes(JSON.parse(raw));
    const parsed = AdaptersConfigFileSchema.safeParse(sanitized);
    if (parsed.success) {
      return parsed.data.adapters;
    } else {
      logger.warn(
        '[AdapterConfig] Malformed config, skipping invalid entries:',
        z.flattenError(parsed.error)
      );
      return [];
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config file = no adapters (not an error)
      return [];
    } else {
      logger.warn('[AdapterConfig] Failed to read config:', err);
      return [];
    }
  }
}

/**
 * Persist adapter configs to disk using atomic write (tmp + rename).
 *
 * Creates the parent directory if it does not exist.
 *
 * @param configPath - Absolute path to adapters.json
 * @param configs - The adapter configs to write
 */
export async function saveAdapterConfig(
  configPath: string,
  configs: AdapterConfig[]
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify({ adapters: configs }, null, 2), 'utf-8');
  await rename(tmpPath, configPath);
}

/**
 * Generate a default adapters.json with claude-code enabled when no config exists.
 *
 * Never throws -- failures are logged as warnings.
 *
 * @param configPath - Absolute path to adapters.json
 */
export async function ensureDefaultAdapterConfig(configPath: string): Promise<void> {
  try {
    await readFile(configPath, 'utf-8');
    // Config exists -- nothing to do
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const defaultConfig = {
        adapters: [
          {
            id: 'claude-code',
            type: 'claude-code',
            builtin: true,
            enabled: true,
            config: {
              maxConcurrent: 3,
              defaultTimeoutMs: 300_000,
            },
          },
        ],
      };
      try {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        logger.info('[AdapterConfig] Generated default adapters.json with claude-code adapter');
      } catch (writeErr) {
        logger.warn('[AdapterConfig] Failed to write default config:', writeErr);
      }
    }
  }
}

/**
 * Start watching the config file for changes to trigger hot-reload.
 *
 * Uses chokidar with awaitWriteFinish to debounce rapid writes.
 *
 * @param configPath - Absolute path to adapters.json
 * @param onChange - Callback invoked when the config file changes
 * @returns The FSWatcher instance for cleanup
 */
export function watchAdapterConfig(configPath: string, onChange: () => void): FSWatcher {
  const watcher = chokidar.watch(configPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: CONFIG_STABILITY_THRESHOLD_MS,
      pollInterval: CONFIG_POLL_INTERVAL_MS,
    },
  });

  watcher.on('change', onChange);
  return watcher;
}

/**
 * Mask password-type fields in an adapter config using the manifest definition.
 *
 * Supports dot-notation keys (e.g., `inbound.secret`) by traversing nested objects.
 *
 * @param config - The raw config object
 * @param manifest - The adapter manifest with field definitions
 * @returns A deep copy of config with password fields replaced by `'***'`
 */
export function maskSensitiveFields(
  config: Record<string, unknown>,
  manifest?: AdapterManifest
): Record<string, unknown> {
  if (!manifest) return config;
  const masked = structuredClone(config) as Record<string, unknown>;
  for (const field of manifest.configFields) {
    if (field.type !== 'password') continue;
    const parts = field.key.split('.');
    let current: Record<string, unknown> = masked;
    let found = true;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] && typeof current[parts[i]] === 'object') {
        current = current[parts[i]] as Record<string, unknown>;
      } else {
        found = false;
        break;
      }
    }
    const lastKey = parts.at(-1)!;
    if (found && lastKey in current) {
      current[lastKey] = '***';
    }
  }
  return masked;
}

/**
 * Merge incoming config with existing, preserving password fields when masked or empty.
 *
 * @param existing - The current config values
 * @param incoming - The new config values to merge
 * @param manifest - The adapter manifest with field definitions
 * @returns Merged config with password fields preserved when appropriate
 */
export function mergeWithPasswordPreservation(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  manifest?: AdapterManifest
): Record<string, unknown> {
  const result = { ...existing, ...incoming };
  if (!manifest) return result;

  for (const field of manifest.configFields) {
    if (field.type !== 'password') continue;
    const parts = field.key.split('.');
    const incomingValue = getNestedValue(incoming, parts);
    if (incomingValue === '' || incomingValue === '***' || incomingValue === undefined) {
      const existingValue = getNestedValue(existing, parts);
      if (existingValue !== undefined) {
        setNestedValue(result, parts, existingValue);
      }
    }
  }
  return result;
}

/** Traverse a nested object using dot-notation key parts. */
function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Set a value in a nested object using dot-notation key parts, creating intermediates. */
function setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

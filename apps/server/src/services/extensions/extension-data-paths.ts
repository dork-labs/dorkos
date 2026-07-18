/**
 * Scope-aware path resolution for per-extension data storage.
 *
 * A single scope-aware base directory backs every per-extension store: the
 * legacy JSON blob (`data.json`) and the SQLite database (`store.db`) sit side
 * by side inside it. Callers derive the concrete file path from the base so the
 * scope logic lives in exactly one place.
 *
 * `dorkHome` is always threaded in (Hard Rule 3 — `os.homedir()` is banned).
 *
 * @module services/extensions/extension-data-paths
 */
import path from 'path';
import type { ExtensionManager } from './extension-manager.js';

/** Filename of the legacy whole-blob JSON store, inside the per-extension data dir. */
const BLOB_FILENAME = 'data.json';

/** Filename of the per-extension SQLite database, inside the per-extension data dir. */
const DB_FILENAME = 'store.db';

/**
 * Resolve the absolute per-extension data directory, scope-aware.
 *
 * Global extensions store under `{dorkHome}/extension-data/{id}`; local
 * (project-scoped) extensions store under `{cwd}/.dork/extension-data/{id}`.
 * Returns `null` when the extension record is unknown, or when a local
 * extension has no resolvable working directory.
 *
 * @param id - Extension identifier (validated `SAFE_EXT_ID` at the route boundary)
 * @param manager - ExtensionManager used to look up the extension's scope
 * @param dorkHome - Resolved DorkOS data directory (never `os.homedir()`)
 * @param getCwd - Returns the current working directory, or `null` if unset
 */
export function resolveExtensionDataDir(
  id: string,
  manager: ExtensionManager,
  dorkHome: string,
  getCwd: () => string | null
): string | null {
  const record = manager.get(id);
  if (!record) return null;

  if (record.scope === 'local') {
    const cwd = getCwd();
    if (!cwd) return null;
    return path.join(cwd, '.dork', 'extension-data', id);
  }

  return path.join(dorkHome, 'extension-data', id);
}

/**
 * Resolve the legacy JSON blob path (`{dataDir}/data.json`) for an extension.
 *
 * Byte-identical to the pre-refactor `resolveDataPath` for both scopes; returns
 * `null` under the same conditions as {@link resolveExtensionDataDir}.
 *
 * @param id - Extension identifier
 * @param manager - ExtensionManager used to look up the extension's scope
 * @param dorkHome - Resolved DorkOS data directory
 * @param getCwd - Returns the current working directory, or `null` if unset
 */
export function resolveBlobPath(
  id: string,
  manager: ExtensionManager,
  dorkHome: string,
  getCwd: () => string | null
): string | null {
  const dir = resolveExtensionDataDir(id, manager, dorkHome, getCwd);
  return dir === null ? null : path.join(dir, BLOB_FILENAME);
}

/**
 * Resolve the SQLite database path (`{dataDir}/store.db`) for an extension.
 *
 * Sits beside {@link resolveBlobPath} in the same scope-aware directory;
 * returns `null` under the same conditions as {@link resolveExtensionDataDir}.
 *
 * @param id - Extension identifier
 * @param manager - ExtensionManager used to look up the extension's scope
 * @param dorkHome - Resolved DorkOS data directory
 * @param getCwd - Returns the current working directory, or `null` if unset
 */
export function resolveDbPath(
  id: string,
  manager: ExtensionManager,
  dorkHome: string,
  getCwd: () => string | null
): string | null {
  const dir = resolveExtensionDataDir(id, manager, dorkHome, getCwd);
  return dir === null ? null : path.join(dir, DB_FILENAME);
}

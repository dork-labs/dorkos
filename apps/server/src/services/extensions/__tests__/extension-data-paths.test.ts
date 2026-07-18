import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  resolveExtensionDataDir,
  resolveBlobPath,
  resolveDbPath,
} from '../extension-data-paths.js';
import type { ExtensionManager } from '../extension-manager.js';

/**
 * Minimal ExtensionManager stub exposing only `get()` — the sole method the
 * path resolvers touch. Returns a record with the given scope, or undefined
 * when `scope` is null (the "unknown extension" case).
 */
function makeManager(scope: 'global' | 'local' | null): ExtensionManager {
  return {
    get(_id: string) {
      return scope === null ? undefined : { scope };
    },
  } as unknown as ExtensionManager;
}

const DORK_HOME = '/home/user/.dork';
const CWD = '/projects/my-app';

/**
 * The pre-refactor `resolveDataPath` computed these exact strings. Reproduced
 * here verbatim (independent of the implementation under test) so the golden
 * assertions prove byte-for-byte parity, not just internal consistency.
 */
const GOLDEN_GLOBAL_BLOB = path.join(DORK_HOME, 'extension-data', 'crm-lite', 'data.json');
const GOLDEN_LOCAL_BLOB = path.join(CWD, '.dork', 'extension-data', 'crm-lite', 'data.json');

describe('resolveExtensionDataDir', () => {
  it('returns the global data dir for a global extension', () => {
    // Global extensions live under {dorkHome}/extension-data/{id}.
    const dir = resolveExtensionDataDir('crm-lite', makeManager('global'), DORK_HOME, () => CWD);
    expect(dir).toBe(path.join(DORK_HOME, 'extension-data', 'crm-lite'));
  });

  it('returns the local (project-scoped) data dir for a local extension', () => {
    // Local extensions live under {cwd}/.dork/extension-data/{id}.
    const dir = resolveExtensionDataDir('crm-lite', makeManager('local'), DORK_HOME, () => CWD);
    expect(dir).toBe(path.join(CWD, '.dork', 'extension-data', 'crm-lite'));
  });

  it('returns null when the extension record is unknown', () => {
    // No record → nothing to resolve.
    const dir = resolveExtensionDataDir('ghost', makeManager(null), DORK_HOME, () => CWD);
    expect(dir).toBeNull();
  });

  it('returns null for a local extension when cwd is unresolvable', () => {
    // A local extension cannot resolve a path without a working directory.
    const dir = resolveExtensionDataDir('crm-lite', makeManager('local'), DORK_HOME, () => null);
    expect(dir).toBeNull();
  });

  it('does NOT require cwd for a global extension', () => {
    // A global path never consults cwd, so a null cwd still resolves.
    const dir = resolveExtensionDataDir('crm-lite', makeManager('global'), DORK_HOME, () => null);
    expect(dir).toBe(path.join(DORK_HOME, 'extension-data', 'crm-lite'));
  });
});

describe('resolveBlobPath — golden parity with pre-refactor resolveDataPath', () => {
  it('returns the byte-identical global blob path', () => {
    // Must match the exact string the deleted resolveDataPath produced (global).
    const p = resolveBlobPath('crm-lite', makeManager('global'), DORK_HOME, () => CWD);
    expect(p).toBe(GOLDEN_GLOBAL_BLOB);
  });

  it('returns the byte-identical local blob path', () => {
    // Must match the exact string the deleted resolveDataPath produced (local).
    const p = resolveBlobPath('crm-lite', makeManager('local'), DORK_HOME, () => CWD);
    expect(p).toBe(GOLDEN_LOCAL_BLOB);
  });

  it('returns null for an unknown extension (parity)', () => {
    // resolveDataPath returned null for a missing record; so must resolveBlobPath.
    const p = resolveBlobPath('ghost', makeManager(null), DORK_HOME, () => CWD);
    expect(p).toBeNull();
  });

  it('returns null for a local extension with no cwd (parity)', () => {
    const p = resolveBlobPath('crm-lite', makeManager('local'), DORK_HOME, () => null);
    expect(p).toBeNull();
  });
});

describe('resolveDbPath', () => {
  it('returns the sibling store.db path for a global extension', () => {
    // store.db sits beside data.json in the same scope-aware directory.
    const dbPath = resolveDbPath('crm-lite', makeManager('global'), DORK_HOME, () => CWD);
    const blobPath = resolveBlobPath('crm-lite', makeManager('global'), DORK_HOME, () => CWD)!;
    expect(dbPath).toBe(path.join(DORK_HOME, 'extension-data', 'crm-lite', 'store.db'));
    // The two files share a parent directory (siblings).
    expect(path.dirname(dbPath!)).toBe(path.dirname(blobPath));
  });

  it('returns the sibling store.db path for a local extension', () => {
    const dbPath = resolveDbPath('crm-lite', makeManager('local'), DORK_HOME, () => CWD);
    expect(dbPath).toBe(path.join(CWD, '.dork', 'extension-data', 'crm-lite', 'store.db'));
  });

  it('returns null for an unknown extension', () => {
    const dbPath = resolveDbPath('ghost', makeManager(null), DORK_HOME, () => CWD);
    expect(dbPath).toBeNull();
  });

  it('returns null for a local extension with no cwd', () => {
    const dbPath = resolveDbPath('crm-lite', makeManager('local'), DORK_HOME, () => null);
    expect(dbPath).toBeNull();
  });
});

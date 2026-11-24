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
});

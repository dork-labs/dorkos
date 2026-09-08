/**
 * The server's default working directory used to be a fixed three-hop climb
 * from this module's own directory, which landed on `<repo>/apps` rather than
 * `<repo>` (DOR-1859). Under `pnpm dev` — where nothing sets
 * `DORKOS_DEFAULT_CWD` — that was the directory every scheduled task with no
 * workspace binding started in, so tasks ran one level below the repo root and
 * saw none of it.
 *
 * The anchor below is deliberately independent of the code under test: it walks
 * up from THIS FILE's location by a hop count the directory layout fixes
 * (`__tests__` → `lib` → `src` → `server` → `apps` → repo root), so it stays
 * honest even if the resolver's own strategy changes again.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findWorkspaceRoot } from '../resolve-root.js';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../../../', import.meta.url)));
const SERVER_LIB_DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('findWorkspaceRoot', () => {
  it('resolves the repo root from the tsx source layout, not one level short', () => {
    // The source layout `pnpm dev` runs: apps/server/src/lib/.
    expect(SERVER_LIB_DIR).toBe(path.join(REPO_ROOT, 'apps', 'server', 'src', 'lib'));
    expect(findWorkspaceRoot(SERVER_LIB_DIR)).toBe(REPO_ROOT);
    // The old fixed climb produced this. Naming it keeps the regression legible.
    expect(findWorkspaceRoot(SERVER_LIB_DIR)).not.toBe(path.join(REPO_ROOT, 'apps'));
  });

  it('resolves the same root from the built dist layout', () => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), 'dorkos-root-'));
    writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    const distLib = path.join(root, 'apps', 'server', 'dist', 'lib');
    mkdirSync(distLib, { recursive: true });

    expect(findWorkspaceRoot(distLib)).toBe(root);
  });

  it('returns null when no workspace marker sits above the directory', () => {
    const orphan = mkdtempSync(path.join(realpathSync(tmpdir()), 'dorkos-orphan-'));
    expect(findWorkspaceRoot(orphan)).toBeNull();
  });
});

describe('DEFAULT_CWD', () => {
  it('falls back to the repo root when DORKOS_DEFAULT_CWD is unset', async () => {
    vi.stubEnv('DORKOS_DEFAULT_CWD', undefined);
    vi.resetModules();

    const { DEFAULT_CWD } = await import('../resolve-root.js');

    expect(DEFAULT_CWD).toBe(REPO_ROOT);
  });

  it('prefers DORKOS_DEFAULT_CWD when the environment sets one', async () => {
    vi.stubEnv('DORKOS_DEFAULT_CWD', '/somewhere/else');
    vi.resetModules();

    const { DEFAULT_CWD } = await import('../resolve-root.js');

    expect(DEFAULT_CWD).toBe('/somewhere/else');
  });
});

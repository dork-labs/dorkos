/**
 * Tests for {@link ShapeInstallFlow}.
 *
 * A Shape install *stages* the package but never *activates* it: inline
 * extensions compile (a malformed one aborts the install) yet nothing is
 * enabled, because turning extensions on is `applyShape`'s job (spec §6.1).
 * These tests prove: the Shape dir lands under `shapes/`, inline extensions are
 * compiled-but-not-enabled, a stage-phase compile failure rolls back with zero
 * residue, and an activate-phase failure (a forced `atomicMove` throw) restores
 * the previous install byte-for-byte via the file-scoped transaction (ADR-0304).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@dorkos/shared/logger';
import type { ShapePackageManifest } from '@dorkos/marketplace';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import { atomicMove } from '../../lib/atomic-move.js';
import { ShapeInstallFlow } from '../../flows/install-shape.js';

// Spy on atomicMove so one test can force an activate-phase failure (a rename
// fault on the staging → target move) and exercise the transaction's restore
// path. The transaction engine ALSO uses atomicMove (to move the target aside
// and to restore it), so the default implementation must call through to the
// real one — `beforeEach` re-installs that pass-through before every test.
vi.mock('../../lib/atomic-move.js', () => ({ atomicMove: vi.fn() }));

/** The real, unmocked atomicMove, captured once so the spy can call through. */
let realAtomicMove: typeof atomicMove;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Absolute path to the Linear Ops fixture shipped for the shapes suite. */
const VALID_SHAPE_FIXTURE = path.join(__dirname, '..', '..', 'fixtures', 'valid-shape');

/** Construct a no-op logger that satisfies the {@link Logger} interface. */
function buildLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/** Build a minimal valid {@link ShapePackageManifest} with sensible defaults. */
function buildManifest(overrides: Partial<ShapePackageManifest> = {}): ShapePackageManifest {
  return {
    schemaVersion: 1,
    name: 'fixture-shape',
    version: '0.1.0',
    type: 'shape',
    description: 'Fixture shape used by install-shape tests.',
    tags: [],
    layers: [],
    requires: [],
    activates: [],
    extensions: [],
    layout: { sidebarOpen: true, openPanels: [], focusDashboardSections: [] },
    agents: [],
    schedules: [],
    connections: [],
    ...overrides,
  } as ShapePackageManifest;
}

/** Returns true if `target` exists on disk. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage a fake Shape package on disk. Returns the absolute path to the package
 * root. The caller is responsible for removing it.
 */
async function stagePackage(opts: {
  manifest: ShapePackageManifest;
  extensions?: { id: string; manifest: Record<string, unknown> }[];
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'install-shape-pkg-'));
  await mkdir(path.join(root, '.dork'), { recursive: true });
  await writeFile(
    path.join(root, '.dork', 'manifest.json'),
    JSON.stringify(opts.manifest, null, 2),
    'utf-8'
  );
  for (const ext of opts.extensions ?? []) {
    const extDir = path.join(root, '.dork', 'extensions', ext.id);
    await mkdir(extDir, { recursive: true });
    await writeFile(
      path.join(extDir, 'extension.json'),
      JSON.stringify(ext.manifest, null, 2),
      'utf-8'
    );
    await writeFile(path.join(extDir, 'index.ts'), 'export const activate = () => {};', 'utf-8');
  }
  return root;
}

/** Build a deps object with a mock compiler spy and a tmp dorkHome. */
async function buildDeps(): Promise<{
  dorkHome: string;
  extensionCompiler: { compile: ReturnType<typeof vi.fn> };
  logger: Logger;
}> {
  const dorkHome = await mkdtemp(path.join(tmpdir(), 'install-shape-home-'));
  return {
    dorkHome,
    extensionCompiler: {
      compile: vi.fn().mockResolvedValue({ code: 'compiled', sourceHash: 'abc123' }),
    },
    logger: buildLogger(),
  };
}

describe('ShapeInstallFlow', () => {
  const cleanupDirs: string[] = [];

  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('../../lib/atomic-move.js')>(
      '../../lib/atomic-move.js'
    );
    realAtomicMove = actual.atomicMove;
  });

  beforeEach(() => {
    // Default: the spy transparently calls the real atomicMove.
    vi.mocked(atomicMove).mockImplementation((source, dest) => realAtomicMove(source, dest));
  });

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    vi.mocked(atomicMove).mockReset();
  });

  it('stages the Linear Ops fixture under shapes/<name> with type shape', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const raw = JSON.parse(
      await readFile(path.join(VALID_SHAPE_FIXTURE, '.dork', 'manifest.json'), 'utf-8')
    );
    const parsed = MarketplacePackageManifestSchema.parse(raw) as ShapePackageManifest;

    const flow = new ShapeInstallFlow(deps);
    const result = await flow.install(VALID_SHAPE_FIXTURE, parsed, {});

    expect(result.ok).toBe(true);
    expect(result.type).toBe('shape');
    expect(result.packageName).toBe('linear-ops');
    const installRoot = path.join(deps.dorkHome, 'shapes', 'linear-ops');
    expect(result.installPath).toBe(installRoot);
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(true);
    // The fixture ships no inline extensions, so the compiler is never called.
    expect(deps.extensionCompiler.compile).not.toHaveBeenCalled();
  });

  it('compiles bundled inline extensions but never enables them (install stages, apply activates)', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'inline-ext-shape', extensions: ['bundled-ext'] });
    const pkgPath = await stagePackage({
      manifest,
      extensions: [
        { id: 'bundled-ext', manifest: { id: 'bundled-ext', name: 'B', version: '0.1.0' } },
      ],
    });
    cleanupDirs.push(pkgPath);

    const flow = new ShapeInstallFlow(deps);
    const result = await flow.install(pkgPath, manifest, {});

    expect(result.ok).toBe(true);
    // The inline extension is compiled at stage...
    expect(deps.extensionCompiler.compile).toHaveBeenCalledTimes(1);
    // ...and lands on disk compiled-but-disabled. There is no extension manager
    // in the Shape flow's deps, so no enable path exists at all — enabling is
    // applyShape's job.
    const installedExt = path.join(
      deps.dorkHome,
      'shapes',
      'inline-ext-shape',
      '.dork',
      'extensions',
      'bundled-ext'
    );
    expect(await pathExists(installedExt)).toBe(true);
    expect('extensionManager' in deps).toBe(false);
  });

  it('rolls back staging and leaves zero residue when an inline extension fails to compile', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    deps.extensionCompiler.compile.mockRejectedValue(new Error('boom: esbuild crashed'));
    const manifest = buildManifest({ name: 'broken-shape', extensions: ['broken-ext'] });
    const pkgPath = await stagePackage({
      manifest,
      extensions: [
        { id: 'broken-ext', manifest: { id: 'broken-ext', name: 'X', version: '0.1.0' } },
      ],
    });
    cleanupDirs.push(pkgPath);

    const flow = new ShapeInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, {})).rejects.toThrow(/boom: esbuild crashed/);

    expect(await pathExists(path.join(deps.dorkHome, 'shapes', 'broken-shape'))).toBe(false);
    const stagingPrefix = 'dorkos-install-install-shape-broken-shape-';
    const tmpEntries = await readdir(tmpdir());
    expect(tmpEntries.some((e) => e.startsWith(stagingPrefix))).toBe(false);
  });

  it('restores the previous Shape install byte-for-byte when activation (atomicMove) throws', async () => {
    const deps = await buildDeps();
    cleanupDirs.push(deps.dorkHome);
    const manifest = buildManifest({ name: 'restore-shape' });
    const pkgPath = await stagePackage({ manifest });
    cleanupDirs.push(pkgPath);

    // Seed a distinctive prior installation at the target.
    const installRoot = path.join(deps.dorkHome, 'shapes', 'restore-shape');
    await mkdir(installRoot, { recursive: true });
    await writeFile(path.join(installRoot, 'original.txt'), 'ORIGINAL', 'utf-8');

    // Force ONLY the activation move (staging → target) to fail, while the
    // transaction's own moves (target → backup, backup → target) call through
    // to the real implementation so the restore path actually runs.
    vi.mocked(atomicMove).mockImplementation((source, dest) => {
      if (dest === installRoot && source.includes('dorkos-install-')) {
        throw new Error('boom: rename failed');
      }
      return realAtomicMove(source, dest);
    });

    const flow = new ShapeInstallFlow(deps);
    await expect(flow.install(pkgPath, manifest, {})).rejects.toThrow(/boom: rename failed/);

    // The original installation is restored byte-for-byte.
    expect(await pathExists(installRoot)).toBe(true);
    expect(await readFile(path.join(installRoot, 'original.txt'), 'utf-8')).toBe('ORIGINAL');
    // The new package's files are gone (the failed install left no residue).
    expect(await pathExists(path.join(installRoot, '.dork', 'manifest.json'))).toBe(false);
    // No leftover backup sibling under shapes/.
    const shapeEntries = await readdir(path.join(deps.dorkHome, 'shapes'));
    expect(shapeEntries.some((e) => e.includes('.dorkos-bak-'))).toBe(false);
  });
});

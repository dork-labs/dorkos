/**
 * The build cache must be keyed on everything a bundle was built from, not on
 * the entry file alone (DOR-2491). esbuild bundles every module the entry
 * imports, so an update that only changes `ui/panel.ts` used to leave
 * `index.ts` byte-identical and the stale bundle kept being served.
 *
 * These run the REAL esbuild (wrapped in a spy so a test can tell a cache hit
 * from a rebuild) against real files on disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { build } from 'esbuild';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionCompiler } from '../extension-compiler.js';

const esbuildState = vi.hoisted(() => ({ versionOverride: null as string | null }));

vi.mock('esbuild', async (importOriginal) => {
  const real = await importOriginal<typeof import('esbuild')>();
  return {
    ...real,
    build: vi.fn(real.build),
    get version() {
      return esbuildState.versionOverride ?? real.version;
    },
  };
});

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const buildSpy = vi.mocked(build);

/** Create a minimal client ExtensionRecord pointing at the given directory. */
function makeRecord(id: string, extDir: string): ExtensionRecord {
  return {
    id,
    path: extDir,
    manifest: { id, name: id, version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
  };
}

/** Create an ExtensionRecord with a server entry point. */
function makeServerRecord(id: string, extDir: string): ExtensionRecord {
  return {
    ...makeRecord(id, extDir),
    hasServerEntry: true,
    serverEntryPath: path.join(extDir, 'server.ts'),
  };
}

/** Write `files` (relative path → content) under `root`, creating directories. */
async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

/** Unwrap a successful compile result, failing the test otherwise. */
function codeOf(result: { code: string } | { error: { message: string } }): string {
  if (!('code' in result)) throw new Error(`expected a bundle, got: ${result.error.message}`);
  return result.code;
}

/** The single manifest file in `cacheDir`. */
async function manifestPathIn(cacheDir: string): Promise<string> {
  const manifests = (await fs.readdir(cacheDir)).filter((e) => e.endsWith('.manifest.json'));
  expect(manifests).toHaveLength(1);
  return path.join(cacheDir, manifests[0]!);
}

describe('ExtensionCompiler — cache keyed on the whole input graph', () => {
  let tmpDir: string;
  let cacheDir: string;
  let compiler: ExtensionCompiler;

  beforeEach(async () => {
    // Real path: esbuild reports inputs with symlinks resolved (macOS /var).
    tmpDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-compiler-graph-')));
    cacheDir = path.join(tmpDir, 'cache', 'extensions');
    compiler = new ExtensionCompiler(tmpDir);
    buildSpy.mockClear();
    esbuildState.versionOverride = null;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rebuilds the client bundle when only an imported module changes', async () => {
    const extDir = path.join(tmpDir, 'exts', 'panel-ext');
    await writeTree(extDir, {
      'index.ts':
        'import { label } from "./ui/panel";\nexport function activate() { return label; }',
      'ui/panel.ts': 'export const label = "old panel copy";',
    });
    const record = makeRecord('panel-ext', extDir);

    const first = await compiler.compile(record);
    expect(codeOf(first)).toContain('old panel copy');

    await fs.writeFile(path.join(extDir, 'ui/panel.ts'), 'export const label = "new panel copy";');
    const second = await compiler.compile(record);

    expect(codeOf(second)).toContain('new panel copy');
    expect(codeOf(second)).not.toContain('old panel copy');
    expect(second.sourceHash).not.toBe(first.sourceHash);
    // What the browser is actually served follows the new hash.
    expect(await compiler.readBundle('panel-ext', second.sourceHash)).toContain('new panel copy');
  });

  it('rebuilds the server bundle when only an imported module changes', async () => {
    const extDir = path.join(tmpDir, 'exts', 'server-helper-ext');
    await writeTree(extDir, {
      'server.ts':
        'import { answer } from "./lib/helper";\nexport default function register() { return answer; }',
      'lib/helper.ts': 'export const answer = "old server answer";',
    });
    const record = makeServerRecord('server-helper-ext', extDir);

    const first = await compiler.compileServer(record);
    expect(codeOf(first)).toContain('old server answer');

    await fs.writeFile(
      path.join(extDir, 'lib/helper.ts'),
      'export const answer = "new server answer";'
    );
    const second = await compiler.compileServer(record);

    expect(codeOf(second)).toContain('new server answer');
    expect(second.sourceHash).not.toBe(first.sourceHash);
  });

  it('reuses an unchanged build without calling esbuild, and records every input it read', async () => {
    const extDir = path.join(tmpDir, 'exts', 'steady-ext');
    await writeTree(extDir, {
      'index.ts':
        'import { helper } from "./helper";\nimport { dep } from "tiny-dep";\nexport function activate() { return helper + dep; }',
      'helper.ts': 'export const helper = "h";',
      'node_modules/tiny-dep/package.json': JSON.stringify({ name: 'tiny-dep', main: 'index.js' }),
      'node_modules/tiny-dep/index.js': 'exports.dep = "from node_modules";',
    });
    const record = makeRecord('steady-ext', extDir);

    const first = await compiler.compile(record);
    expect(codeOf(first)).toContain('from node_modules');
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // A fresh compiler is what a server restart looks like.
    const second = await new ExtensionCompiler(tmpDir).compile(record);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);

    const manifest = JSON.parse(await fs.readFile(await manifestPathIn(cacheDir), 'utf-8')) as {
      files: Array<{ path: string }>;
    };
    const recorded = manifest.files.map((f) => path.relative(extDir, f.path)).sort();
    expect(recorded).toEqual(
      expect.arrayContaining([
        'helper.ts',
        'index.ts',
        path.join('node_modules', 'tiny-dep', 'index.js'),
      ])
    );
  });

  it('rebuilds when a dependency inside node_modules changes', async () => {
    const extDir = path.join(tmpDir, 'exts', 'dep-ext');
    await writeTree(extDir, {
      'index.ts': 'import { dep } from "tiny-dep";\nexport function activate() { return dep; }',
      'node_modules/tiny-dep/package.json': JSON.stringify({ name: 'tiny-dep', main: 'index.js' }),
      'node_modules/tiny-dep/index.js': 'exports.dep = "dep v1";',
    });
    const record = makeRecord('dep-ext', extDir);
    expect(codeOf(await compiler.compile(record))).toContain('dep v1');

    await fs.writeFile(
      path.join(extDir, 'node_modules/tiny-dep/index.js'),
      'exports.dep = "dep v2";'
    );
    expect(codeOf(await compiler.compile(record))).toContain('dep v2');
  });

  it('rebuilds when the esbuild version changes', async () => {
    const extDir = path.join(tmpDir, 'exts', 'version-ext');
    await writeTree(extDir, { 'index.ts': 'export function activate() { return 1; }' });
    const record = makeRecord('version-ext', extDir);

    await compiler.compile(record);
    await compiler.compile(record);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    esbuildState.versionOverride = '99.0.0';
    await compiler.compile(record);
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when the recorded build configuration differs from the current one', async () => {
    // The build key covers every esbuild option; a manifest written under any
    // other configuration (a changed target, a new external) must not be
    // trusted, even though every source file is unchanged.
    const extDir = path.join(tmpDir, 'exts', 'options-ext');
    await writeTree(extDir, { 'index.ts': 'export function activate() { return 1; }' });
    const record = makeRecord('options-ext', extDir);
    await compiler.compile(record);

    const manifestPath = await manifestPathIn(cacheDir);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as { buildKey: string };
    manifest.buildKey = 'a-build-key-for-different-options';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    await compiler.compile(record);
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when an imported file is deleted', async () => {
    const extDir = path.join(tmpDir, 'exts', 'deleted-ext');
    await writeTree(extDir, {
      'index.ts': 'import { gone } from "./gone";\nexport function activate() { return gone; }',
      'gone.ts': 'export const gone = "still here";',
    });
    const record = makeRecord('deleted-ext', extDir);
    expect(codeOf(await compiler.compile(record))).toContain('still here');

    await fs.unlink(path.join(extDir, 'gone.ts'));
    const second = await compiler.compile(record);

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect('error' in second).toBe(true);
  });

  it('rebuilds when a new file changes what an unchanged import resolves to', async () => {
    const extDir = path.join(tmpDir, 'exts', 'resolve-ext');
    await writeTree(extDir, {
      'index.ts': 'import { which } from "./impl";\nexport function activate() { return which; }',
      'impl.js': 'export const which = "the js file";',
    });
    const record = makeRecord('resolve-ext', extDir);
    expect(codeOf(await compiler.compile(record))).toContain('the js file');

    // esbuild prefers impl.ts over impl.js, so this changes the bundle without
    // touching any file the first build read.
    await fs.writeFile(path.join(extDir, 'impl.ts'), 'export const which = "the ts file";');
    expect(codeOf(await compiler.compile(record))).toContain('the ts file');
  });

  it('rebuilds when the manifest is corrupt', async () => {
    const extDir = path.join(tmpDir, 'exts', 'corrupt-ext');
    await writeTree(extDir, { 'index.ts': 'export function activate() { return 1; }' });
    const record = makeRecord('corrupt-ext', extDir);
    const first = await compiler.compile(record);

    await fs.writeFile(await manifestPathIn(cacheDir), '{ this is not json');
    const second = await compiler.compile(record);

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(codeOf(second)).toBe(codeOf(first));
  });

  it('rebuilds when the manifest is valid JSON of the wrong shape', async () => {
    const extDir = path.join(tmpDir, 'exts', 'shape-ext');
    await writeTree(extDir, { 'index.ts': 'export function activate() { return 1; }' });
    const record = makeRecord('shape-ext', extDir);
    await compiler.compile(record);

    await fs.writeFile(await manifestPathIn(cacheDir), JSON.stringify({ v: 1, files: 'nope' }));
    expect('code' in (await compiler.compile(record))).toBe(true);
    expect(buildSpy).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when the cached bundle is gone but its manifest is not', async () => {
    const extDir = path.join(tmpDir, 'exts', 'orphan-ext');
    await writeTree(extDir, { 'index.ts': 'export function activate() { return 1; }' });
    const record = makeRecord('orphan-ext', extDir);
    const first = await compiler.compile(record);

    await fs.unlink(path.join(cacheDir, `orphan-ext.${first.sourceHash}.js`));
    const second = await compiler.compile(record);

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(await compiler.readBundle('orphan-ext', second.sourceHash)).toBe(codeOf(second));
  });

  it('stops replaying a cached error once the missing import is added', async () => {
    const extDir = path.join(tmpDir, 'exts', 'fixed-ext');
    await writeTree(extDir, {
      'index.ts': 'import { later } from "./later";\nexport function activate() { return later; }',
    });
    const record = makeRecord('fixed-ext', extDir);

    expect('error' in (await compiler.compile(record))).toBe(true);
    // The genuine error is cached: an unchanged tree replays it.
    expect('error' in (await compiler.compile(record))).toBe(true);
    expect(buildSpy).toHaveBeenCalledTimes(1);

    await fs.writeFile(path.join(extDir, 'later.ts'), 'export const later = "now it exists";');
    expect(codeOf(await compiler.compile(record))).toContain('now it exists');
  });

  it('picks up a plugin-carried extension updated in place by a marketplace reinstall', async () => {
    // Plugin-carried extensions live under the DorkOS home at
    // plugins/<plugin>/.dork/extensions/<id>, and an update swaps the whole
    // directory by rename, leaving the entry file identical.
    const pluginExtRoot = path.join(tmpDir, 'plugins', 'flow', '.dork', 'extensions');
    const extDir = path.join(pluginExtRoot, 'flow');
    const tree = (copy: string) => ({
      'index.ts':
        'import { copy } from "./ui/flow-panel";\nexport function activate() { return copy; }',
      'ui/flow-panel.ts': `export const copy = "${copy}";`,
    });
    await writeTree(extDir, tree('Pausing failed.'));
    const record = { ...makeRecord('flow', extDir), sourcePlugin: 'flow' };
    expect(codeOf(await compiler.compile(record))).toContain('Pausing failed.');

    const staged = path.join(pluginExtRoot, 'flow.staged');
    await writeTree(staged, tree('Could not pause this flow.'));
    await fs.rm(extDir, { recursive: true });
    await fs.rename(staged, extDir);

    expect(codeOf(await compiler.compile(record))).toContain('Could not pause this flow.');
  });
});

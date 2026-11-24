/**
 * Integration test for the extension lifecycle on a real filesystem with real esbuild:
 * discover, compile, activate, fix a broken build, and iterate. The per-step details
 * (statuses, scopes, cache entries, error shapes) are covered by the discovery and
 * compiler suites; this file proves the pieces work together.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../extension-discovery.js';
import { ExtensionCompiler } from '../extension-compiler.js';
import { clientBundleExports } from '../client-bundle-exports.js';
import type { CoreExtensionInfo } from '../extension-enable-resolution.js';

const NO_CORE = new Map<string, CoreExtensionInfo>();

const HELLO_SOURCE = `
import type { ExtensionAPI } from '@dorkos/extension-api';

function HelloSection() {
  return null;
}

export function activate(api: ExtensionAPI): void {
  api.registerComponent('dashboard.sections', 'hello-section', HelloSection, { priority: 50 });
  api.registerCommand('greet', 'Say Hello', () => {});
}
`;

describe('Extension Lifecycle Integration', () => {
  let tmpDir: string;
  let dorkHome: string;
  let discovery: ExtensionDiscovery;
  let compiler: ExtensionCompiler;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-lifecycle-'));
    dorkHome = path.join(tmpDir, '.dork');
    discovery = new ExtensionDiscovery(dorkHome);
    compiler = new ExtensionCompiler(dorkHome);
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a global extension with `source` as its index.ts, and discover it enabled. */
  async function installed(id: string, source: string) {
    const dir = path.join(dorkHome, 'extensions', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'extension.json'),
      JSON.stringify({ id, name: id, version: '1.0.0' })
    );
    await fs.writeFile(path.join(dir, 'index.ts'), source);
    const records = await discovery.discover(
      null,
      { enabled: [id], disabled: [], approvedToRun: [] },
      NO_CORE
    );
    const record = records.find((r) => r.id === id);
    expect(record?.status).toBe('enabled');
    return { dir, record: record! };
  }

  it('compiles a discovered extension, and its bundle activates against the API', async () => {
    const { record } = await installed('hello-world', HELLO_SOURCE);

    const compiled = await compiler.compile(record);
    if (!('code' in compiled)) throw new Error(`compile failed: ${JSON.stringify(compiled)}`);
    const bundle = await compiler.readBundle('hello-world', compiled.sourceHash);
    const mod = clientBundleExports(bundle!, 'hello-world.bundle.js') as {
      activate: (api: unknown) => unknown;
    };

    const registrations: Array<{ slot: string; id: string }> = [];
    const commands: Array<{ id: string; label: string }> = [];
    mod.activate({
      id: 'hello-world',
      registerComponent(slot: string, id: string) {
        registrations.push({ slot, id });
        return () => {};
      },
      registerCommand(id: string, label: string) {
        commands.push({ id, label });
        return () => {};
      },
    });

    expect(registrations).toEqual([{ slot: 'dashboard.sections', id: 'hello-section' }]);
    expect(commands).toEqual([{ id: 'greet', label: 'Say Hello' }]);
  });

  it('recovers from a compile error once the source is fixed', async () => {
    const { dir, record } = await installed(
      'broken-ext',
      `import { nonExistent } from './does-not-exist.js';\nexport function activate() { nonExistent(); }\n`
    );
    expect('error' in (await compiler.compile(record))).toBe(true);

    await fs.writeFile(
      path.join(dir, 'index.ts'),
      `export function activate(api: any) { api.registerCommand('fixed', 'Fixed', () => {}); }`
    );

    const fixed = await compiler.compile(record);
    expect('code' in fixed && fixed.code).toContain('activate');
  });

  it('recompiles an edited extension to new output, and it stays discovered', async () => {
    const { dir, record } = await installed(
      'roundtrip-ext',
      `export function activate(api: any) { api.registerCommand('v1', 'Version 1', () => {}); }`
    );
    const first = await compiler.compile(record);
    expect('code' in first && first.code).toContain('Version 1');

    await fs.writeFile(
      path.join(dir, 'index.ts'),
      `export function activate(api: any) { api.registerCommand('v2', 'Version 2', () => {}); }`
    );
    const second = await compiler.compile(record);
    expect('code' in second && second.code).toContain('Version 2');
    expect('sourceHash' in second && second.sourceHash).not.toBe(
      'sourceHash' in first && first.sourceHash
    );

    await installed('roundtrip-ext', await fs.readFile(path.join(dir, 'index.ts'), 'utf8'));
  });
});

/**
 * What the compiler holds a plugin-carried extension to (second security
 * review of DOR-2527), against the REAL filesystem and REAL esbuild:
 *
 * - N1: a bundle may import only files inside its own plugin's install
 *   folder. A relative import climbing out, or a bare package found in the
 *   project's `node_modules` instead of the plugin's own, fails the build.
 * - N3: a copy pinned to a plugin folder digest is re-hashed right before the
 *   bundle is built or served; a change since the scan is refused, for the
 *   client bundle and the server bundle alike, and the record loses its origin.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionCompiler } from '../extension-compiler.js';
import { installFolderDigest } from '../../marketplace/lib/install-digest.js';

let tmp: string;
let project: string;
let pluginRoot: string;
let extDir: string;
let compiler: ExtensionCompiler;

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function record(overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'flow',
    manifest: { id: 'flow', name: 'Flow', version: '1.0.0' },
    status: 'enabled',
    scope: 'local',
    origin: 'user',
    path: extDir,
    sourcePlugin: 'flow',
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
    serverEntryPath: path.join(extDir, 'server.ts'),
    ...overrides,
  };
}

async function digestNow(): Promise<string> {
  const found = await installFolderDigest(pluginRoot);
  if (found.kind !== 'digest') throw new Error(found.kind);
  return found.digest;
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-guard-')));
  project = path.join(tmp, 'repo-b');
  pluginRoot = path.join(project, '.dork', 'plugins', 'flow');
  extDir = path.join(pluginRoot, '.dork', 'extensions', 'flow');
  await write(path.join(extDir, 'extension.json'), '{"id":"flow","name":"Flow","version":"1.0.0"}');
  await write(path.join(pluginRoot, 'scripts', 'errors.ts'), 'export const inside = 1;\n');
  compiler = new ExtensionCompiler(path.join(tmp, 'dork'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('containment (N1)', () => {
  it('bundles a plugin-level import inside the plugin folder', async () => {
    await write(
      path.join(extDir, 'index.ts'),
      "import { inside } from '../../../scripts/errors';\nexport const x = inside;\n"
    );
    const result = await compiler.compile(record());
    expect('code' in result).toBe(true);
  });

  it('refuses a relative import that climbs out of the plugin folder', async () => {
    await write(path.join(project, 'evil.ts'), 'export const evil = 1;\n');
    await write(
      path.join(extDir, 'index.ts'),
      "import { evil } from '../../../../../../evil';\nexport const x = evil;\n"
    );
    const result = await compiler.compile(record());
    expect('error' in result && JSON.stringify(result.error)).toContain(
      "outside this plugin's folder"
    );
  });

  it("refuses a bare package found in the project's node_modules, and allows the plugin's own", async () => {
    await write(path.join(project, 'node_modules', 'leftpad', 'index.js'), 'exports.pad = 1;\n');
    await write(
      path.join(extDir, 'index.ts'),
      "import { pad } from 'leftpad';\nexport const x = pad;\n"
    );
    const outside = await compiler.compile(record());
    expect('error' in outside && JSON.stringify(outside.error)).toContain(
      "outside this plugin's folder"
    );

    await write(path.join(pluginRoot, 'node_modules', 'leftpad', 'index.js'), 'exports.pad = 2;\n');
    const own = await compiler.compile(record());
    expect('code' in own).toBe(true);
  });

  it('refuses the same escape in a server bundle', async () => {
    await write(path.join(project, 'evil.ts'), 'export const evil = 1;\n');
    await write(
      path.join(extDir, 'server.ts'),
      "import { evil } from '../../../../../../evil';\nexport default () => evil;\n"
    );
    const result = await compiler.compileServer(record());
    expect('error' in result && JSON.stringify(result.error)).toContain(
      "outside this plugin's folder"
    );
  });
});

describe('the pinned digest (N3)', () => {
  it('refuses a client bundle whose plugin changed after the scan, and drops the origin', async () => {
    await write(path.join(extDir, 'index.ts'), 'export const x = 1;\n');
    const pinned = record({
      pinnedDigest: await digestNow(),
      trustedOrigin: { plugin: 'flow', source: 'dork-labs/marketplace' },
    });
    expect('code' in (await compiler.compile(pinned))).toBe(true);

    // Swapped after the scan (a git pull, an agent) in plugin-level code.
    await write(path.join(pluginRoot, 'scripts', 'errors.ts'), 'export const inside = 99;\n');
    const result = await compiler.compile(pinned);

    expect('error' in result && result.error.message).toContain(
      'changed after DorkOS checked them'
    );
    expect(pinned.trustedOrigin).toBeUndefined();
    expect(pinned.originProblem).toBe('changed');
  });

  it('refuses a server bundle the same way, so `reload_extensions --id` cannot load it', async () => {
    await write(path.join(extDir, 'server.ts'), 'export default () => undefined;\n');
    const pinned = record({ pinnedDigest: await digestNow() });
    await write(path.join(extDir, 'server.ts'), 'export default () => "evil";\n');

    const result = await compiler.compileServer(pinned);

    expect('error' in result && result.error.message).toContain(
      'changed after DorkOS checked them'
    );
  });
});

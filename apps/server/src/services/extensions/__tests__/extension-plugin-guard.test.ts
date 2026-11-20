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
import { containmentRootOf } from '../extension-plugin-guard.js';
import { RUN_DIR_MISSING_CODE, runDirMissingMessage, runDirOf } from '../pin/run-dir.js';
import { recordContextDeps } from '../server-bundle/extension-context-deps.js';

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
      `outside this plugin's folder (${pluginRoot})`
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

  it('contains a directly installed copy to its own folder too, path trust included (DOR-3068)', async () => {
    const home = path.join(tmp, 'agents', 'a');
    const own = path.join(home, '.dork', 'extensions', 'notes');
    await write(path.join(tmp, 'secret.ts'), 'export const secret = "id_rsa";\n');
    await write(path.join(own, 'helper.ts'), 'export const helper = 1;\n');
    const direct = record({ id: 'notes', path: own, realPath: own, sourcePlugin: undefined });

    await write(
      path.join(own, 'index.ts'),
      "import { helper } from './helper';\nexport const x = helper;\n"
    );
    expect('code' in (await compiler.compile(direct))).toBe(true);

    await write(
      path.join(own, 'index.ts'),
      "import { secret } from '../../../../../secret';\nexport const x = secret;\n"
    );
    const escaped = await compiler.compile(direct);
    // It names the boundary that applies: its own folder, not a plugin's (DOR-3537).
    expect('error' in escaped && JSON.stringify(escaped.error)).toContain(
      `outside this extension's folder (${own})`
    );

    await write(
      path.join(own, 'server.ts'),
      "import { secret } from '../../../../../secret';\nexport default () => secret;\n"
    );
    const server = await compiler.compileServer({
      ...direct,
      serverEntryPath: path.join(own, 'server.ts'),
    });
    expect('error' in server).toBe(true);
  });

  it('leaves a dev link’s containment as it was, and contains any other copy to its folder', () => {
    const own = '/work/agent/.dork/extensions/notes';
    expect(containmentRootOf({ path: own, realPath: own })).toBe(own);
    expect(containmentRootOf({ path: own, devLink: { path: '/work/notes' } })).toBeNull();
    // A copy's own node_modules sits inside its folder, so it still builds.
    expect(containmentRootOf({ path: own, runPath: '/snap/abc/notes' })).toBe('/snap/abc/notes');
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
    const digest = await digestNow();
    const pinned = record({
      pinnedDigest: digest,
      originPinnedDigest: digest,
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
    // A copy pinned by an approval runs from a checked folder; here, the
    // plugin's own, held to its digest.
    const pinned = record({ pinnedDigest: await digestNow(), runPath: extDir });
    await write(path.join(extDir, 'server.ts'), 'export default () => "evil";\n');

    const result = await compiler.compileServer(pinned);

    expect('error' in result && result.error.message).toContain(
      'changed after DorkOS checked them'
    );
  });
});

describe('a pinned copy runs only from its checked copy (pin/run-dir)', () => {
  const approvals = () => ({ approvedToRun: [], approvedSources: {} });

  // Purpose: a pinned copy with no snapshot never falls back to the folder it
  // was found in: nothing is built, client or server, and it does not start.
  it('refuses to build or start a pinned copy with no snapshot', async () => {
    await write(path.join(extDir, 'index.ts'), 'export const x = 1;\n');
    await write(path.join(extDir, 'server.ts'), 'export default () => undefined;\n');
    const pinned = record({ pinnedDigest: await digestNow() });

    expect(runDirOf(pinned)).toBeNull();
    const client = await compiler.compile(pinned);
    const server = await compiler.compileServer(pinned);
    for (const result of [client, server]) {
      expect('error' in result && result.error.message).toBe(runDirMissingMessage('Flow'));
      expect(JSON.stringify(result)).toContain(RUN_DIR_MISSING_CODE);
    }
    // Both ways a server half starts build its ctx here first.
    expect(() => recordContextDeps('flow', pinned, tmp, approvals)).toThrow(
      runDirMissingMessage('Flow')
    );
  });

  // Purpose: a copy nothing pins still builds and starts from its own folder.
  it('builds and starts an unpinned copy from its own folder', async () => {
    await write(path.join(extDir, 'index.ts'), 'export const x = 1;\n');
    const live = record();

    expect(runDirOf(live)).toBe(extDir);
    expect('code' in (await compiler.compile(live))).toBe(true);
    expect(recordContextDeps('flow', live, tmp, approvals).extensionDir).toBe(extDir);
  });

  // Purpose: a pinned copy builds from its snapshot, so a live edit is not
  // what runs.
  it('builds a pinned copy from its snapshot, not from the folder', async () => {
    await write(path.join(extDir, 'index.ts'), 'export const x = "checked";\n');
    const snapshotRoot = path.join(tmp, 'snapshot', 'flow');
    await fs.cp(pluginRoot, snapshotRoot, { recursive: true });
    const snapshotDir = path.join(snapshotRoot, path.relative(pluginRoot, extDir));
    const pinned = record({ pinnedDigest: await digestNow(), runPath: snapshotDir });
    await write(path.join(extDir, 'index.ts'), 'export const x = "edited";\n');

    expect(runDirOf(pinned)).toBe(snapshotDir);
    const result = await compiler.compile(pinned);
    expect('code' in result && result.code).toContain('checked');
    expect('code' in result && result.code).not.toContain('edited');
    expect(recordContextDeps('flow', pinned, tmp, approvals).extensionDir).toBe(snapshotDir);
  });

  // Purpose: the digest a plugin copy with a proven origin was judged
  // against keeps it on its folder, re-hashed around every build as before;
  // the same pin with no proven origin is refused.
  it('keeps a plugin copy pinned by its proven origin on its own folder', async () => {
    const digest = await digestNow();
    const proven = record({
      scope: 'global',
      pinnedDigest: digest,
      originPinnedDigest: digest,
      trustedOrigin: { plugin: 'flow', source: 'dork-labs/marketplace' },
    });
    expect(runDirOf(proven)).toBe(extDir);
    expect(runDirOf({ ...proven, scope: 'local' })).toBe(extDir);
    expect(runDirOf({ ...proven, trustedOrigin: undefined })).toBeNull();
    expect(runDirOf({ ...proven, sourcePlugin: undefined })).toBeNull();
  });

  // Purpose: the exemption keys on the origin pin, never on a missing
  // snapshot alone. A pin an approval set (any digest the origin proof did
  // not) with no snapshot is refused, plugin copy and proven origin or not.
  it('refuses a pinned copy whose pin is not its origin pin', async () => {
    const digest = await digestNow();
    const proven = record({
      pinnedDigest: digest,
      originPinnedDigest: digest,
      trustedOrigin: { plugin: 'flow', source: 'dork-labs/marketplace' },
    });
    const otherPin = `sha256:${'e'.repeat(64)}`;
    expect(runDirOf({ ...proven, pinnedDigest: otherPin })).toBeNull();
    expect(runDirOf({ ...proven, originPinnedDigest: undefined })).toBeNull();
    // A copy outside any plugin, pinned, with no snapshot: refused too.
    expect(runDirOf(record({ sourcePlugin: undefined, pinnedDigest: digest }))).toBeNull();
  });

  // Purpose: the exempt kind is still held to its pin on both sides of the
  // build: a file swapped while it bundles is refused after the build.
  it('re-hashes an origin-pinned copy after the build too', async () => {
    await write(path.join(extDir, 'index.ts'), 'export const x = 1;\n');
    const digest = await digestNow();
    const proven = record({
      pinnedDigest: digest,
      originPinnedDigest: digest,
      trustedOrigin: { plugin: 'flow', source: 'dork-labs/marketplace' },
    });
    const target = compiler as unknown as {
      compileClient: (r: unknown, dir: string) => Promise<unknown>;
    };
    const build = target.compileClient.bind(compiler);
    target.compileClient = async (r, dir) => {
      const built = await build(r, dir);
      // Swapped mid-build, after the "before" check already passed.
      await write(path.join(pluginRoot, 'scripts', 'errors.ts'), 'export const late = 1;\n');
      return built;
    };

    const result = await compiler.compile(proven);

    expect(
      'error' in (result as object) && (result as { error: { message: string } }).error.message
    ).toContain('changed after DorkOS checked them');
  });
});

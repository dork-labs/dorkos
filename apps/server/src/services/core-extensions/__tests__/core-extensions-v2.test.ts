/**
 * The built-in apps ship with every install (the CLI and desktop builds copy
 * this folder), so each must be an extension API version 2 app: a version 1
 * app never loads (DOR-3293). Each is compiled with the real compiler and run
 * the way `test_extension` runs a bundle, against a recording frame API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ExtensionManifestSchema, type ExtensionRecord } from '@dorkos/extension-api';
import { ExtensionCompiler } from '../../extensions/extension-compiler.js';
import { clientBundleExports } from '../../extensions/client-bundle-exports.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** The folder the CLI and desktop builds copy into every install. */
const CORE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../core-extensions'
);

let cacheHome: string;
beforeAll(async () => {
  cacheHome = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-core-v2-'));
  // The bundles read React from the frame's global; activation only needs it to exist.
  vi.stubGlobal('React', { createElement: vi.fn(), useState: vi.fn(), useEffect: vi.fn() });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(cacheHome, { recursive: true, force: true });
});

/** A frame API that records what an app registers during its registration run. */
function recordingApi(id: string) {
  const registered: string[] = [];
  const unregister = () => {};
  const api = {
    id,
    context: 'registration',
    registerComponent: (slot: string, itemId: string) => (
      registered.push(`${slot}:${itemId}`),
      unregister
    ),
    registerCommand: (itemId: string) => (registered.push(`command:${itemId}`), unregister),
    registerPage: (pagePath: string) => (registered.push(`page:${pagePath}`), unregister),
    registerStatusBarItem: (itemId: string) => (registered.push(`status:${itemId}`), unregister),
    registerSettingsTab: (itemId: string) => (registered.push(`settings:${itemId}`), unregister),
    registerDialog: () => ({ open: () => {}, close: () => {} }),
    subscribe: () => unregister,
    getState: () => ({ currentProject: null }),
    loadData: async () => null,
    saveData: async () => {},
    notify: () => {},
    setTabMarker: () => {},
  };
  return { api, registered };
}

/** Compile one built-in app and run its `activate` the way `test_extension` does. */
async function activateCoreExtension(id: string) {
  const dir = path.join(CORE_DIR, id);
  const manifest = ExtensionManifestSchema.parse(
    JSON.parse(await fs.readFile(path.join(dir, 'extension.json'), 'utf-8'))
  );
  const record: ExtensionRecord = {
    id,
    manifest,
    status: 'enabled',
    scope: 'global',
    path: dir,
    bundleReady: false,
    hasServerEntry: false,
    hasDataProxy: false,
  };
  const compiled = await new ExtensionCompiler(cacheHome).compile(record);
  if (!('code' in compiled)) throw new Error(`${id} did not compile`);
  const exports = clientBundleExports(compiled.code, `${id}.bundle.js`) as {
    activate?: (api: unknown) => unknown;
  };
  const { api, registered } = recordingApi(id);
  expect(typeof exports.activate).toBe('function');
  exports.activate!(api);
  return { manifest, registered };
}

describe('built-in apps load under extension API version 2', () => {
  it('hello-world registers its page, panel, section, status item and commands', async () => {
    const { manifest, registered } = await activateCoreExtension('hello-world');
    expect(manifest.clientApiVersion).toBe(2);
    expect(registered).toEqual(
      expect.arrayContaining([
        'page:',
        'right-panel:hello-panel',
        'status:greeting',
        expect.stringMatching(/^dashboard\.sections:/),
        expect.stringMatching(/^command:/),
      ])
    );
  });

  it('linear-issues registers its Activity section and declares its own server routes', async () => {
    const { manifest, registered } = await activateCoreExtension('linear-issues');
    expect(manifest.clientApiVersion).toBe(2);
    // Its screen reads its own /loop route through api.request.
    expect(manifest.capabilities?.http).toBe(true);
    expect(registered).toEqual(
      expect.arrayContaining([
        'dashboard.sections:linear-loop-dashboard',
        'command:linear-quick-idea',
      ])
    );
  });

  it('marketplace activates cleanly (its screens are part of DorkOS itself)', async () => {
    const { manifest, registered } = await activateCoreExtension('marketplace');
    expect(manifest.clientApiVersion).toBe(2);
    expect(registered).toEqual([]);
  });

  it('every built-in app in this folder is covered above', async () => {
    const entries = await fs.readdir(CORE_DIR, { withFileTypes: true });
    const apps = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(apps).toEqual(['hello-world', 'linear-issues', 'marketplace']);
  });
});

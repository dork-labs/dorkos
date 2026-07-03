/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import {
  buildClaudeAgentSdkPluginsArray,
  buildPluginsForCwd,
} from '../messaging/plugin-activation.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: vi.fn(),
    readdir: vi.fn(),
  };
});

function createFakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe('buildClaudeAgentSdkPluginsArray', () => {
  let logger: Logger;

  beforeEach(async () => {
    logger = createFakeLogger();
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockReset();
  });

  it('returns an empty array when enabledPluginNames is empty', async () => {
    const result = await buildClaudeAgentSdkPluginsArray({
      dorkHome: '/tmp/dork',
      enabledPluginNames: [],
      logger,
    });
    expect(result).toEqual([]);
  });

  it('returns a single local plugin entry when the directory exists', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await buildClaudeAgentSdkPluginsArray({
      dorkHome: '/tmp/dork',
      enabledPluginNames: ['code-reviewer'],
      logger,
    });

    expect(result).toEqual([{ type: 'local', path: '/tmp/dork/plugins/code-reviewer' }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns entries in the input order for multiple present plugins', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await buildClaudeAgentSdkPluginsArray({
      dorkHome: '/tmp/dork',
      enabledPluginNames: ['alpha', 'beta', 'gamma'],
      logger,
    });

    expect(result.map((p) => p.path)).toEqual([
      '/tmp/dork/plugins/alpha',
      '/tmp/dork/plugins/beta',
      '/tmp/dork/plugins/gamma',
    ]);
  });

  it('filters out plugins whose directory is missing and logs a warning', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

    const result = await buildClaudeAgentSdkPluginsArray({
      dorkHome: '/tmp/dork',
      enabledPluginNames: ['ghost'],
      logger,
    });

    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'plugin-activation: enabled plugin directory missing',
      {
        packageName: 'ghost',
        expectedPath: '/tmp/dork/plugins/ghost',
      }
    );
  });

  it('mixes present and missing plugins correctly', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockImplementation(async (filePath) => {
      if (String(filePath).endsWith('missing')) throw new Error('ENOENT');
    });

    const result = await buildClaudeAgentSdkPluginsArray({
      dorkHome: '/tmp/dork',
      enabledPluginNames: ['present1', 'missing', 'present2'],
      logger,
    });

    expect(result.map((p) => p.path)).toEqual([
      '/tmp/dork/plugins/present1',
      '/tmp/dork/plugins/present2',
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('uses dorkHome parameter (not os.homedir)', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await buildClaudeAgentSdkPluginsArray({
      dorkHome: '/custom/dork/home',
      enabledPluginNames: ['plugin'],
      logger,
    });

    expect(result[0]?.path).toBe('/custom/dork/home/plugins/plugin');
  });
});

describe('buildPluginsForCwd', () => {
  let logger: Logger;

  const GLOBAL = [
    { type: 'local' as const, path: '/dork/plugins/flow' },
    { type: 'local' as const, path: '/dork/plugins/reviewer' },
  ];

  /** Mock a `readdir` result of directory entries under `<cwd>/.dork/plugins`. */
  async function mockLocalPluginDirs(names: string[], nonDirs: string[] = []) {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readdir).mockResolvedValue([
      ...names.map((name) => ({ name, isDirectory: () => true })),
      ...nonDirs.map((name) => ({ name, isDirectory: () => false })),
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>);
  }

  beforeEach(async () => {
    logger = createFakeLogger();
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockReset();
    vi.mocked(fs.readdir).mockReset();
  });

  // Purpose: the common case (no project-scoped installs) must be a cheap
  // pass-through — same array, no manifest probing.
  it('returns the global set as-is when the cwd has no .dork/plugins directory', async () => {
    const fs = await import('node:fs/promises');
    vi.mocked(fs.readdir).mockRejectedValue(new Error('ENOENT'));

    const result = await buildPluginsForCwd({ cwd: '/proj', globalPlugins: GLOBAL, logger });

    expect(result).toBe(GLOBAL);
    expect(fs.access).not.toHaveBeenCalled();
  });

  // Purpose: an agent-scoped install must reach the SDK for that agent's
  // sessions — the core of the "installed but inert" fix.
  it('appends project-scoped plugins to the global set', async () => {
    await mockLocalPluginDirs(['local-only']);
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await buildPluginsForCwd({ cwd: '/proj', globalPlugins: GLOBAL, logger });

    expect(result.map((p) => p.path)).toEqual([
      '/dork/plugins/flow',
      '/dork/plugins/reviewer',
      '/proj/.dork/plugins/local-only',
    ]);
  });

  // Purpose: a scoped install of an already-global package must SHADOW the
  // global copy, not double-register the plugin with the SDK.
  it('overrides a same-named global plugin with the project-scoped install', async () => {
    await mockLocalPluginDirs(['flow']);
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockResolvedValue(undefined);

    const result = await buildPluginsForCwd({ cwd: '/proj', globalPlugins: GLOBAL, logger });

    expect(result.map((p) => p.path)).toEqual([
      '/dork/plugins/reviewer',
      '/proj/.dork/plugins/flow',
    ]);
  });

  // Purpose: partial installs / junk dirs must never reach the SDK.
  it('skips directories without a package manifest and non-directory entries', async () => {
    await mockLocalPluginDirs(['real', 'partial'], ['stray-file.txt']);
    const fs = await import('node:fs/promises');
    vi.mocked(fs.access).mockImplementation(async (filePath) => {
      if (String(filePath).includes('partial')) throw new Error('ENOENT');
    });

    const result = await buildPluginsForCwd({ cwd: '/proj', globalPlugins: [], logger });

    expect(result.map((p) => p.path)).toEqual(['/proj/.dork/plugins/real']);
  });

  // Purpose: an empty .dork/plugins dir must behave exactly like a missing one.
  it('returns the global set as-is when .dork/plugins is empty', async () => {
    await mockLocalPluginDirs([]);

    const result = await buildPluginsForCwd({ cwd: '/proj', globalPlugins: GLOBAL, logger });

    expect(result).toBe(GLOBAL);
  });
});

/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@dorkos/shared/logger';
import { buildClaudeAgentSdkPluginsArray } from '../plugin-activation.js';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    access: vi.fn(),
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

    expect(result).toEqual([
      { type: 'local', path: '/tmp/dork/marketplace/packages/code-reviewer' },
    ]);
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
      '/tmp/dork/marketplace/packages/alpha',
      '/tmp/dork/marketplace/packages/beta',
      '/tmp/dork/marketplace/packages/gamma',
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
        expectedPath: '/tmp/dork/marketplace/packages/ghost',
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
      '/tmp/dork/marketplace/packages/present1',
      '/tmp/dork/marketplace/packages/present2',
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

    expect(result[0]?.path).toBe('/custom/dork/home/marketplace/packages/plugin');
  });
});

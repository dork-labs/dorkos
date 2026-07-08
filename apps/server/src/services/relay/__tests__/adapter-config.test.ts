import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile } from 'node:fs/promises';
import { loadAdapterConfig } from '../adapter-config.js';
import { logger } from '../../../lib/logger.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const CONFIG_PATH = '/mock/adapters.json';

describe('loadAdapterConfig — removed adapter types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('drops a stored telegram-chatsdk adapter with a migration warning, keeping the rest', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        adapters: [
          { id: 'legacy-sdk', type: 'telegram-chatsdk', enabled: true, config: { token: 'x' } },
          { id: 'telegram-1', type: 'telegram', enabled: true, config: { token: 'y' } },
        ],
      })
    );

    const configs = await loadAdapterConfig(CONFIG_PATH);

    // The removed-type entry is stripped; the valid adapter survives.
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ id: 'telegram-1', type: 'telegram' });

    // A clear migration warning is logged, naming the id and the replacement type.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("re-create the adapter with type 'telegram'")
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'legacy-sdk'"));
  });

  it('does not crash and returns no adapters when the only entry is a removed type', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        adapters: [
          { id: 'legacy-sdk', type: 'telegram-chatsdk', enabled: true, config: { token: 'x' } },
        ],
      })
    );

    const configs = await loadAdapterConfig(CONFIG_PATH);

    expect(configs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('the Telegram (Chat SDK) adapter was removed')
    );
  });

  it('leaves configs without removed types untouched and logs nothing', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        adapters: [{ id: 'telegram-1', type: 'telegram', enabled: true, config: { token: 'y' } }],
      })
    );

    const configs = await loadAdapterConfig(CONFIG_PATH);

    expect(configs).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

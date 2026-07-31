import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { loadAdapterConfig, saveAdapterConfig } from '../adapter-config.js';
import { logger } from '../../../lib/logger.js';

// Mock fs/promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ mode: 0o600 }),
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

    const { adapters: configs } = await loadAdapterConfig(CONFIG_PATH);

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

    const { adapters: configs } = await loadAdapterConfig(CONFIG_PATH);

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

    const { adapters: configs } = await loadAdapterConfig(CONFIG_PATH);

    expect(configs).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('loadAdapterConfig — secret-file permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(stat).mockResolvedValue({ mode: 0o600 } as Awaited<ReturnType<typeof stat>>);
  });

  const skipOnWindows = process.platform === 'win32' ? it.skip : it;

  skipOnWindows('tightens a group/world-readable adapters.json to 0600 on read', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
    vi.mocked(stat).mockResolvedValue({ mode: 0o644 } as Awaited<ReturnType<typeof stat>>);

    await loadAdapterConfig(CONFIG_PATH);

    expect(vi.mocked(chmod)).toHaveBeenCalledWith(CONFIG_PATH, 0o600);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('tightened it to owner-only'));
  });

  skipOnWindows('leaves an already-0600 adapters.json alone on read', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
    vi.mocked(stat).mockResolvedValue({ mode: 0o600 } as Awaited<ReturnType<typeof stat>>);

    await loadAdapterConfig(CONFIG_PATH);

    expect(vi.mocked(chmod)).not.toHaveBeenCalled();
  });
});

describe('saveAdapterConfig — secret-file permissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes adapters.json owner-only (0600) because it holds bot tokens', async () => {
    await saveAdapterConfig(CONFIG_PATH, [
      { id: 'telegram-1', type: 'telegram', enabled: true, config: { token: 'secret-bot-token' } },
    ] as never);

    // The atomic write stages to a tmp file with an owner-only create mode.
    // The tmp name is unique per write (DOR-697) and a sibling of the target,
    // so this matches its shape rather than pinning the exact filename.
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringMatching(/^\/mock\/\.adapters\.json\..+\.tmp$/),
      expect.any(String),
      expect.objectContaining({ mode: 0o600 })
    );
    // ...and the final path is re-asserted to 0600 after rename.
    expect(vi.mocked(chmod)).toHaveBeenCalledWith(CONFIG_PATH, 0o600);
  });
});

describe('loadAdapterConfig — one bad entry must not take the others down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A file holding one good Slack integration and one unreadable entry. */
  const MIXED = JSON.stringify({
    adapters: [
      {
        id: 'slack-1',
        type: 'slack',
        enabled: true,
        config: { botToken: 'a', appToken: 'b', signingSecret: 'c' },
      },
      { id: 'broken', type: 'telegram', enabled: 'yes please', config: null },
      { id: 'telegram-1', type: 'telegram', enabled: true, config: { token: 'y' } },
    ],
  });

  it('keeps the entries that parse', async () => {
    // The whole array used to be parsed at once, so ONE bad entry returned
    // nothing at all — and the next save wrote that nothing to disk.
    vi.mocked(readFile).mockResolvedValue(MIXED);

    const { adapters } = await loadAdapterConfig(CONFIG_PATH);

    expect(adapters.map((a) => a.id)).toEqual(['slack-1', 'telegram-1']);
  });

  it('reports the entry it skipped, by id', async () => {
    vi.mocked(readFile).mockResolvedValue(MIXED);

    await loadAdapterConfig(CONFIG_PATH);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("'broken'"),
      expect.anything()
    );
  });

  it('hands the unreadable entry back so a later save cannot erase it', async () => {
    vi.mocked(readFile).mockResolvedValue(MIXED);

    const { unparsed } = await loadAdapterConfig(CONFIG_PATH);

    expect(unparsed).toEqual([
      { id: 'broken', type: 'telegram', enabled: 'yes please', config: null },
    ]);
  });

  it('writes the unreadable entry back out when a later save runs', async () => {
    // The failure this closes: add an integration after a bad load, and the
    // save silently deleted every integration the person had.
    const { adapters, unparsed } = await (async () => {
      vi.mocked(readFile).mockResolvedValue(MIXED);
      return loadAdapterConfig(CONFIG_PATH);
    })();

    vi.mocked(writeFile).mockClear();
    await saveAdapterConfig(CONFIG_PATH, adapters, unparsed);

    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]![1] as string) as {
      adapters: Array<{ id: string }>;
    };
    expect(written.adapters.map((a) => a.id)).toEqual(['slack-1', 'telegram-1', 'broken']);
  });

  it('reads nothing and keeps nothing when the file is not an adapters file at all', async () => {
    vi.mocked(readFile).mockResolvedValue('{"nope": true}');

    const loaded = await loadAdapterConfig(CONFIG_PATH);

    expect(loaded).toEqual({ adapters: [], unparsed: [] });
    expect(logger.error).toHaveBeenCalled();
  });
});

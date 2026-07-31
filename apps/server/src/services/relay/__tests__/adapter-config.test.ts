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

  it('leaves configs without removed types untouched and logs no migration hint', async () => {
    vi.mocked(readFile).mockResolvedValue(
      JSON.stringify({
        adapters: [{ id: 'telegram-1', type: 'telegram', enabled: true, config: { token: 'y' } }],
      })
    );

    const { adapters: configs } = await loadAdapterConfig(CONFIG_PATH);

    expect(configs).toHaveLength(1);
    // No removed-type hint. There IS a warning — this stored integration
    // predates `dmPolicy`, so it is carried forward at 'open' and said out
    // loud (DOR-788, covered in safe-defaults.test.ts) — so this asserts on
    // the message rather than on silence.
    expect(
      vi.mocked(logger.warn).mock.calls.filter((call) => String(call[0]).includes('was removed'))
    ).toHaveLength(0);
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

describe('an unreadable entry does not become a permanent ghost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** One good entry and one unreadable entry that carries an id. */
  const WITH_GHOST = JSON.stringify({
    adapters: [
      {
        id: 'slack-1',
        type: 'slack',
        enabled: true,
        config: { botToken: 'a', appToken: 'b', signingSecret: 'c' },
      },
      { id: 'telegram-1', type: 'telegram', enabled: 'yes please', config: null },
    ],
  });

  it('drops the ghost once an integration with that id parses again', async () => {
    // The sequence a person actually walks: an integration breaks, they
    // re-create it under the same name. Writing both would leave two entries
    // sharing one id — a file no surface can make sense of afterwards.
    vi.mocked(readFile).mockResolvedValue(WITH_GHOST);
    const { adapters, unparsed } = await loadAdapterConfig(CONFIG_PATH);

    const recreated = [
      ...adapters,
      { id: 'telegram-1', type: 'telegram', enabled: true, config: { token: 'y' } },
    ] as never;

    vi.mocked(writeFile).mockClear();
    await saveAdapterConfig(CONFIG_PATH, recreated, unparsed);

    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]![1] as string) as {
      adapters: Array<{ id: string; enabled: unknown }>;
    };
    expect(written.adapters.map((a) => a.id)).toEqual(['slack-1', 'telegram-1']);
    // The surviving one is the working entry, not the ghost.
    expect(written.adapters.find((a) => a.id === 'telegram-1')?.enabled).toBe(true);
  });

  it('says which ghost it dropped', async () => {
    vi.mocked(readFile).mockResolvedValue(WITH_GHOST);
    const { adapters, unparsed } = await loadAdapterConfig(CONFIG_PATH);
    vi.mocked(logger.warn).mockClear();

    await saveAdapterConfig(
      CONFIG_PATH,
      [...adapters, { id: 'telegram-1', type: 'telegram', enabled: true, config: {} }] as never,
      unparsed
    );

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'telegram-1'"));
  });

  it('keeps a ghost whose id no parsed entry claims', async () => {
    vi.mocked(readFile).mockResolvedValue(WITH_GHOST);
    const { adapters, unparsed } = await loadAdapterConfig(CONFIG_PATH);

    vi.mocked(writeFile).mockClear();
    await saveAdapterConfig(CONFIG_PATH, adapters, unparsed);

    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]![1] as string) as {
      adapters: Array<{ id: string }>;
    };
    expect(written.adapters.map((a) => a.id)).toEqual(['slack-1', 'telegram-1']);
    expect(written.adapters[1]).toMatchObject({ enabled: 'yes please' });
  });

  it('warns that an unreadable entry may still hold a credential in plain text', async () => {
    // It is preserved verbatim, so the DOR-280 migration never touched it. That
    // is a different fact from "this entry did not load", with a different fix.
    vi.mocked(readFile).mockResolvedValue(WITH_GHOST);

    await loadAdapterConfig(CONFIG_PATH);

    const credentialWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter((call) => String(call[0]).includes('plain text'));
    expect(credentialWarnings).toHaveLength(1);
    expect(String(credentialWarnings[0]![0])).toContain("'telegram-1'");
    expect(String(credentialWarnings[0]![0])).toContain(CONFIG_PATH);
  });
});

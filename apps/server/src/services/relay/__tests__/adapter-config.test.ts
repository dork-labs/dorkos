import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, writeFile, chmod, stat } from 'node:fs/promises';
import { WEBHOOK_MANIFEST } from '@dorkos/relay';
import {
  AdapterConfigWrites,
  parseAdapterConfigForPersist,
  loadAdapterConfig,
  saveAdapterConfig,
  watchAdapterConfig,
} from '../adapter-config.js';
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

// Spy on the real logger (silenced) rather than mocking our own module.
beforeEach(() => {
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
});

/** Captured chokidar handlers so tests can fire them manually. */
let chokidarHandlers: Record<string, (arg?: unknown) => unknown>;

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => ({
      on: vi.fn((event: string, handler: (arg?: unknown) => unknown) => {
        chokidarHandlers[event] = handler;
      }),
      close: vi.fn(),
    })),
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

  it('keeps the entries that parse and hands back the one that did not', async () => {
    // The whole array used to be parsed at once, so ONE bad entry returned
    // nothing at all — and the next save wrote that nothing to disk.
    vi.mocked(readFile).mockResolvedValue(MIXED);

    const { adapters } = await loadAdapterConfig(CONFIG_PATH);

    expect(adapters.map((a) => a.id)).toEqual(['slack-1', 'telegram-1']);
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
});

describe('watchAdapterConfig — watcher error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chokidarHandlers = {};
  });

  it('logs a watcher error instead of throwing, and never treats it as a change', () => {
    const onChange = vi.fn();
    watchAdapterConfig(CONFIG_PATH, onChange);

    expect(() => chokidarHandlers.error!(new Error('EMFILE'))).not.toThrow();

    expect(onChange).not.toHaveBeenCalled();
    expect(String(vi.mocked(logger.warn).mock.calls[0]![0])).toContain(CONFIG_PATH);
  });

  // One fd-exhaustion episode can fire 'error' many times for one dead
  // watcher, so repeats of a code are dropped. Keyed on `code`, so a benign
  // EACCES cannot hide an EMFILE storm that follows it.
  it('logs the first error of each code once', () => {
    watchAdapterConfig(CONFIG_PATH, vi.fn());

    for (const code of ['EACCES', 'EMFILE', 'EMFILE', 'EMFILE']) {
      chokidarHandlers.error!(Object.assign(new Error(code), { code }));
    }

    expect(
      vi.mocked(logger.warn).mock.calls.map(([, ctx]) => (ctx as { code: string }).code)
    ).toEqual(['EACCES', 'EMFILE']);
  });
});

describe('persisted webhook namespace validation', () => {
  it.each(['relay.agent.codex.session', 'relay.doc.canvas-hash'])(
    'refuses %s without deleting raw entries or valid neighbors',
    async (subject) => {
      vi.clearAllMocks();
      const refused = {
        id: 'unsafe',
        type: 'webhook',
        enabled: true,
        config: {
          inbound: { subject, secret: 'fixture-secret-at-least16' },
          outbound: { url: 'https://example.com/hook', secret: 'fixture-secret-at-least16' },
          unknown: { preserve: true },
        },
      };
      const unknown = { id: 'unknown', type: 'future-type', config: { preserve: ['exact'] } };
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({
          adapters: [
            refused,
            unknown,
            { id: 'valid', type: 'telegram', enabled: false, config: { token: 'valid-token' } },
          ],
        })
      );
      const loaded = await loadAdapterConfig(CONFIG_PATH);
      expect(loaded.adapters.map((a) => a.id)).toEqual(['valid']);
      expect(loaded.unparsed).toEqual([refused, unknown]);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("'unsafe'"),
        expect.anything()
      );
      expect(writeFile).not.toHaveBeenCalled();
      await saveAdapterConfig(CONFIG_PATH, loaded.adapters, loaded.unparsed);
      const saved = JSON.parse(String(vi.mocked(writeFile).mock.calls.at(-1)![1]));
      expect(saved.adapters).toContainEqual(refused);
      expect(saved.adapters).toContainEqual(unknown);
      expect(saved.adapters.some((a: { id: string }) => a.id === 'valid')).toBe(true);
    }
  );
});

describe('AdapterConfigWrites — a hung save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ adapters: [] }));
  });

  // The adapter queue waits on reloads, and reloads wait on saves, so a save
  // that never finishes must not hold every later save and reload forever.
  it('stops waiting after the bound, says so, and lets later saves and reloads run', async () => {
    const writes = new AdapterConfigWrites(20);
    void writes.track(() => new Promise<void>(() => {}));
    const later = vi.fn(async () => undefined);
    const apply = vi.fn();

    await Promise.all([writes.track(later), writes.reloadInto(CONFIG_PATH, apply)]);

    expect(later).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has not finished'));
  });
});

// `fields` carries manifest field keys only: a record key a person typed (a
// header's name) is never sent back (review on DOR-4979).
describe('parseAdapterConfigForPersist fields', () => {
  it('names the owning field for a bad entry in a free-form map', () => {
    const attempt = () =>
      parseAdapterConfigForPersist(
        {
          id: 'wh-x',
          type: 'webhook',
          enabled: false,
          config: {
            inbound: { subject: 'relay.webhook.x', secret: 'secret-16-chars!!' },
            outbound: {
              url: 'https://example.com',
              secret: 'secret-16-chars!!',
              headers: { 'X-Private-Name': 5 },
            },
          },
        },
        WEBHOOK_MANIFEST
      );
    expect(attempt).toThrow(expect.objectContaining({ fields: ['outbound.headers'] }));
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * DOR-1509 adversarial review. This is the exact shape the reviewer
 * reproduced: an `AdapterManager.startEnabledAdapters()` failure (network
 * down at boot, so `TelegramAdapter.start()` rejects) used to log the raw
 * caught error, and the server's own NDJSON file reporter
 * (`apps/server/src/lib/logger.ts`'s `createFileReporter`) spreads an
 * object-shaped second logger argument straight into the persisted JSON
 * line — so the token rode all the way into `~/.dork/logs/dorkos.log`.
 *
 * Unlike `adapter-manager.test.ts` (which mocks `../../../lib/logger.js`
 * entirely, replacing it with bare spies), this file mocks only the
 * synchronous `fs` module — the same technique
 * `apps/server/src/lib/__tests__/logger.test.ts` uses — so the REAL
 * `initLogger()`/`logger` singleton and the REAL file reporter run, and
 * `fs.appendFileSync` captures the exact NDJSON line that would have been
 * written to disk.
 */

// Mock only the file-writing side of `fs` — `adapter-manager.ts`'s import
// graph reaches `config-manager.ts` -> `lib/version.ts`, which uses the REAL
// (named-import) `readFileSync` to read this package's own package.json at
// module load time. A bare `vi.mock('fs')` auto-mocks everything (including
// `readFileSync`, returning `undefined`) and breaks that unrelated read.
// `apps/server/src/lib/logger.ts` itself uses `import fs from 'fs'` (the
// DEFAULT export), so the three calls it makes have to be overridden on
// BOTH the named-export surface and the nested `default` object — CJS/ESM
// interop exposes the same functions both ways, and only replacing the
// named surface leaves `fs.mkdirSync(...)` (a property read off `default`)
// pointing at the real implementation.
vi.mock('fs', async () => {
  const actual = (await vi.importActual('fs')) as Record<string, unknown>;
  const overrides = { appendFileSync: vi.fn(), statSync: vi.fn(), mkdirSync: vi.fn() };
  return {
    ...actual,
    ...overrides,
    default: { ...(actual.default as Record<string, unknown> | undefined), ...overrides },
  };
});

// Mock fs/promises (adapters.json read/write) — same as adapter-manager.test.ts.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rename: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  // Owner-only mode, so adapter-config.ts's permission-repair path is a no-op
  // and does not add its own (unrelated) warning to the captured log lines.
  stat: vi.fn().mockResolvedValue({ mode: 0o600 }),
}));

// Mock chokidar — no real config-file watcher in a unit test.
vi.mock('chokidar', () => {
  const mockWatcher = {
    on: vi.fn().mockReturnThis(),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return { default: { watch: vi.fn().mockReturnValue(mockWatcher) } };
});

// Mock node:module (createRequire) — same redirect adapter-manager.test.ts uses,
// so enrichManifestsWithDocs()'s docs lookup resolves to a harmless fake path.
vi.mock('node:module', () => ({
  createRequire: () => ({
    resolve: (id: string) => (id === '@dorkos/relay' ? '/mock-relay/dist/index.js' : id),
  }),
}));

/**
 * Reproduces node-fetch@2.7.0's real `FetchError` shape — the class grammY
 * throws on every network-level failure on Node. node-fetch predates ES6
 * classes: its `FetchError` constructor does `Error.call(this, message)` and
 * then an explicit `this.message = message`, which — unlike a `class X
 * extends Error` subclass's `super()` — makes `.message` an OWN ENUMERABLE
 * property (verified against the installed node-fetch@2.7.0; also verified
 * in packages/relay/src/adapters/telegram/__tests__/telegram-adapter.test.ts,
 * where the same reproduction is used at the adapter layer). That is what
 * lets the token-bearing URL survive a naive `logger.warn('...', err)` with
 * no `toJSON()` involved at all.
 */
function fakeNodeFetchError(message: string): Error {
  const err = new Error(message);
  Object.defineProperty(err, 'message', { value: message, enumerable: true });
  return err;
}

/** grammY's own `HttpError` — wraps the raw FetchError on `.error`. */
class FakeGrammyHttpError extends Error {
  readonly error: unknown;
  constructor(safeMessage: string, rawFetchError: unknown) {
    super(safeMessage);
    this.name = 'HttpError';
    this.error = rawFetchError;
  }
}

const LEAKED_TOKEN = 'should-never-appear-in-dorkos-log';
const LEAKED_URL = `https://api.telegram.org/bot${LEAKED_TOKEN}/getMe`;
const REAL_SHAPED_REJECTION = new FakeGrammyHttpError(
  "Network request for 'getMe' failed!",
  fakeNodeFetchError(
    `request to ${LEAKED_URL} failed, reason: getaddrinfo ENOTFOUND api.telegram.org`
  )
);

// Mock only @dorkos/relay's TelegramAdapter (so its start() can be made to
// reject with the shape above); every other export — describeError,
// AdapterRegistry, manifests — passes through as the real implementation.
vi.mock('@dorkos/relay', async () => {
  const actual = await vi.importActual<object>('@dorkos/relay');
  return {
    ...actual,
    TelegramAdapter: vi.fn().mockImplementation(function (id: string) {
      return {
        id,
        subjectPrefix: 'relay.human.telegram',
        displayName: `Telegram (${id})`,
        start: vi.fn().mockRejectedValue(REAL_SHAPED_REJECTION),
        stop: vi.fn().mockResolvedValue(undefined),
        deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 0 }),
        getStatus: vi.fn().mockReturnValue({
          state: 'error',
          messageCount: { inbound: 0, outbound: 0 },
          errorCount: 1,
        }),
        testConnection: vi.fn().mockResolvedValue({ ok: false }),
        setLogger: vi.fn(),
        getMe: vi.fn().mockResolvedValue(null),
      };
    }),
  };
});

const ADAPTERS_JSON = JSON.stringify({
  adapters: [
    {
      id: 'tg-main',
      type: 'telegram',
      enabled: true,
      config: { token: 'bot-token-123', mode: 'polling' },
    },
  ],
});

describe('AdapterManager start-failure logging never leaks a token into the real NDJSON log (DOR-1509)', () => {
  let fs: typeof import('fs');

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fs = await import('fs');
    vi.mocked(fs.statSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  it('keeps the bot token out of every NDJSON line the real reporter writes when start() rejects on a dead network', async () => {
    const loggerModule = await import('../../../lib/logger.js');
    loggerModule.initLogger({ level: 5, logDir: '/test/logs' });

    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(ADAPTERS_JSON);

    const { AdapterRegistry } = await import('@dorkos/relay');
    const registry = new AdapterRegistry();
    registry.setRelay({
      publish: vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 0 }),
      onSignal: vi.fn().mockReturnValue(() => {}),
      subscribe: vi.fn().mockReturnValue(() => {}),
    });

    const { AdapterManager } = await import('../adapter-manager.js');
    const manager = new AdapterManager(registry, '/home/test/.dork/relay/adapters.json', {
      agentManager: { ensureSession: vi.fn(), sendMessage: vi.fn() } as never,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() } as never,
      // DOR-280 secret materialization needs a store — the config's token
      // is already cleartext test data, not something this test exercises.
      credentialStore: {
        put: vi.fn().mockResolvedValue('file:tg-main-token'),
        get: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
      } as never,
      credentialProvider: {
        resolve: vi.fn().mockResolvedValue({ ok: true, secret: 'bot-token-123' }),
      } as never,
    });

    await manager.initialize();
    await manager.adaptersStarted();

    // Every NDJSON line the real file reporter actually wrote — this is what
    // ends up in ~/.dork/logs/dorkos.log (and, from there, the desktop
    // main.log mirror and a diagnostic-report zip).
    const writtenLines = vi
      .mocked(fs.appendFileSync)
      .mock.calls.map(([, content]) => String(content))
      .join('');

    // Sanity check the assertion isn't vacuous: the failure really got logged.
    expect(writtenLines).toContain("Failed to start adapter 'tg-main'");
    expect(writtenLines).not.toContain(LEAKED_TOKEN);
    expect(writtenLines).not.toContain(LEAKED_URL);
  });
});

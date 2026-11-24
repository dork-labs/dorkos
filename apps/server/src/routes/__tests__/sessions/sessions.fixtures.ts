/**
 * Shared setup for the core `/api/sessions` route tests.
 *
 * Every session in these files is OWNED by the one fake runtime the mocked
 * registry hands out. That is a real limit: with a single runtime and no DB,
 * "nobody has bound this session yet" is not a state this mock can represent,
 * and neither is a model that belongs to one runtime while the session resolves
 * to another. Both live in `sessions-model-gate-unbound.test.ts`, against the
 * real registry and two runtimes.
 *
 * This module never imports the registry itself: each test file mocks
 * `runtime-registry.js` with {@link registryModule}, loaded from here inside
 * the mock factory, so nothing here may reach the registry or it would load
 * itself while it is being mocked.
 */
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionSettings } from '@dorkos/shared/types';
import { FakeAgentRuntime } from '@dorkos/test-utils';

/** Valid UUID for session ID params (routes validate UUID format). */
export const S1 = '00000000-0000-4000-8000-000000000001';

/** The runtime the mocked registry hands out; replaced before each test. */
export const runtimeHolder: { current: FakeAgentRuntime } = { current: new FakeAgentRuntime() };

/** Stands in for `RuntimeNotRegisteredError`, which the mocked module must export. */
class RuntimeNotRegisteredError extends Error {
  constructor(
    public readonly runtime: string,
    public readonly sessionId: string
  ) {
    super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
    this.name = 'RuntimeNotRegisteredError';
  }
}

/** The mocked `runtime-registry.js` module: one registry serving {@link runtimeHolder}. */
export function registryModule() {
  const rt = () => runtimeHolder.current;
  return {
    runtimeRegistry: {
      computerRuntimeForAgentPath: () => undefined,
      getDefault: vi.fn(rt),
      get: vi.fn(rt),
      listRuntimes: vi.fn(() => [rt()]),
      getAllCapabilities: vi.fn(() => ({})),
      getDefaultType: vi.fn(() => 'fake'),
      resolveForSession: vi.fn(async () => rt()),
      resolveForSessionWithOwnership: vi.fn(async () => ({ runtime: rt(), bound: true })),
      getSessionRuntimeType: vi.fn(async () => 'fake'),
      resolveSessionRuntime: vi.fn(async () => ({ type: 'fake', bound: true })),
      persistSessionRuntime: vi.fn(async () => {}),
      has: vi.fn(() => true),
      getSessionSettings: vi.fn(async () => null),
      getSessionAgentPath: vi.fn(async () => null),
      getNativeSessionCwd: vi.fn(() => null),
      saveSessionSettings: vi.fn(async () => {}),
      getSessionSettingsMany: vi.fn(() => new Map<string, SessionSettings>()),
    },
    RuntimeNotRegisteredError,
  };
}

type Registry = ReturnType<typeof registryModule>['runtimeRegistry'];

/**
 * The mocked `lib/boundary.js` module: the real one, with its two path checks
 * passing every made-up path through. No real boundary can hold them: they sit
 * at the filesystem root, and a boundary of `/` contains only itself (the
 * containment test is `root + sep`). A test that needs a refusal queues one on
 * `validateBoundaryOrDorkHome`.
 *
 * @param real - The real module, from the mock factory's `importOriginal`.
 */
export function boundaryModule<T extends object>(real: T): T {
  return {
    ...real,
    validateBoundary: vi.fn(async (p: string) => p),
    validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  };
}

/** What {@link useSessionsApp} needs from modules this file must not import. */
export interface SessionsAppDeps {
  /** The mocked registry, as the test file imported it. */
  runtimeRegistry: unknown;
  /** Unregisters the projector a detached turn ran against. */
  disposeProjector: (sessionId: string) => void;
  /** Starts the boundary at a root, as the server does at startup. */
  initBoundary: (root: string) => Promise<string>;
  /** Starts the config store in a data directory, as the server does at startup. */
  initConfigManager: (dorkHome: string) => unknown;
}

/**
 * Give each test a fresh fake runtime and a reset registry.
 *
 * The boundary starts at the filesystem root, as the server's startup would
 * set one (the path checks themselves are {@link boundaryModule}'s); the config
 * store lives in a throwaway folder.
 */
export function useSessionsApp(deps: SessionsAppDeps): void {
  const registry = deps.runtimeRegistry as Registry;

  beforeAll(async () => {
    await deps.initBoundary('/');
    deps.initConfigManager(mkdtempSync(join(tmpdir(), 'dorkos-sessions-routes-')));
  });

  beforeEach(() => {
    const fakeRuntime = new FakeAgentRuntime();
    runtimeHolder.current = fakeRuntime;
    vi.clearAllMocks();
    fakeRuntime.listSessions.mockResolvedValue([]);
    fakeRuntime.getSession.mockResolvedValue(null);
    fakeRuntime.getSessionETag.mockResolvedValue(null);
    fakeRuntime.getSessionTasks.mockResolvedValue([]);
    fakeRuntime.acquireLock.mockReturnValue(true);
    fakeRuntime.getLockInfo.mockReturnValue(null);
    fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
    // `mockReset()` before each default matters: `clearAllMocks` does NOT drain
    // a queued one-shot (`mockRejectedValueOnce`), and an unconsumed one fires
    // against whatever request gets there first (DOR-458). Every registry spy a
    // test overrides is reset, not just the ones that use `...Once` today.
    registry.resolveForSession.mockReset().mockResolvedValue(fakeRuntime);
    registry.resolveForSessionWithOwnership
      .mockReset()
      .mockResolvedValue({ runtime: fakeRuntime, bound: true });
    registry.getNativeSessionCwd.mockReset().mockReturnValue(null);
    registry.getSessionRuntimeType.mockReset().mockResolvedValue('fake');
    registry.persistSessionRuntime.mockReset().mockResolvedValue(undefined);
    registry.getSessionSettingsMany.mockReset().mockReturnValue(new Map());
    registry.getSessionSettings.mockReset().mockResolvedValue(null);
    registry.saveSessionSettings.mockReset().mockResolvedValue(undefined);
    registry.get.mockReset().mockReturnValue(fakeRuntime);
    registry.getDefault.mockReset().mockReturnValue(fakeRuntime);
    registry.listRuntimes.mockReset().mockReturnValue([fakeRuntime]);
    registry.has.mockReset().mockReturnValue(true);
    registry.getDefaultType.mockReset().mockReturnValue('fake');
  });

  afterEach(() => {
    // `POST /:id/messages` runs its turn DETACHED against the process-singleton
    // projector for S1. Disposing unregisters it, so the next test mints a
    // fresh one instead of inheriting the previous turn's state.
    deps.disposeProjector(S1);
  });
}

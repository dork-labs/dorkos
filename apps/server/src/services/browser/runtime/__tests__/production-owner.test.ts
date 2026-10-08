import { logger } from '../../../../lib/logger.js';
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  parseBrowserResult,
  validateEngineConfiguration,
  type EngineConfiguration,
} from '@dorkos/browser';
import type {
  BrowserLifecycleEngine,
  PrivateBrowserBirthOwner,
  PrivateBrowserRetirementReceiver,
} from '@dorkos/browser/server-owner';
import type {
  InstallResult,
  RuntimeInstallationStatus,
} from '@dorkos/browser/runtime-installation';
import { createProductionBrowserRuntimeOwner } from '../production-owner.js';

// Original producer/engine doubles exercise custody sequencing, not native acceptance or readiness.
const originals = vi.hoisted(() => ({ resolve: vi.fn(), construct: vi.fn() }));
vi.mock('../installed-package.js', () => ({
  resolveServerBrowserRuntimePackage: originals.resolve,
}));
vi.mock('@dorkos/browser/server-owner', async (load) => ({
  ...(await load<typeof import('@dorkos/browser/server-owner')>()),
  constructOwnedBrowserEngine: originals.construct,
}));
const hash = 'a'.repeat(64);
const verified: InstallResult = {
  state: 'verified-reused',
  cause: null,
  installationId: 'installation_verified_original',
  attemptId: 'fresh_attempt_original',
  generation: 1,
  observedVersion: '153.0.8010.12',
  executableSHA256: hash,
  platform: 'darwin',
  arch: 'arm64',
  currentManifestDigest: hash,
  journalDigest: hash,
  readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
};
const current: RuntimeInstallationStatus = {
  schemaVersion: 1,
  pinnedPackageVersion: '1.63.0',
  chromiumRevision: '1243',
  platform: 'darwin',
  arch: 'arm64',
  observation: 'files-only',
  readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
  state: 'installed-files',
  cause: null,
  installationId: verified.installationId,
  executableSHA256: hash,
  currentManifestDigest: hash,
  lastFreshVerifiedVersion: verified.observedVersion,
  historicalAttemptId: 'historical_attempt_original',
  historicalGeneration: 0,
  verificationDigest: hash,
};
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const never = () => new Promise<never>(() => {});
  let ordinary = true,
    custody = true,
    identity = '';
  const receiver: PrivateBrowserRetirementReceiver = {
    browserId: 'browser_original_native_00001',
    browserGeneration: 1,
    acquisition: { mode: 'ephemeral' },
    observation: never(),
    isOrdinary: () => ordinary,
    isAuthorityCurrent: () => custody,
    navigateInitial: async () => {
      throw new Error('unused');
    },
    verifiedBrowserAdminEndpoint: () => null,
    verifiedRuntimeBinding: () => ({
      runtimeIdentity: identity,
      policyRevision: 1,
    }),
    disabled: never,
    authorityRevoked: never,
    persistenceFailure: never,
    generationReturned: async () => null,
    consumeGenerationReturn: () => false,
  };
  const settings: Omit<EngineConfiguration, 'runtime'> = {
    dataDir: '/owned/browser',
    network: { kind: 'owned', origin: 'about:blank', policyRevision: 1 },
    clock: { wallNow: Date.now, monotonicNow: performance.now },
    processes: {
      observe: async () => ({ status: 'unknown' }),
      descendants: async () => ({ status: 'unknown', identities: [] }),
    },
    policy: {
      authorizeAction: async () => 'refused',
      verifyBrokerLease: async () => 'revoked',
    },
  };
  const participant: PrivateBrowserBirthOwner & {
    bindEngine(engine: BrowserLifecycleEngine): void;
  } = {
    bindEngine: vi.fn(),
    input: { registerDispatcher: vi.fn() },
    capture: { registerDispatcher: vi.fn() },
    navigation: { registerDispatcher: vi.fn() },
    network: {
      bindBeforeLaunch: async () => {
        throw new Error('unused');
      },
      activateReady: async () => {},
    },
    registerBirth: vi.fn(),
    refuseBirth: vi.fn(),
  };
  const result = parseBrowserResult({
    kind: 'opened',
    requestId: 'request_original_native_00001',
    browserId: receiver.browserId,
    browserGeneration: 1,
    mode: 'ephemeral',
    tab: {
      browserId: receiver.browserId,
      browserGeneration: 1,
      tabId: 'tab_original_native_000000001',
      navigationGeneration: 0,
      viewportVersion: 0,
      epoch: 0,
      inputGeneration: 0,
    },
  });
  if (result.kind !== 'opened') throw new Error('fixture result');
  let constructedOwner: PrivateBrowserBirthOwner | undefined;
  const engine: BrowserLifecycleEngine = {
    open: vi.fn(async () => {
      if (!constructedOwner) throw new Error('original constructor absent');
      constructedOwner.registerBirth(receiver);
      return result;
    }),
    diagnostics: () => {
      throw new Error('unused');
    },
    listTabs: () => [],
    capture: async () => {
      throw new Error('unused');
    },
    input: async () => {
      throw new Error('unused');
    },
    resetInput: async () => {
      throw new Error('unused');
    },
    close: async () => {
      throw new Error('unused');
    },
    shutdown: vi.fn(async () => []),
  };
  const verify = vi.fn(async (): Promise<InstallResult> => verified),
    inspect = vi.fn(async (): Promise<RuntimeInstallationStatus> => current);
  originals.resolve.mockResolvedValue({
    configuration: { cacheRoot: '/owned/cache', libraryRoot: '/owned/library' },
    installation: { verifyExisting: verify, inspectExisting: inspect },
  });
  originals.construct.mockImplementation(
    (config: EngineConfiguration, owner: PrivateBrowserBirthOwner) => {
      const actual = validateEngineConfiguration(config);
      identity = createHash('sha256').update(JSON.stringify(actual.runtime)).digest('hex');
      constructedOwner = owner;
      return engine;
    }
  );
  return {
    settings,
    participant,
    engine,
    result,
    receiver,
    verify,
    inspect,
    setCustody: (value: boolean) => {
      custody = value;
    },
    setOrdinary: (value: boolean) => {
      ordinary = value;
    },
    setIdentity: (value: string) => {
      identity = value;
    },
  };
}
beforeEach(() => vi.clearAllMocks());

/** Register release and exact owner joins before the first producer enters. */
function owned(release: () => void = () => {}) {
  const f = setup();
  const owner = createProductionBrowserRuntimeOwner();
  const originals: { opening?: ReturnType<typeof owner.open> } = {};
  const accepted: unknown[] = [];
  const observed: Promise<unknown>[] = [];
  onTestFinished(async () => {
    let first: { reason: unknown } | undefined;
    try {
      release();
    } catch (reason) {
      first = { reason };
    }
    const closing = owner.close();
    const joined = await Promise.allSettled([originals.opening, closing, ...observed]);
    for (const result of joined)
      if (
        result.status === 'rejected' &&
        !accepted.some((reason) => Object.is(reason, result.reason))
      )
        first ??= { reason: result.reason };
    if (first) throw first.reason;
  });
  return {
    ...f,
    owner,
    accept: (reason: unknown) => accepted.push(reason),
    track(original: Promise<unknown>) {
      observed.push(original);
    },
    open(signal?: AbortSignal, identityMode?: 'native' | 'chrome-compatible') {
      const original = owner.open(f.settings, f.participant, {}, signal, identityMode);
      originals.opening = original;
      void original.catch(() => {});
      return original;
    },
  };
}
async function rejected(original: Promise<unknown>): Promise<{ reason: unknown }> {
  try {
    await original;
  } catch (reason) {
    return { reason };
  }
  throw new Error('EXPECTED_ORIGINAL_REJECTION');
}
it('keeps installed verification separate from public readiness and requires all private participants', async () => {
  const missing = owned();
  const failure = await rejected(
    missing.owner.open(missing.settings, { ...missing.participant, capture: undefined }, {})
  );
  missing.accept(failure.reason);
  expect(failure.reason).toMatchObject({ code: 'UNSUPPORTED' });
  expect(originals.resolve).not.toHaveBeenCalled();
  expect(originals.construct).not.toHaveBeenCalled();
  await expect(missing.owner.close()).rejects.toBe(failure.reason);
  const f = owned();
  const result = await f.open();
  expect(result.engine).toBe(f.engine);
  expect(verified.readiness.state).toBe('unavailable');
  expect(current.readiness.state).toBe('unavailable');
  expect(f.owner.isNativeCurrent(f.engine)).toBe(true); // Private custody only; no ready API or mount.
  expect(f.owner.isNativeCurrent({ ...f.engine })).toBe(false);
});
it('captures all original dispatcher/navigation receivers before held verification and consumes the same constructor owner', async () => {
  const turn = held<InstallResult>();
  const f = owned(() => turn.resolve(verified));
  f.verify.mockImplementation(() => turn.promise);
  const participants = [f.participant.input!, f.participant.capture!, f.participant.navigation!];
  const calls: unknown[] = [];
  for (const participant of participants)
    participant.registerDispatcher = function (this: unknown, value: unknown) {
      expect(this).toBe(participant);
      calls.push(value);
    };
  const transition = vi.fn();
  const continuation = {
    acquire: vi.fn(async function (this: unknown) {
      expect(this).toBe(continuation);
      return {
        authorization: {
          isCurrent: () => false,
          authorize: async () => 'refused' as const,
        },
        ready: Promise.resolve(),
        complete: vi.fn(),
        close: async () => {},
      };
    }),
    joinPublications: vi.fn(async function (this: unknown) {
      expect(this).toBe(continuation);
    }),
    observeTransition: transition,
  };
  Object.defineProperty(f.participant.navigation!, 'continuation', {
    value: continuation,
    configurable: true,
  });
  const lifetime = vi.fn(function (this: unknown, receiver: unknown) {
    expect(this).toBe(participants[2]);
    expect(receiver).toBe(f.receiver);
  });
  f.participant.navigation!.observeLifetime = lifetime;
  const opening = f.open();
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  for (const participant of participants)
    participant.registerDispatcher = () => {
      throw new Error('REPLACEMENT_ENTERED');
    };
  f.participant.navigation!.observeLifetime = () => {
    throw new Error('REPLACEMENT_ENTERED');
  };
  Object.defineProperty(f.participant, 'navigation', {
    value: {
      registerDispatcher() {
        throw new Error('REPLACEMENT_NAVIGATION_ENTERED');
      },
    },
    configurable: true,
  });
  const originalAcquire = continuation.acquire;
  continuation.acquire = vi.fn(async () => {
    throw new Error('REPLACEMENT_ENTERED');
  });
  const originalConstruct = originals.construct.getMockImplementation()!;
  originals.construct.mockImplementation((configuration, owner: PrivateBrowserBirthOwner) => {
    const markers = [{ input: vi.fn() }, { capture: vi.fn() }, { navigate: vi.fn() }];
    owner.input!.registerDispatcher(markers[0] as never);
    owner.capture!.registerDispatcher(markers[1] as never);
    owner.navigation!.registerDispatcher(markers[2] as never);
    expect(calls).toEqual(markers);
    owner.navigation!.observeLifetime?.(f.receiver);
    expect(lifetime).toHaveBeenCalledOnce();
    const old = owner.navigation!.continuation!;
    // Observe the consumed captured original without allowing an unused helper to satisfy the test.
    const acquisition = old.acquire(f.result.tab);
    f.track(acquisition);
    expect(originalAcquire).toHaveBeenCalledOnce();
    expect(continuation.acquire).not.toHaveBeenCalled();
    f.track(old.joinPublications(f.result.tab));
    old.observeTransition?.(f.result.tab, Promise.resolve(f.result.tab));
    expect(transition).toHaveBeenCalledOnce();
    return originalConstruct(configuration, owner);
  });
  turn.resolve(verified);
  await opening;
});
it('close retains the whole held verifier and never constructs from its late result', async () => {
  const turn = held<InstallResult>();
  const f = owned(() => turn.resolve(verified));
  f.verify.mockImplementation(() => turn.promise);
  const opening = f.open();
  await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
  let settled = false;
  const closing = f.owner.close();
  void closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  turn.resolve(verified);
  const failure = await rejected(opening);
  f.accept(failure.reason);
  expect(failure.reason).toMatchObject({ code: 'CLOSED' });
  await expect(closing).rejects.toBe(failure.reason);
  expect(originals.construct).not.toHaveBeenCalled();
});
it.each([undefined, false])(
  'retains exact falsy original verifier failure %s before independent cleanup',
  async (reason) => {
    const f = owned();
    f.verify.mockRejectedValue(reason);
    const failure = await rejected(f.open());
    f.accept(failure.reason);
    expect(failure.reason).toBe(reason);
    await expect(f.owner.close()).rejects.toBe(reason);
    expect(originals.construct).not.toHaveBeenCalled();
  }
);
it('reentrant shutdown getter close fences the captured binder and joins original shutdown', async () => {
  const stopping = held<Awaited<ReturnType<BrowserLifecycleEngine['shutdown']>>>();
  const f = owned(() => stopping.resolve([]));
  const originalShutdown = vi.fn(() => stopping.promise);
  Object.defineProperty(f.engine, 'shutdown', {
    get() {
      void f.owner.close().catch(() => {});
      return originalShutdown;
    },
  });
  const failure = await rejected(f.open());
  f.accept(failure.reason);
  expect(failure.reason).toMatchObject({ code: 'CLOSED' });
  expect(f.participant.bindEngine).not.toHaveBeenCalled();
  expect(f.engine.open).not.toHaveBeenCalled();
  let settled = false;
  const closing = f.owner.close();
  void closing.catch(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  stopping.resolve([]);
  await expect(closing).rejects.toBe(failure.reason);
  expect(originalShutdown).toHaveBeenCalledOnce();
});

it('a captured participant getter throwing undefined remains the exact owner close failure before package work', async () => {
  const f = owned();
  let enteredClose: ReturnType<typeof f.owner.close> | undefined;
  Object.defineProperty(f.participant.navigation!, 'registerDispatcher', {
    get() {
      enteredClose = f.owner.close();
      void enteredClose.catch(() => {});
      throw undefined;
    },
  });
  const failure = await rejected(f.open());
  f.accept(failure.reason);
  expect(failure.reason).toBeUndefined();
  expect(enteredClose).toBe(f.owner.close());
  await expect(enteredClose!).rejects.toBeUndefined();
  expect(originals.resolve).not.toHaveBeenCalled();
  expect(originals.construct).not.toHaveBeenCalled();
});

it('the consumed participant getter cannot reenter a second acquisition before the first verifier', async () => {
  const f = owned();
  const input = f.participant.input;
  let inner: ReturnType<typeof f.owner.open> | undefined;
  Object.defineProperty(f.participant, 'input', {
    get() {
      inner = f.owner.open(f.settings, f.participant, {});
      void inner.catch(() => {});
      f.track(inner);
      return input;
    },
  });
  const result = await f.open();
  expect(result.engine).toBe(f.engine);
  expect(inner).toBeDefined();
  const refusal = await rejected(inner!);
  f.accept(refusal.reason);
  expect(refusal.reason).toMatchObject({ code: 'BUSY' });
  expect(originals.resolve).toHaveBeenCalledOnce();
  expect(f.verify).toHaveBeenCalledOnce();
  expect(originals.construct).toHaveBeenCalledOnce();
  expect(f.engine.open).toHaveBeenCalledOnce();
});

it.each(['input', 'capture', 'navigation'] as const)(
  'a present %s owner with no registration cannot reach verification or construction',
  async (kind) => {
    const f = owned();
    Object.defineProperty(f.participant[kind]!, 'registerDispatcher', {
      value: undefined,
    });
    const failure = await rejected(f.open());
    f.accept(failure.reason);
    expect(failure.reason).toMatchObject({ code: 'UNSUPPORTED' });
    expect(originals.resolve).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(originals.construct).not.toHaveBeenCalled();
    await expect(f.owner.close()).rejects.toBe(failure.reason);
  }
);
it('configuration receiver getters are captured once and constructor callbacks use those exact original receivers', async () => {
  const f = owned();
  const rawClock = {
    wallNow() {
      expect(this).toBe(rawClock);
      return 1;
    },
    monotonicNow() {
      expect(this).toBe(rawClock);
      return 1;
    },
  };
  const rawProcesses = {
    observe: async function () {
      expect(this).toBe(rawProcesses);
      return { status: 'unknown' as const };
    },
    descendants: async function () {
      expect(this).toBe(rawProcesses);
      return { status: 'unknown' as const, identities: [] };
    },
  };
  const rawPolicy = {
    authorizeAction: async function () {
      expect(this).toBe(rawPolicy);
      return 'refused' as const;
    },
    verifyBrokerLease: async function () {
      expect(this).toBe(rawPolicy);
      return 'revoked' as const;
    },
  };
  const reads = { clock: 0, processes: 0, policy: 0, nativeJournal: 0 };
  for (const [key, value] of Object.entries({
    clock: rawClock,
    processes: rawProcesses,
    policy: rawPolicy,
    nativeJournal: undefined,
  })) {
    Object.defineProperty(f.settings, key, {
      get() {
        const name = key as keyof typeof reads;
        if (++reads[name] !== 1) throw new Error('REPLACEMENT_CONFIGURATION_RECEIVER');
        return value;
      },
    });
  }
  const construct = originals.construct.getMockImplementation()!;
  originals.construct.mockImplementation(
    (configuration: EngineConfiguration, owner: PrivateBrowserBirthOwner) => {
      configuration.clock.wallNow();
      configuration.clock.monotonicNow();
      for (const original of [
        configuration.processes.observe,
        configuration.processes.descendants,
        configuration.policy.authorizeAction,
        configuration.policy.verifyBrokerLease,
      ]) {
        f.track(Reflect.apply(original, undefined, []) as Promise<unknown>);
      }
      return construct(configuration, owner);
    }
  );
  await f.open();
  expect(reads).toEqual({
    clock: 1,
    processes: 1,
    policy: 1,
    nativeJournal: 1,
  });
});

// The real constructor's canonical parser is consumed by the original constructor double above.
it.each([false, true])(
  'preserves absent journal fields before real configuration validation (%s)',
  async (includeWorker) => {
    const f = owned();
    f.settings.nativeJournal = {
      workerPath: '/owned/journal-worker.mjs',
      artifact: { path: '/owned/process-observer', sha256: hash },
      duration: 30000,
      maxGap: 5000,
      ...(includeWorker
        ? { browserWorkerPath: '/owned/browser-worker.mjs', continuous: false }
        : {}),
    };
    await expect(f.open()).resolves.toMatchObject({ opened: f.result });
    const configured = originals.construct.mock.calls[0]![0] as EngineConfiguration;
    const journal = configured.nativeJournal!;
    expect(Object.prototype.hasOwnProperty.call(journal, 'onDiagnostic')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(journal, 'browserWorkerPath')).toBe(includeWorker);
    expect(Object.prototype.hasOwnProperty.call(journal, 'continuous')).toBe(includeWorker);
    expect(() => validateEngineConfiguration(configured)).not.toThrow();
    // Do not weaken the exact parser merely to accept a malformed private projection.
    expect(() =>
      validateEngineConfiguration({
        ...configured,
        nativeJournal: { ...journal, onDiagnostic: undefined },
      })
    ).toThrow(expect.objectContaining({ code: 'INVALID_CONFIGURATION' }));
  }
);
it('captures a present original journal diagnostic with its actual receiver', async () => {
  const f = owned();
  const received: unknown[] = [];
  const diagnostic = vi.fn(function (this: unknown) {
    received.push(this);
  });
  const journal = (f.settings.nativeJournal = {
    workerPath: '/owned/journal-worker.mjs',
    artifact: { path: '/owned/process-observer', sha256: hash },
    duration: 30000,
    maxGap: 5000,
    onDiagnostic: diagnostic,
  });
  await f.open();
  const actual = (originals.construct.mock.calls[0]![0] as EngineConfiguration).nativeJournal!;
  await actual.onDiagnostic!({} as Parameters<NonNullable<typeof actual.onDiagnostic>>[0]);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(received).toEqual([journal]);
});

it.each([false, undefined])(
  'a failing custody diagnostic sink cannot replace original custody refusal (%s)',
  async (sinkFailure) => {
    const emit = vi.spyOn(logger, 'info').mockImplementation(() => {
      throw sinkFailure;
    });
    onTestFinished(() => {
      emit.mockRestore();
    });
    const f = owned();
    const read = vi.fn(() => 'transport' as const);
    f.receiver.authorityCustodyRefusal = read;
    await f.open();
    f.receiver.authorityCustodyRefusal = () => {
      throw new Error('replacement must not enter');
    };
    f.setCustody(false);
    expect(f.owner.isNativeCurrent(f.engine)).toBe(false);
    const closed = await rejected(f.owner.close());
    f.accept(closed.reason);
    expect(closed.reason).toMatchObject({ code: 'CUSTODY_UNCERTAIN' });
    expect(read).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('Browser original custody refusal stage', {
      stage: 'transport',
      ordinal: 1,
    });
  }
);

it.each([
  ['unverified', 'observationUnavailable'],
  ['failed', 'closeFailed'],
  ['failed', 'processesRemain'],
] as const)(
  'reports the exact original shutdown classification %s/%s after its natural return',
  async (cleanup, reason) => {
    const emit = vi.spyOn(logger, 'info').mockImplementation(() => {});
    onTestFinished(() => {
      emit.mockRestore();
    });
    const stopping = held<Awaited<ReturnType<BrowserLifecycleEngine['shutdown']>>>();
    const closeResult = parseBrowserResult({
      kind: 'close',
      requestId: 'shutdown_result_original_001',
      browserId: 'browser_original_native_00001',
      browserGeneration: 1,
      cleanup,
      reason,
    });
    if (closeResult.kind !== 'close') throw new Error('CONTROL_CLOSE_RESULT');
    const f = owned(() => stopping.resolve([closeResult]));
    vi.mocked(f.engine.shutdown).mockImplementation(() => stopping.promise);
    await f.open();
    emit.mockClear(); // Count only the original shutdown or retirement observation.

    const closing = f.owner.close();
    void closing.catch(() => {});
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(emit).not.toHaveBeenCalled();
    stopping.resolve([closeResult]);
    const original = await rejected(closing);
    f.accept(original.reason);
    expect(original.reason).toMatchObject({ code: 'CUSTODY_UNCERTAIN' });
    expect(emit).toHaveBeenCalledWith('Browser original shutdown refused result', {
      cleanup,
      reason,
      ordinal: 1,
    });
    expect(f.engine.shutdown).toHaveBeenCalledOnce();
  }
);
it.each([false, undefined])(
  'preserves refused original shutdown when its diagnostic logger throws %s',
  async (sinkFailure) => {
    const emit = vi.spyOn(logger, 'info').mockImplementation(() => {
      throw sinkFailure;
    });
    onTestFinished(() => {
      emit.mockRestore();
    });
    const f = owned();
    const closeResult = parseBrowserResult({
      kind: 'close',
      requestId: 'shutdown_result_original_001',
      browserId: f.receiver.browserId,
      browserGeneration: 1,
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    });
    if (closeResult.kind !== 'close') throw new Error('CONTROL_CLOSE_RESULT');
    vi.mocked(f.engine.shutdown).mockResolvedValue([closeResult]);
    await f.open();
    emit.mockClear(); // Count only the original shutdown or retirement observation.

    const original = await rejected(f.owner.close());
    f.accept(original.reason);
    expect(original.reason).toMatchObject({ code: 'CUSTODY_UNCERTAIN' });
    expect(emit).toHaveBeenCalledOnce();
  }
);
it('does not enter an original reason getter or heal a refused close result', async () => {
  const emit = vi.spyOn(logger, 'info').mockImplementation(() => {});
  onTestFinished(() => {
    emit.mockRestore();
  });
  const f = owned();
  const closeResult = parseBrowserResult({
    kind: 'close',
    requestId: 'shutdown_result_original_001',
    browserId: f.receiver.browserId,
    browserGeneration: 1,
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  if (closeResult.kind !== 'close') throw new Error('CONTROL_CLOSE_RESULT');
  const read = vi.fn(() => {
    throw undefined;
  });
  Object.defineProperty(closeResult, 'reason', { get: read });
  vi.mocked(f.engine.shutdown).mockResolvedValue([closeResult]);
  await f.open();
  const original = await rejected(f.owner.close());
  f.accept(original.reason);
  expect(original.reason).toMatchObject({ code: 'CUSTODY_UNCERTAIN' });
  expect(read).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith('Browser original shutdown refused result', {
    cleanup: 'unverified',
    reason: 'invalid',
    ordinal: 1,
  });
});

function sealedRetirement(): Awaited<PrivateBrowserRetirementReceiver['observation']> {
  return Object.freeze({
    cleanup: Object.freeze({
      state: 'unverified' as const,
      coverage: 'closed' as const,
      pending: false,
      uncertainty: Object.freeze(['permitUnavailable' as const]),
    }),
    owners: Object.freeze([
      Object.freeze({
        identity: Object.freeze({}),
        observation: Object.freeze({
          state: 'unverified' as const,
          binding: null,
          reason: 'permitUnavailable' as const,
          pending: false,
          uncertainty: true as const,
        }),
      }),
    ]),
    terminal: Object.freeze({
      cleanup: 'unverified' as const,
      reason: 'observationUnavailable' as const,
    }),
    firstCause: 'explicitStop' as const,
    uncertainty: Object.freeze(['permitUnavailable' as const, 'terminalCloseFailed' as const]),
  });
}
it('observes the captured original retirement promise once without joining it or reading replacement getters', async () => {
  const emit = vi.spyOn(logger, 'info').mockImplementation(() => {});
  onTestFinished(() => {
    emit.mockRestore();
  });
  const original = held<Awaited<PrivateBrowserRetirementReceiver['observation']>>();
  const f = owned(() => original.resolve(sealedRetirement()));
  const read = vi.fn(() => original.promise);
  Object.defineProperty(f.receiver, 'observation', {
    configurable: true,
    get: read,
  });
  await f.open();
  emit.mockClear(); // Count only the original shutdown or retirement observation.

  expect(read).toHaveBeenCalledOnce();
  expect(f.participant.registerBirth).toHaveBeenCalledOnce();
  Object.defineProperty(f.receiver, 'observation', {
    get: () => {
      throw false;
    },
  });
  await f.owner.close(); // Diagnostic observation is not a new cleanup wait.
  expect(emit).not.toHaveBeenCalled();
  original.resolve(sealedRetirement());
  await Promise.resolve();
  expect(emit).toHaveBeenCalledWith('Browser original sealed retirement result', {
    ordinal: 1,
    closeStage: 'unavailable',
    aggregateState: 'unverified',
    coverage: 'closed',
    pending: false,
    aggregateReasons: ['permitUnavailable'],
    ownerCount: 1,
    firstOwnerState: 'unverified',
    firstOwnerReason: 'permitUnavailable',
    firstOwnerPending: false,
    terminalCleanup: 'unverified',
    terminalReason: 'observationUnavailable',
    firstCause: 'explicitStop',
  });
});
it.each([false, undefined])(
  'a reentrant retirement diagnostic sink fault %s cannot settle or replace held original shutdown',
  async (sinkFailure) => {
    const retired = held<Awaited<PrivateBrowserRetirementReceiver['observation']>>();
    const stopping = held<Awaited<ReturnType<BrowserLifecycleEngine['shutdown']>>>();
    const bank: {
      owner?: ReturnType<typeof createProductionBrowserRuntimeOwner>;
      reentered?: Promise<void>;
    } = {};
    const emit = vi.spyOn(logger, 'info').mockImplementation((message) => {
      if (message === 'Browser original sealed retirement result') {
        bank.reentered = bank.owner!.close();
        throw sinkFailure;
      }
    });
    onTestFinished(() => {
      emit.mockRestore();
    });
    const f = owned(() => {
      retired.resolve(sealedRetirement());
      stopping.resolve([]);
    });
    bank.owner = f.owner;
    Object.defineProperty(f.receiver, 'observation', {
      value: retired.promise,
    });
    vi.mocked(f.engine.shutdown).mockImplementation(() => stopping.promise);
    await f.open();
    const closing = f.owner.close();
    void closing.catch(() => {});
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    retired.resolve(sealedRetirement());
    await Promise.resolve();
    expect(bank.reentered).toBe(closing);
    expect(settled).toBe(false);
    expect(f.engine.shutdown).toHaveBeenCalledOnce();
    stopping.resolve([]);
    await closing;
  }
);
it.each([false, undefined])(
  'diagnostic registration fault %s cannot refuse a genuine original birth',
  async (cause) => {
    const f = owned();
    const read = vi.fn(() => {
      throw cause;
    });
    Object.defineProperty(f.receiver, 'observation', { get: read });
    await expect(f.open()).resolves.toMatchObject({ opened: f.result });
    expect(read).toHaveBeenCalledOnce();
    expect(f.owner.isNativeCurrent(f.engine)).toBe(true);
    await f.owner.close();
  }
);

it.each([false, undefined])(
  'preserves original shutdown rejection %s after a failed retirement diagnostic',
  async (cause) => {
    const retired = held<Awaited<PrivateBrowserRetirementReceiver['observation']>>();
    const emit = vi.spyOn(logger, 'info').mockImplementation(() => {
      throw new Error('DIAGNOSTIC_ONLY');
    });
    onTestFinished(() => {
      emit.mockRestore();
    });
    const f = owned(() => retired.resolve(sealedRetirement()));
    Object.defineProperty(f.receiver, 'observation', {
      value: retired.promise,
    });
    vi.mocked(f.engine.shutdown).mockRejectedValue(cause);
    await f.open();
    retired.resolve(sealedRetirement());
    const original = await rejected(f.owner.close());
    f.accept(original.reason);
    expect(original.reason).toBe(cause);
    expect(f.engine.shutdown).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      'Browser original sealed retirement result',
      expect.objectContaining({ firstOwnerReason: 'permitUnavailable' })
    );
  }
);

it('reads only the captured close-stage method after the original sealed terminal refusal', async () => {
  const emit = vi.spyOn(logger, 'info').mockImplementation(() => {});
  onTestFinished(() => {
    emit.mockRestore();
  });
  const retired = held<Awaited<PrivateBrowserRetirementReceiver['observation']>>();
  const f = owned(() => retired.resolve(sealedRetirement()));
  const receivers: unknown[] = [];
  const read = vi.fn(function (this: unknown) {
    receivers.push(this);
    return 'snapshot' as const;
  });
  f.receiver.retirementCloseRefusal = read;
  Object.defineProperty(f.receiver, 'observation', { value: retired.promise });
  await f.open();
  expect(read).not.toHaveBeenCalled();
  f.receiver.retirementCloseRefusal = () => {
    throw false;
  };
  retired.resolve(sealedRetirement());
  await Promise.resolve();
  expect(read).toHaveBeenCalledOnce();
  expect(receivers).toEqual([f.receiver]);
  expect(emit).toHaveBeenCalledWith(
    'Browser original sealed retirement result',
    expect.objectContaining({ closeStage: 'snapshot' })
  );
  await f.owner.close();
});
it.each([false, undefined])(
  'a close-stage diagnostic method fault %s cannot omit sealed data or replace original shutdown rejection',
  async (cause) => {
    const emit = vi.spyOn(logger, 'info').mockImplementation(() => {});
    onTestFinished(() => {
      emit.mockRestore();
    });
    const retired = held<Awaited<PrivateBrowserRetirementReceiver['observation']>>();
    const f = owned(() => retired.resolve(sealedRetirement()));
    f.receiver.retirementCloseRefusal = () => {
      throw cause;
    };
    Object.defineProperty(f.receiver, 'observation', {
      value: retired.promise,
    });
    vi.mocked(f.engine.shutdown).mockRejectedValue(cause);
    await f.open();
    retired.resolve(sealedRetirement());
    const original = await rejected(f.owner.close());
    f.accept(original.reason);
    expect(original.reason).toBe(cause);
    expect(emit).toHaveBeenCalledWith(
      'Browser original sealed retirement result',
      expect.objectContaining({
        closeStage: 'unavailable',
        firstOwnerReason: 'permitUnavailable',
      })
    );
  }
);
it('does not read close-stage data for an observed original terminal result', async () => {
  const emit = vi.spyOn(logger, 'info').mockImplementation(() => {});
  onTestFinished(() => {
    emit.mockRestore();
  });
  const retired = held<Awaited<PrivateBrowserRetirementReceiver['observation']>>();
  const positive: Awaited<PrivateBrowserRetirementReceiver['observation']> = Object.freeze({
    cleanup: Object.freeze({
      state: 'settled',
      coverage: 'closed',
      pending: false,
      uncertainty: Object.freeze([]) as readonly [],
    }),
    owners: Object.freeze([]),
    terminal: Object.freeze({ cleanup: 'observed' }),
    firstCause: 'explicitStop',
    uncertainty: Object.freeze([]),
  });
  const f = owned(() => retired.resolve(positive));
  const read = vi.fn(() => 'terminal' as const);
  f.receiver.retirementCloseRefusal = read;
  Object.defineProperty(f.receiver, 'observation', { value: retired.promise });
  await f.open();
  retired.resolve(positive);
  await Promise.resolve();
  expect(read).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith(
    'Browser original sealed retirement result',
    expect.objectContaining({
      closeStage: 'none',
      terminalCleanup: 'observed',
    })
  );
  await f.owner.close();
});

it('retains birth and completes original registration before a close-stage getter reentrantly closes its original owner', async () => {
  const f = owned();
  const bank: { closing?: Promise<void>; registered?: number } = {};
  const read = vi.fn(() => {
    bank.registered = vi.mocked(f.participant.registerBirth).mock.calls.length;
    bank.closing = f.owner.close();
    void bank.closing.catch(() => {});
    return () => 'snapshot' as const;
  });
  Object.defineProperty(f.receiver, 'retirementCloseRefusal', { get: read });
  const opening = await rejected(f.open());
  f.accept(opening.reason);
  expect(bank.registered).toBe(1);
  expect(read).toHaveBeenCalledOnce();
  expect(bank.closing).toBe(f.owner.close());
  const closing = await rejected(bank.closing!);
  f.accept(closing.reason);
  expect(closing.reason).toBe(opening.reason);
  expect(closing.reason).toMatchObject({ code: 'CLOSED' });
  expect(f.engine.shutdown).toHaveBeenCalledOnce();
});

it.each(['native', 'chrome-compatible'] as const)(
  'preserves original selected %s identity while rebuilding verified installed provenance',
  async (mode) => {
    const turn = held<InstallResult>();
    const f = owned(() => turn.resolve(verified));
    const network = f.settings.network;
    if (network.kind !== 'owned') throw new Error('EXPECTED_OWNED_NETWORK');
    f.verify.mockImplementation(() => turn.promise);
    const opening = f.open(undefined, mode);
    await vi.waitFor(() => expect(f.verify).toHaveBeenCalledOnce());
    expect(originals.construct).not.toHaveBeenCalled();
    turn.resolve(verified);
    expect((await opening).engine).toBe(f.engine);
    const actual = validateEngineConfiguration(originals.construct.mock.calls[0][0]);
    expect(actual.runtime.identity).toEqual({
      mode,
      policyRevision: network.policyRevision,
    });
    expect(actual.runtime.library.rootDir).toBe('/owned/library');
    expect(actual.runtime.executable).toEqual({
      path: '/owned/cache/candidates/installation_verified_original/payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      sha256: verified.executableSHA256,
      revision: '1243',
      version: verified.observedVersion,
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(f.inspect).toHaveBeenCalledOnce();
    expect(f.owner.isOriginalNativeCurrent(f.receiver)).toBe(true);
  }
);

it('refuses an unsupported private identity selection before original installation or engine acquisition', async () => {
  const f = owned();
  const opening = Reflect.apply(f.owner.open, f.owner, [
    f.settings,
    f.participant,
    {},
    undefined,
    'unsupported',
  ]);
  f.track(opening);
  const refusal = await rejected(opening);
  f.accept(refusal.reason);
  expect(refusal.reason).toMatchObject({ code: 'UNSUPPORTED' });
  expect(originals.resolve).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(originals.construct).not.toHaveBeenCalled();
});

it.each([undefined, 2000])(
  'preserves the captured measured capture interval %s through actual owner construction',
  async (interval) => {
    const f = owned();
    const read = vi.fn(() => interval);
    Object.defineProperty(f.settings, 'captureMinimumIntervalMilliseconds', {
      enumerable: true,
      get: read,
    });
    await f.open();
    expect(read).toHaveBeenCalledTimes(1);
    expect(originals.construct).toHaveBeenCalledTimes(1);
    const actual = originals.construct.mock.calls[0]![0] as EngineConfiguration;
    if (interval === undefined) {
      expect(Object.hasOwn(actual, 'captureMinimumIntervalMilliseconds')).toBe(false);
    } else {
      expect(actual.captureMinimumIntervalMilliseconds).toBe(interval);
    }
    expect(validateEngineConfiguration(actual)).toEqual(actual);
    await f.owner.close();
  }
);

it.each([undefined, 2])(
  'preserves the original constructor tab ceiling %s through production ownership',
  async (limit) => {
    const f = owned();
    const read = vi.fn(() => limit);
    Object.defineProperty(f.settings, 'tabsPerBrowser', { enumerable: true, get: read });
    await f.open();
    expect(read).toHaveBeenCalledTimes(1);
    const actual = originals.construct.mock.calls[0]![0] as EngineConfiguration;
    if (limit === undefined) expect(Object.hasOwn(actual, 'tabsPerBrowser')).toBe(false);
    else expect(actual.tabsPerBrowser).toBe(limit);
    expect(validateEngineConfiguration(actual)).toEqual(actual);
    await f.owner.close();
  }
);

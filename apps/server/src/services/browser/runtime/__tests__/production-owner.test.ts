import { createHash } from 'node:crypto';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { parseBrowserResult, type EngineConfiguration } from '@dorkos/browser';
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
      identity = createHash('sha256').update(JSON.stringify(config.runtime)).digest('hex');
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
    open(signal?: AbortSignal) {
      const original = owner.open(f.settings, f.participant, {}, signal);
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
    Object.defineProperty(f.participant[kind]!, 'registerDispatcher', { value: undefined });
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
  expect(reads).toEqual({ clock: 1, processes: 1, policy: 1, nativeJournal: 1 });
});

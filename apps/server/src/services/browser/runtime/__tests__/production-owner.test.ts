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
  observedVersion: '157.0.8103.15',
  executableSHA256: hash,
  platform: 'darwin',
  arch: 'arm64',
  currentManifestDigest: hash,
  journalDigest: hash,
  readiness: { state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' },
};
const current: RuntimeInstallationStatus = {
  schemaVersion: 1,
  pinnedPackageVersion: '1.65.0-alpha-2026-10-30',
  chromiumRevision: '1252',
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

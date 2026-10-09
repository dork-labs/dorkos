import { Socket } from 'node:net';
import { expect, it, onTestFinished, vi } from 'vitest';
import { rmdir, rename, mkdir } from 'node:fs/promises';
import type { BrowserContext, BrowserType, ChromiumBrowser } from 'playwright-core';
import type { BrowserRuntimeDescriptor } from '../../../runtime-descriptor.js';
import {
  createSupervisorNativeIdentity,
  consumeSupervisorNativeIdentity,
} from '../supervisor-native-identity.js';
const mocks = vi.hoisted(() => ({ library: vi.fn(), cohort: vi.fn() }));
vi.mock('../../public-library.js', () => ({ verifiedLibrary: mocks.library }));
vi.mock('../supervisor-native-cohort.js', () => ({ createSupervisorNativeCohort: mocks.cohort }));
const native: BrowserRuntimeDescriptor = {
  library: {
    package: 'playwright-core',
    version: '1.63.0',
    rootDir: '/original/library',
    assets: { manifest: 'browsers.json', cli: 'cli.js' },
  },
  executable: {
    path: '/original/chromium',
    sha256: 'a'.repeat(64),
    revision: '1234',
    version: '153.0.8010.12',
    platform: 'darwin',
    arch: 'arm64',
  },
  identity: { mode: 'native', policyRevision: 7 },
};
const candidate = {
  ...native,
  identity: { ...native.identity, mode: 'chrome-compatible' as const },
};
const observed = {
  userAgent: 'Mozilla/5.0 HeadlessChrome/153.0.0.0',
  appVersion: '5.0 HeadlessChrome/153.0.0.0',
  platform: 'MacIntel',
  secureContext: true,
  metadata: {
    brands: [
      { brand: 'Chromium', version: '153' },
      { brand: 'Not_A Brand', version: '99' },
    ],
    fullVersionList: [
      { brand: 'Chromium', version: '153.0.8010.12' },
      { brand: 'Not_A Brand', version: '99.0.0.0' },
    ],
    mobile: false,
    platform: 'macOS',
    uaFullVersion: '153.0.8010.12',
    architecture: 'arm',
    bitness: '64',
    model: '',
    platformVersion: '15.0.0',
    wow64: false,
    formFactors: ['Desktop'],
  },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** The production owner and original Node HTTP receiver/filesystem run here. SDK/native
 * process observations are semantic doubles: these controls cannot qualify Chrome behavior. */
function fixture(isAdmissionCurrent?: () => boolean) {
  const releases: (() => void)[] = [],
    operations = new Set<Promise<unknown>>();
  const semanticProfiles = new Set<string>();
  const accepted = new Set<unknown>();
  onTestFinished(async () => {
    for (const release of releases) release();
    const jobs = [...operations];
    if (owner) jobs.push(owner.close());
    const results = await Promise.allSettled(jobs);
    let primary: Readonly<{ value: unknown }> | undefined;
    const rejected = results.find(
      (result) => result.status === 'rejected' && !accepted.has(result.reason)
    );
    if (rejected?.status === 'rejected') primary = { value: rejected.reason };
    // Semantic SDK creates no process/files. Remove only an empty retained test directory,
    // after every original producer joined; production never removes an uncertain profile.
    const removals = await Promise.allSettled(
      [...semanticProfiles].map(async (path) => {
        try {
          await rmdir(path);
        } catch (value) {
          if (!value || typeof value !== 'object' || !('code' in value) || value.code !== 'ENOENT')
            throw value;
        }
      })
    );
    for (const result of removals)
      if (result.status === 'rejected') primary ??= { value: result.reason };
    mocks.library.mockReset();
    mocks.cohort.mockReset();
    if (primary) throw primary.value;
  });
  const own = <T>(original: Promise<T>) => {
    operations.add(original);
    void original.catch(() => {});
    return original;
  };
  const close = vi.fn(async () => {});
  let url = '';
  const page = {
    goto: vi.fn(async (target: string) => {
      url = target;
      const response = await fetch(target, { headers: { 'User-Agent': observed.userAgent } });
      if (response.status !== 200) throw new Error('ORIGINAL_RECEIVER_REFUSED');
      await response.arrayBuffer();
    }),
    evaluate: vi.fn(async () => structuredClone(observed)),
    context: () => context,
    url: () => url,
  };
  const context = {
    close,
    browser: () => ({ version: () => native.executable.version }),
    pages: () => [page],
  } as unknown as BrowserContext;
  const launch = vi.fn<BrowserType<ChromiumBrowser>['launchPersistentContext']>(async (path) => {
    semanticProfiles.add(path);
    return context;
  });
  const sdk = { launchPersistentContext: launch } as unknown as BrowserType<ChromiumBrowser>;
  const cohort = {
    beforeLaunch: vi.fn(async () => {}),
    afterLaunch: vi.fn(async () => {}),
    beforeOriginalClose: vi.fn(async () => {}),
    afterOriginalClose: vi.fn(async () => {}),
    observedBirths: () => [{ pid: 123, birth: 'semantic-original-birth' }],
  };
  mocks.library.mockResolvedValue(sdk);
  mocks.cohort.mockReturnValue(cohort);
  const owner = createSupervisorNativeIdentity({
    nativeRuntime: native,
    candidateRuntime: candidate,
    artifact: { path: '/original/native-observer', sha256: 'b'.repeat(64) },
    isAdmissionCurrent,
  });
  return {
    owner,
    own,
    releases,
    accepted,
    sdk,
    launch,
    context,
    close,
    page,
    cohort,
    semanticProfiles,
  };
}

it('mints only after original native close and cohort return, retaining captured close and all native brands', async () => {
  const f = fixture(),
    entered = deferred<void>(),
    release = deferred<void>();
  f.releases.push(() => release.resolve());
  const goto = f.page.goto.getMockImplementation()!;
  f.page.goto.mockImplementation(async (target) => {
    await goto(target);
    entered.resolve();
    await release.promise;
  });
  const opening = f.own(f.owner.prepare());
  await entered.promise;
  const replacement = vi.fn(async () => {});
  f.context.close = replacement;
  release.resolve();
  const plan = await opening;
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(replacement).not.toHaveBeenCalled();
  expect(f.cohort.afterOriginalClose).toHaveBeenCalledTimes(1);
  expect(() => consumeSupervisorNativeIdentity({ ...plan }, candidate, f.sdk)).toThrow();
  expect(() => consumeSupervisorNativeIdentity(plan, candidate, {} as typeof f.sdk)).toThrow();
  const identity = consumeSupervisorNativeIdentity(plan, candidate, f.sdk);
  expect(identity.userAgent).toBe(observed.userAgent.replace('HeadlessChrome/', 'Chrome/'));
  expect(identity.payload.userAgentMetadata.brands).toEqual(observed.metadata.brands);
  expect(identity.payload.userAgentMetadata.fullVersionList).toEqual(
    observed.metadata.fullVersionList
  );
  expect(identity.payload.platform).toBe(observed.platform);
  expect(() => consumeSupervisorNativeIdentity(plan, candidate, f.sdk)).toThrow();
  await f.own(f.owner.close());
});

it('fences original SDK birth when original verification returns after close', async () => {
  const f = fixture(),
    verification = deferred<typeof f.sdk>();
  f.releases.push(() => verification.resolve(f.sdk));
  mocks.library.mockReturnValue(verification.promise);
  const opening = f.own(f.owner.prepare());
  await Promise.resolve();
  await Promise.resolve();
  const closing = f.own(f.owner.close());
  const refusal = opening.catch((value) => {
    f.accepted.add(value);
    return value;
  });
  verification.resolve(f.sdk);
  expect(await refusal).toBeInstanceOf(Error);
  await closing;
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.page.goto).not.toHaveBeenCalled();
});

it('retains exact undefined metadata rejection before independent original SDK close false', async () => {
  const f = fixture();
  f.accepted.add(undefined);
  f.page.evaluate.mockRejectedValue(undefined);
  f.close.mockRejectedValue(false);
  await expect(f.own(f.owner.prepare())).rejects.toBeUndefined();
  await expect(f.own(f.owner.close())).rejects.toBeUndefined();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.cohort.afterOriginalClose).toHaveBeenCalledTimes(1);
});

it('refuses a different identity policy before original verification or native birth', () => {
  const f = fixture();
  expect(() =>
    createSupervisorNativeIdentity({
      nativeRuntime: native,
      candidateRuntime: { ...candidate, identity: { ...candidate.identity, policyRevision: 8 } },
      artifact: { path: '/original/native-observer', sha256: 'b'.repeat(64) },
    })
  ).toThrow();
  expect(mocks.library).not.toHaveBeenCalled();
  expect(f.launch).not.toHaveBeenCalled();
});

it('fences original native launch after the captured admission receiver revokes during verification', async () => {
  let current = true;
  const f = fixture(() => current);
  mocks.library.mockImplementation(async () => {
    current = false;
    return f.sdk;
  });
  const opening = f.own(f.owner.prepare());
  const refusal = await opening.catch((value) => {
    f.accepted.add(value);
    return value;
  });
  expect(refusal).toBeInstanceOf(Error);
  expect(f.launch).not.toHaveBeenCalled();
  expect(f.page.goto).not.toHaveBeenCalled();
  await f.own(f.owner.close());
});

it('refuses replacement of the original temporary directory without deleting the replacement or minting a plan', async () => {
  const f = fixture();
  f.page.evaluate.mockImplementation(async () => {
    const path = [...f.semanticProfiles][0]!;
    const displaced = path + '.original';
    await rename(path, displaced);
    f.semanticProfiles.add(displaced);
    await mkdir(path, { mode: 0o700 });
    return observed;
  });
  const opening = f.own(f.owner.prepare());
  const original = await opening.catch((value) => {
    f.accepted.add(value);
    return value;
  });
  expect(original).toBeInstanceOf(Error);
  expect(f.launch).toHaveBeenCalledTimes(1);
  await expect(f.own(f.owner.close())).rejects.toBe(original);
  // Both real empty directory identities remain for the independent semantic fixture finalizer.
  expect(f.semanticProfiles.size).toBe(2);
});

it('bounds the original receiver live sockets and reuses admission only after actual socket closure', async () => {
  const f = fixture();
  const originalGoto = f.page.goto.getMockImplementation()!;
  f.page.goto.mockImplementation(async (target) => {
    const endpoint = new URL(target);
    const sockets: Socket[] = [],
      originals: Promise<void>[] = [];
    let overflowClosed = 0,
      resolve!: () => void,
      reject!: (cause: unknown) => void;
    const excess = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const timer = setTimeout(() => reject(new Error('ORIGINAL_RECEIVER_CAP_UNOBSERVED')), 2000);
    f.releases.push(() => {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
    });
    try {
      for (let i = 0; i < 20; i++) {
        const socket = new Socket();
        sockets.push(socket);
        const closed = new Promise<void>((yes) =>
          socket.once('close', () => {
            overflowClosed++;
            if (overflowClosed === 4) resolve();
            yes();
          })
        );
        originals.push(f.own(closed));
        socket.on('error', reject);
        socket.connect(Number(endpoint.port), endpoint.hostname);
      }
      await excess;
      expect(overflowClosed).toBeGreaterThanOrEqual(4);
    } finally {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await Promise.all(originals);
    }
    return originalGoto(target);
  });
  const plan = await f.own(f.owner.prepare());
  expect(consumeSupervisorNativeIdentity(plan, candidate, f.sdk).userAgent).toContain('Chrome/153');
  await f.own(f.owner.close());
});

it('consumes the native one-use plan and refuses descriptor getters without invoking them', async () => {
  const f = fixture();
  const plan = await f.own(f.owner.prepare());
  let denied = 0;
  const reentrant = {
    ...candidate,
    get identity() {
      try {
        consumeSupervisorNativeIdentity(plan, candidate, f.sdk);
      } catch {
        denied++;
      }
      return candidate.identity;
    },
  };
  expect(() => consumeSupervisorNativeIdentity(plan, reentrant, f.sdk)).toThrow(
    'INVALID_RUNTIME_DESCRIPTOR'
  );
  expect(denied).toBe(0);
  expect(() => consumeSupervisorNativeIdentity(plan, candidate, f.sdk)).toThrow();
  await f.own(f.owner.close());
});

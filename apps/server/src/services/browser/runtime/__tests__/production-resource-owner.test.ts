import { readOriginalBrowserRuntimeClass } from '../admission/runtime-class.js';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProcessObserver } from '@dorkos/browser';
import type { PrivateBrowserRetirementReceiver } from '@dorkos/browser/server-owner';
import {
  acquireBrowserModeAdmission,
  browserModeResourceEnvelope,
  createPrivateBrowserQualification,
  requiredBrowserModeGates,
} from '../admission/accepted-mode.js';
import { createProductionBrowserResourceOwner } from '../admission/production-resource-owner.js';
import {
  captureMeasuredBrowserResourceAdmission,
  isMeasuredResourceAdmissionRefusal,
} from '../admission/measured-resource.js';
const state = vi.hoisted(() => ({
  now: 0,
  hostReads: 0,
  hold: false,
  children: [] as {
    stdout: PassThrough;
    stderr: PassThrough;
    child: EventEmitter;
    release(): void;
  }[],
  spawn: vi.fn(),
  catalogue: [] as unknown[],
}));
vi.mock('../admission/accepted-catalogue.js', () => ({ acceptedBrowserModes: state.catalogue }));
vi.mock('node:perf_hooks', () => ({ performance: { now: () => state.now } }));
vi.mock('node:os', () => ({
  cpus: () => {
    const n = state.hostReads++;
    return [{ times: { idle: n * 90, user: n * 10, sys: 0, nice: 0, irq: 0 } }];
  },
  freemem: () => 50000,
  totalmem: () => 100000,
  loadavg: () => [0, 0, 0],
  release: () => 'controlled',
  arch: () => 'arm64',
}));
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => {
    state.spawn(...args);
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, stderr, kill: vi.fn(() => true) });
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      stdout.end('20 2 00:01\n');
      stderr.end();
      child.emit('close', 0, null);
    };
    state.children.push({ stdout, stderr, child, release });
    if (!state.hold) queueMicrotask(release);
    return child;
  },
}));
afterEach(() => {
  vi.useRealTimers();
  state.now = 0;
  state.hostReads = 0;
  state.hold = false;
  state.children = [];
  state.spawn.mockClear();
  state.catalogue.splice(0);
});
const root = { pid: 20, birth: 'original-root' };
// Synthetic boundary values are controls, not reviewed production thresholds.
const envelope = {
  profiles: 2,
  browsers: 2,
  captureMinimumIntervalMilliseconds: 100,
  maximumCPUPercent: 50,
  minimumAvailableMemoryBytes: 1000,
  maximumBrowserRSSBytes: 10000,
  maximumObservationAgeMilliseconds: 500,
  samplingIntervalMilliseconds: 100,
};
function fixture() {
  const signal = new AbortController();
  const processes: ProcessObserver = {
    observe: vi.fn(async () => ({ status: 'alive' as const })),
    descendants: vi.fn(async () => ({ status: 'complete' as const, identities: [root] })),
  };
  const owner = createProductionBrowserResourceOwner({
    envelope,
    executableSHA256: 'a'.repeat(64),
    processes,
    signal: signal.signal,
    current: () => true,
  });
  const gate = captureMeasuredBrowserResourceAdmission(owner.admission);
  let retire!: (value: Awaited<PrivateBrowserRetirementReceiver['observation']>) => void;
  const observation = new Promise<Awaited<PrivateBrowserRetirementReceiver['observation']>>(
    (resolve) => {
      retire = resolve;
    }
  );
  const unused = () => {
    throw new Error('UNEXPECTED_RESOURCE_AUTHORITY_READ');
  };
  const receiver: PrivateBrowserRetirementReceiver = {
    browserId: 'controlled',
    browserGeneration: 1,
    acquisition: { mode: 'ephemeral' },
    observation,
    isOrdinary: unused,
    isAuthorityCurrent: unused,
    navigateInitial: unused,
    verifiedBrowserAdminEndpoint: unused,
    verifiedRuntimeBinding: unused,
    disabled: unused,
    authorityRevoked: unused,
    persistenceFailure: unused,
    generationReturned: unused,
    consumeGenerationReturn: unused,
  };
  const release = () =>
    retire({
      cleanup: { state: 'settled', coverage: 'closed', pending: false, uncertainty: [] },
      owners: [],
      terminal: { cleanup: 'observed' },
      firstCause: 'explicitStop',
      uncertainty: [],
    });
  const unverified = (nativeObserved = false) =>
    retire({
      cleanup: {
        state: 'unverified',
        coverage: 'closed',
        pending: false,
        uncertainty: ['observationUnavailable'],
      },
      owners: [],
      terminal: nativeObserved
        ? { cleanup: 'observed' }
        : { cleanup: 'unverified', reason: 'observationUnavailable' },
      firstCause: 'explicitStop',
      uncertainty: ['terminalCloseFailed'],
    });
  const enroll = () =>
    owner.resources.onOriginalChild(receiver, {
      root,
      manager: { pid: 10, birth: 'manager' },
      supervisor: { pid: 11, birth: 'supervisor' },
      identities: [root],
      complete: true,
    });
  return { signal, processes, owner, gate, release, enroll, unverified };
}
function refused(body: () => void) {
  let caught: { value: unknown } | undefined;
  try {
    body();
  } catch (value) {
    caught = { value };
  }
  expect(caught).toBeDefined();
  expect(isMeasuredResourceAdmissionRefusal(caught!.value)).toBe(true);
}
async function refresh(f: ReturnType<typeof fixture>) {
  const original = f.owner.refresh();
  await vi.advanceTimersByTimeAsync(0);
  state.now += 100;
  await vi.advanceTimersByTimeAsync(100);
  await original;
}
describe('production original resource sampling', () => {
  it('admits only a fresh complete sampled empty cohort and refuses missing/stale observations', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      refused(() => f.gate.browser('a'.repeat(64), 0));
      await refresh(f);
      f.gate.browser('a'.repeat(64), 0);
      expect(state.spawn).not.toHaveBeenCalled();
      state.now += 501;
      refused(() => f.gate.browser('a'.repeat(64), 0));
    } finally {
      f.release();
      await f.owner.close();
    }
  });
  it('samples only original known births and refuses an incomplete native cohort', async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.enroll();
      await refresh(f);
      f.gate.browser('a'.repeat(64), 1);
      expect(state.spawn).toHaveBeenCalledWith(
        '/bin/ps',
        ['-p', '20', '-o', 'pid=,rss=,time='],
        expect.objectContaining({ shell: false })
      );
      vi.mocked(f.processes.descendants).mockResolvedValue({
        status: 'unknown',
        identities: [root],
      });
      await f.owner.refresh();
      refused(() => f.gate.browser('a'.repeat(64), 1));
    } finally {
      f.release();
      await f.owner.close();
    }
  });
  for (const cause of [false, undefined])
    it(`keeps native producer ${String(cause)} through sampler retirement`, async () => {
      const f = fixture();
      try {
        await f.enroll();
        vi.mocked(f.processes.descendants).mockRejectedValue(cause);
        await expect(f.owner.refresh()).rejects.toBe(cause);
      } finally {
        f.release();
        await expect(f.owner.close()).rejects.toBe(cause);
      }
    });
  for (const nativeObserved of [false, true])
    it(`retains unverified owned cleanup even when native observed is ${nativeObserved}`, async () => {
      const f = fixture();
      await f.enroll();
      f.unverified(nativeObserved);
      await Promise.resolve();
      await f.owner.refresh();
      let failure: { value: unknown } | undefined;
      try {
        f.gate.browser('a'.repeat(64), 1);
      } catch (value) {
        failure = { value };
      }
      expect(failure).toBeDefined();
      expect(f.owner.isRefusal(failure!.value)).toBe(true);
      await expect(f.owner.close()).rejects.toThrow('PRODUCTION_RESOURCE_OWNERSHIP_UNRESOLVED');
    });
  it('joins the held original ps return and both original pipes after admission retirement', async () => {
    vi.useFakeTimers();
    state.hold = true;
    const f = fixture();
    await f.enroll();
    const original = f.owner.refresh();
    let closed: Promise<void> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(state.children).toHaveLength(1);
      f.signal.abort();
      f.owner.prepareClose();
      closed = f.owner.close();
      f.release();
      let returned = false;
      void closed.then(() => {
        returned = true;
      });
      await Promise.resolve();
      expect(returned).toBe(false);
      state.children[0]!.release();
      await original;
      await closed;
      expect(state.children[0]!.stdout.readableEnded).toBe(true);
      expect(state.children[0]!.stderr.readableEnded).toBe(true);
    } finally {
      f.release();
      for (const child of state.children) child.release();
      await Promise.allSettled([original, closed ?? f.owner.close()]);
    }
  });
  it('fences the interval wait and joins original retained retirement before close returns', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.enroll();
    const original = f.owner.refresh();
    try {
      await vi.advanceTimersByTimeAsync(0);
      f.owner.prepareClose();
      const closed = f.owner.close();
      let returned = false;
      void closed.then(() => {
        returned = true;
      });
      await original;
      await Promise.resolve();
      expect(returned).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      f.release();
      await closed;
    } finally {
      f.release();
      for (const child of state.children) child.release();
      await Promise.allSettled([original, f.owner.close()]);
    }
  });
});

const runtimeClass = readOriginalBrowserRuntimeClass();
const subject = {
  runtimeClass,
  executableSHA256: 'a'.repeat(64),
  version: 'controlled-original',
  revision: '1243' as const,
  libraryVersion: '1.63.0' as const,
  platform: runtimeClass.platform,
  arch: runtimeClass.arch,
  channel: 'cli' as const,
  sourceManifestSHA256: 'b'.repeat(64),
  controllerSHA256: 'c'.repeat(64),
  verifierSHA256: 'd'.repeat(64),
  nativeJournalSHA256: 'e'.repeat(64),
  productionSubjectSHA256: 'f'.repeat(64),
  mode: 'native' as const,
  identityPolicyRevision: 1 as const,
  networkPolicyRevision: 1 as const,
};
const reviewedRow = () => ({
  subject,
  gates: requiredBrowserModeGates.map((gate) => ({
    gate,
    outcome: 'accepted' as const,
    subjects: 1,
    samples: 1,
    receiptSHA256: '1'.repeat(64),
    negativeReceiptSHA256: '2'.repeat(64),
  })),
});
describe('original subject-bound resource envelope', () => {
  it('refuses a reviewed gate row with no measured limits and never reads copied admission properties', () => {
    state.catalogue.push(reviewedRow());
    expect(() => acquireBrowserModeAdmission(subject, () => true)).toThrow(
      'BROWSER_MODE_VERIFICATION_UNAVAILABLE'
    );
    const read = vi.fn(() => {
      throw false;
    });
    const copied = Object.defineProperty({}, 'kind', { get: read });
    expect(() =>
      browserModeResourceEnvelope(copied as ReturnType<typeof acquireBrowserModeAdmission>)
    ).toThrow('BROWSER_MODE_VERIFICATION_UNAVAILABLE');
    expect(read).not.toHaveBeenCalled();
  });
  it('captures only the exact trusted row scalar envelope and invalidates it with original lifetime', () => {
    const supplied = { ...envelope };
    state.catalogue.push({ ...reviewedRow(), resourceEnvelope: supplied });
    let current = true;
    const admission = acquireBrowserModeAdmission(subject, () => current);
    supplied.maximumCPUPercent = 100;
    expect(browserModeResourceEnvelope(admission)).toEqual(envelope);
    expect(Object.isFrozen(browserModeResourceEnvelope(admission))).toBe(true);
    expect(() =>
      acquireBrowserModeAdmission({ ...subject, executableSHA256: '3'.repeat(64) }, () => true)
    ).toThrow('BROWSER_MODE_VERIFICATION_UNAVAILABLE');
    current = false;
    expect(() => browserModeResourceEnvelope(admission)).toThrow(
      'BROWSER_MODE_VERIFICATION_UNAVAILABLE'
    );
    const qualification = createPrivateBrowserQualification({
      current: () => true,
      check: () => true,
    });
    expect(
      browserModeResourceEnvelope(acquireBrowserModeAdmission(subject, () => true, qualification))
    ).toBeUndefined();
  });
});

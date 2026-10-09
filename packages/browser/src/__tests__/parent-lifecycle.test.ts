import { registerFixtureRecord, fakePage } from './parent-fixture.js';
import { composeInput } from '../lifecycle/input-owner.js';
import { createPointerLedger } from '../tabs/pointer.js';
import { unavailableDiagnostics } from '../tabs/diagnostics.js';
import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { createBrowserLifetime, fenceOrdinary, ordinaryRecord } from '../lifecycle/ownership.js';
import { it, expect, vi, onTestFinished } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { readFileSync } from 'node:fs';
import { transpileModule } from 'typescript';
import { closeRecord } from '../lifecycle/close.js';
import { createBrowserEngine } from '../engine.js';
import { parseBrowserId, parseTabId } from '../ids.js';

vi.mock('../profiles/owned-directory.js', () => ({ assertDirectory: vi.fn() }));
vi.mock('../runtime/host-identity.js', () => ({
  hostIdentity: () => ({ pid: 41, birth: 'mock' }),
}));
const identity = { pid: 41, birth: 'mock' };
function config(): EngineConfiguration {
  return {
    dataDir: '/fixture/data',
    runtime: {
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: '/fixture/library',
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path: '/fixture/chromium',
        sha256: '0'.repeat(64),
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin',
        arch: 'arm64',
      },
      identity: { mode: 'native', policyRevision: 0 },
    },
    network: { kind: 'fixture', origin: 'http://127.0.0.1:9001' },
    clock: { monotonicNow: () => 0, wallNow: () => 1000 },
    processes: {
      descendants: async () => ({ status: 'complete', identities: [identity] }),
      observe: async () => ({ status: 'dead' }),
    },
    policy: {
      authorizeAction: async () => 'allowed',
      verifyBrokerLease: async () => 'unknown',
    },
  };
}
function record(): BrowserRecord {
  const owned: BrowserRecord = {
    diagnosticsBudget: createDiagnosticsBudget(),
    lifetime: createBrowserLifetime('browser_0123456789abcdef0123456789ab', 0),
    browserId: parseBrowserId('browser_0123456789abcdef0123456789ab'),
    browserGeneration: 0,
    mode: 'persistent',
    manager: identity,
    root: identity,
    rootAttributed: true,
    identities: [],
    inventoryComplete: false,
    launchEntered: true,
    status: 'running',
    tabs: new Map(),
    context: { close: vi.fn(async () => {}) } as unknown as BrowserContext,
  };
  registerFixtureRecord(owned, () => closeRecord(config(), owned));
  return owned;
}
it('parent engine implements private input and reset seams without activation', () => {
  const engine = createBrowserEngine(config());
  expect(typeof (engine as unknown as { input?: unknown }).input, 'PARENT_INPUT_SEAM_MISSING').toBe(
    'function'
  );
  expect(typeof (engine as unknown as { resetInput?: unknown }).resetInput).toBe('function');
});
it('proxy cleanup settles before reservation release', async () => {
  const r = record(),
    order: string[] = [];
  r.proxy = {
    close: async () => {
      order.push('proxy');
    },
  } as unknown as BrowserRecord['proxy'];
  r.reservation = {
    release: async () => {
      order.push('release');
    },
  } as unknown as BrowserRecord['reservation'];
  expect(await closeRecord(config(), r)).toEqual({ cleanup: 'observed' });
  expect(order, 'PROFILE_RELEASE_BEFORE_PROXY_CLOSURE').toEqual(['proxy', 'release']);
});
it('terminal promise exists before observer callback entry', async () => {
  const r = record(),
    c = config();
  let preregistered = false;
  c.processes.descendants = async () => {
    preregistered = r.closePromise !== undefined;
    return { status: 'complete', identities: [identity] };
  };
  await closeRecord(c, r);
  expect(preregistered, 'CLOSE_NOT_PREREGISTERED_BEFORE_OBSERVER').toBe(true);
});

// Read only the controlled source literal. Never collect or execute the native fixture body.
function currentCleanupTab(r: BrowserRecord, pageFixture = fakePage()): TabRecord {
  const source = readFileSync(new URL('./lifecycle-cleanup.test.ts', import.meta.url), 'utf8');
  const literal = /record\.tabs\.set\(tabId, ([\s\S]*?)\);/.exec(source)?.[1];
  expect(literal).toBeDefined();
  const code = transpileModule(`return (${literal});`, {
    compilerOptions: { target: 9 },
  }).outputText;
  return new Function(
    'record',
    'tabId',
    'createPointerLedger',
    'unavailableDiagnostics',
    'pageFixture',
    code
  )(
    r,
    parseTabId('tab_0123456789abcdef0123456789abcdef'),
    createPointerLedger,
    unavailableDiagnostics,
    pageFixture
  ) as TabRecord;
}

it.each([false, true])(
  'the actual cleanup fixture literal preserves healthy-vs-fault terminal custody fault=%s',
  async (fault) => {
    const r = record(),
      page = fakePage(),
      tab = currentCleanupTab(r, page);
    expect(tab.pending).toBe(0);
    await expect(tab.tail).resolves.toBeUndefined();
    r.tabs.set(tab.binding.tabId, tab);
    const owner = composeInput(config(), r, tab);
    await owner.readiness;
    expect(page.context.newCDPSession).toHaveBeenCalledTimes(1);
    const context = r.context!,
      close = context.close;
    if (fault)
      page.page.off = () => {
        throw Error('CONTROLLED_LISTENER_REMOVAL_FAULT');
      };
    const outcome = await closeRecord(config(), r);
    expect(close).toHaveBeenCalledTimes(1);
    expect(page.session.detach).toHaveBeenCalledTimes(1);
    expect(page.session.send.mock.calls.length).toBeGreaterThan(0);
    expect(owner.handle!.custody()).toMatchObject({
      acquisitionPending: false,
      nativePending: 0,
      detachPending: false,
    });
    if (fault) {
      expect(outcome).toEqual({
        cleanup: 'unverified',
        reason: 'observationUnavailable',
      });
      expect(owner.handle!.custody().uncertain).toBe(true);
      expect(r.tabs.get(tab.binding.tabId)).toBe(tab);
      expect(r.context).toBe(context);
      expect(r.root).toBe(identity);
    } else {
      expect(outcome).toEqual({ cleanup: 'observed' });
      expect(owner.uncertain).toBe(false);
      expect(owner.handle!.custody().uncertain).toBe(false);
      expect(r.tabs.size).toBe(0);
      expect(r.context).toBeUndefined();
      expect(r.root).toBeUndefined();
    }
    expect((await owner.handle!.reset()).status).toBe('stopped');
  }
);

it('the cleanup fixture cannot erase a nonzero pending tab ledger', async () => {
  const r = record(),
    tab = currentCleanupTab(r);
  tab.pending = 1;
  r.tabs.set(tab.binding.tabId, tab);
  await composeInput(config(), r, tab).readiness;
  expect(await closeRecord(config(), r)).toEqual({
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  expect(r.tabs.get(tab.binding.tabId)).toBe(tab);
  expect(r.context).toBeDefined();
});

it('candidate: ordinary fence is irreversible and shared before any cleanup callback', () => {
  const owned = record();
  expect(ordinaryRecord(owned)).toBe(true);
  const first = fenceOrdinary(owned, 'authorityRevoked');
  expect(first).toBe(owned.lifetime.ordinary.retirement);
  expect(ordinaryRecord(owned)).toBe(false);
  expect(fenceOrdinary(owned, 'explicitStop')).toBe(first);
  expect(first?.firstCause).toBe('authorityRevoked');
  expect(owned.lifetime.gate.stopped).toBe(false);
});

it('an actual canonical Page without an input owner cannot certify complete retirement', async () => {
  const r = record();
  const tab = currentCleanupTab(r);
  r.tabs.set(tab.binding.tabId, tab);
  const context = r.context!;
  expect(r.lifetime.inputs.size).toBe(0);
  expect(await closeRecord(config(), r)).toEqual({
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  expect(context.close).toHaveBeenCalledTimes(1);
  expect(r.lifetime.ordinary.retirement.coverageUnavailable).toBe(true);
  expect(r.tabs.get(tab.binding.tabId)).toBe(tab);
  expect(r.context).toBe(context);
  expect(r.lifetime.ordinary.phase).toBe('terminal');
});

it.each([false, true])(
  'waits for original journal pre-close before context close (refusal=%s)',
  async (refusal) => {
    const r = record(),
      c = config();
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const contextClose = vi.fn(async () => {});
    r.context = { close: contextClose } as unknown as BrowserContext;
    const originals: { operation?: Promise<unknown> } = {};
    onTestFinished(async () => {
      release();
      if (originals.operation) await originals.operation;
    });
    r.journal = {
      binding: {
        journalId: 'close',
        browserId: r.browserId,
        browserGeneration: 0,
        reservationNonce: 'nonce',
        manager: r.manager,
        runtimeIdentityDigest: 'a'.repeat(64),
        profile: { kind: 'ephemeral' },
        bootScope: { kind: 'unknown', cause: 'boot-unknown' },
      },
      attributeRoot: async () => {},
      prepareClose: async () => {
        expect(closeRecord(c, r)).toBe(r.closePromise);
        entered();
        await held;
        if (refusal) throw undefined;
      },
      stop: async () => 'campaign-closed',
      historyGapped: () => false,
      custody: () => ({ pending: false, uncertain: false }),
    };
    originals.operation = closeRecord(c, r);
    await entering;
    expect(contextClose).not.toHaveBeenCalled();
    release();
    expect(await originals.operation).toEqual(
      refusal
        ? { cleanup: 'unverified', reason: 'observationUnavailable' }
        : { cleanup: 'observed' }
    );
    expect(contextClose).toHaveBeenCalledTimes(1);
  }
);

it.each(['settled', 'false', 'undefined', 'expired'] as const)(
  'joins original local controller closure before native peer stop without renewing its bound (%s)',
  async (mode) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const r = record();
    let release!: () => void, enter!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let releasePreparation!: () => void, enterPreparation!: () => void;
    const preparationHeld = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const preparationEntered = new Promise<void>((resolve) => {
      enterPreparation = resolve;
    });
    r.journal = {
      prepareClose: async () => {
        enterPreparation();
        await preparationHeld;
      },
      stop: async () => 'campaign-closed',
      custody: () => ({ pending: false, uncertain: false }),
    } as unknown as BrowserRecord['journal'];
    let localReturned = false;
    const localClose = async () => {
      enter();
      await held;
      localReturned = true;
      if (mode === 'false') throw false;
      if (mode === 'undefined') throw undefined;
    };
    const defaultContextClose = vi.fn(async () => {});
    r.context = { close: defaultContextClose } as unknown as BrowserContext;
    r.controllerBrowser = { close: localClose } as unknown as BrowserRecord['controllerBrowser'];
    r.controllerAuthentication = {
      prepareClose: async () => {},
      close: localClose,
    } as unknown as BrowserRecord['controllerAuthentication'];
    r.supervisor = {
      custody: () => ({ pending: false, uncertain: false }),
    } as unknown as BrowserRecord['supervisor'];
    const nativeStop = vi.fn(async () => {
      await r.supervisorStopBarrier;
    });
    r.proxy = { close: nativeStop } as unknown as BrowserRecord['proxy'];
    const originals: { operation?: Promise<unknown> } = {};
    onTestFinished(async () => {
      releasePreparation();
      release();
      try {
        if (originals.operation) await originals.operation;
        await held;
        await Promise.allSettled([...r.lifetime.pending]);
      } finally {
        vi.useRealTimers();
      }
    });
    // Observe native entry after its actual production barrier, not only proxy call entry.
    let nativeEntered = false;
    nativeStop.mockImplementation(async () => {
      await r.supervisorStopBarrier;
      nativeEntered = true;
    });
    originals.operation = closeRecord(config(), r);
    await preparationEntered;
    await vi.advanceTimersByTimeAsync(0);
    expect(localReturned).toBe(false);
    expect(nativeEntered).toBe(false);
    releasePreparation();
    await entered;
    await vi.advanceTimersByTimeAsync(0);
    expect(defaultContextClose).not.toHaveBeenCalled();
    expect(localReturned).toBe(false);
    expect(nativeEntered, 'NATIVE_STOP_BEFORE_ORIGINAL_CONTROLLER_RETURN').toBe(false);
    const inputEnd = r.lifetime.inputEnd;
    const parentEnd = r.lifetime.parentEnd;
    if (mode === 'expired') {
      await vi.advanceTimersByTimeAsync(2001);
      expect(nativeEntered).toBe(true);
      expect(localReturned).toBe(false);
      expect(r.lifetime.uncertain).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await originals.operation).not.toEqual({ cleanup: 'observed' });
      release();
    } else {
      release();
      expect(await originals.operation).toEqual(
        mode === 'settled' ? { cleanup: 'observed' } : { cleanup: 'failed', reason: 'closeFailed' }
      );
      expect(nativeEntered).toBe(true);
    }
    expect(r.lifetime.inputEnd).toBe(inputEnd);
    expect(r.lifetime.parentEnd).toBe(parentEnd);
  }
);

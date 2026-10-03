import { createPointerLedger } from '../tabs/pointer.js';
import { unavailableDiagnostics } from '../tabs/diagnostics.js';
import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { createBrowserLifetime } from '../lifecycle/ownership.js';
import { it, expect, vi } from 'vitest';
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
    policy: { authorizeAction: async () => 'allowed', verifyBrokerLease: async () => 'unknown' },
  };
}
function record(): BrowserRecord {
  return {
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
function currentCleanupTab(r: BrowserRecord): TabRecord {
  const source = readFileSync(new URL('./lifecycle-cleanup.test.ts', import.meta.url), 'utf8');
  const literal = /record\.tabs\.set\(tabId, ([\s\S]*?)\);/.exec(source)?.[1];
  expect(literal).toBeDefined();
  const code = transpileModule(`return (${literal});`, {
    compilerOptions: { target: 9 },
  }).outputText;
  return new Function('record', 'tabId', 'createPointerLedger', 'unavailableDiagnostics', code)(
    r,
    parseTabId('tab_0123456789abcdef0123456789abcdef'),
    createPointerLedger,
    unavailableDiagnostics
  ) as TabRecord;
}

it('the actual cleanup fixture literal reaches observed cleanup with its settled tab ledger', async () => {
  const r = record(),
    tab = currentCleanupTab(r);
  expect(tab.pending).toBe(0);
  await expect(tab.tail).resolves.toBeUndefined();
  r.tabs.set(tab.binding.tabId, tab);
  const close = r.context!.close;
  expect(await closeRecord(config(), r)).toEqual({ cleanup: 'observed' });
  expect(close).toHaveBeenCalledTimes(1);
  expect(r.tabs.size).toBe(0);
  expect(r.context).toBeUndefined();
});

it('the cleanup fixture cannot erase a nonzero pending tab ledger', async () => {
  const r = record(),
    tab = currentCleanupTab(r);
  tab.pending = 1;
  r.tabs.set(tab.binding.tabId, tab);
  expect(await closeRecord(config(), r)).toEqual({
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  expect(r.tabs.get(tab.binding.tabId)).toBe(tab);
  expect(r.context).toBeDefined();
});

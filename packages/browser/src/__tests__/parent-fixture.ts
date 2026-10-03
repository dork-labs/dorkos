import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { vi, type Mock } from 'vitest';
import type { Page, CDPSession, BrowserContext } from 'playwright-core';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import { parseBrowserId, RequestIdSchema } from '../ids.js';
import { createBrowserLifetime } from '../lifecycle/ownership.js';
import { trackPage } from '../tabs/registry.js';
export const requestId = RequestIdSchema.parse('request_subject_A_00000000000000');
export const root = { pid: 41, birth: 'MOCK_ROOT' };
export const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
export function configuration(): EngineConfiguration {
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
      descendants: vi.fn(async () => ({ status: 'complete' as const, identities: [root] })),
      observe: vi.fn(async () => ({ status: 'dead' as const })),
    },
    policy: {
      authorizeAction: vi.fn(async () => 'allowed' as const),
      verifyBrokerLease: async () => 'unknown',
    },
  };
}
export function record(status: BrowserRecord['status'] = 'running'): BrowserRecord {
  const browserId = parseBrowserId('browser_subject_A_000000000000000');
  return {
    diagnosticsBudget: createDiagnosticsBudget(),
    browserId,
    browserGeneration: 0,
    mode: 'persistent',
    lifetime: createBrowserLifetime(browserId, 0),
    manager: root,
    root,
    rootAttributed: true,
    identities: [],
    inventoryComplete: false,
    launchEntered: true,
    status,
    tabs: new Map(),
    context: { close: vi.fn(async () => {}) } as unknown as BrowserContext,
  };
}
export function fakePage() {
  const callbacks = new Map<string, Set<(...values: unknown[]) => void>>();
  const effects: string[] = [];
  const action = (name: string): Mock<() => Promise<void>> =>
    vi.fn(async () => {
      effects.push(name);
    });
  const session = { send: action('send'), detach: action('detach') };
  const context: { newCDPSession: Mock<() => Promise<CDPSession>> } = {
    newCDPSession: vi.fn(async () => session as unknown as CDPSession),
  };
  const frame = { url: () => 'http://127.0.0.1:9001/' };
  const page = {
    context: () => context,
    isClosed: () => false,
    mainFrame: () => frame,
    setDefaultTimeout: vi.fn<() => void>(),
    setDefaultNavigationTimeout: vi.fn<() => void>(),
    viewportSize: () => ({ width: 100, height: 80 }),
    screenshot: vi.fn<() => Promise<Uint8Array>>(async (): Promise<Uint8Array> =>
      fakeJPEG(100, 80)
    ),
    mouse: {
      move: action('move'),
      down: action('mouseDown'),
      up: action('mouseUp'),
      wheel: action('wheel'),
    },
    keyboard: { down: action('keyDown'), up: action('keyUp'), insertText: action('text') },
    on: (event: string, callback: (...values: unknown[]) => void) => {
      const set = callbacks.get(event) ?? new Set();
      set.add(callback);
      callbacks.set(event, set);
    },
    off: (event: string, callback: (...values: unknown[]) => void) => {
      callbacks.get(event)?.delete(callback);
    },
    goto: vi.fn<() => Promise<null>>(async () => {
      for (const callback of callbacks.get('framenavigated') ?? []) callback(frame);
      return null;
    }),
    close: action('close'),
  };
  return {
    page: page as unknown as Page,
    raw: page,
    context,
    session,
    effects,
    event: (event: string, value: unknown = frame) => {
      for (const callback of callbacks.get(event) ?? []) callback(value);
    },
  };
}
export function tabFixture(r = record(), now: () => number = () => 0) {
  const p = fakePage();
  const tab = trackPage(r, p.page, 'http://127.0.0.1:9001', now);
  return {
    ...p,
    tab,
    record: r,
    command: (binding = { ...tab.binding }) => ({
      kind: 'input' as const,
      requestId,
      binding,
      steps: [{ kind: 'text' as const, text: 'FIXTURE_CHALLENGE' }],
    }),
  };
}

/** Synthetic baseline header fixture only; it does not certify decoder-valid image content. */
export function fakeJPEG(width = 100, height = 80, marker = 1): Uint8Array {
  return new Uint8Array([
    255,
    216,
    255,
    192,
    0,
    11,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    1,
    1,
    17,
    0,
    255,
    218,
    0,
    8,
    1,
    1,
    0,
    0,
    63,
    0,
    marker,
    255,
    217,
  ]);
}

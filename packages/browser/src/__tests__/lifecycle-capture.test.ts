import { createBrowserLifetime } from '../lifecycle/ownership.js';
import { it, expect, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { parseBrowserCommand } from '../contracts.js';
import type { CaptureCommand } from '../lifecycle/records.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';
import { captureTab } from '../tabs/capture.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { parseBrowserId, parseTabId } from '../ids.js';
import { configuration, requestId } from './lifecycle-fixture.js';

async function setup(screenshot: () => Promise<Uint8Array>) {
  const config = await configuration('/tmp/browser-test-not-created', 'http://127.0.0.1:9001');
  const tab: TabRecord = {
    page: {
      screenshot,
      viewportSize: () => ({ width: 10, height: 10 }),
      close: async () => {},
    } as unknown as Page,
    binding: {
      browserId: parseBrowserId('browser_0123456789abcdef0123456789ab'),
      browserGeneration: 0,
      tabId: parseTabId('tab_0123456789abcdef0123456789abcdef'),
      navigationGeneration: 0,
      viewportVersion: 0,
      epoch: 0,
      inputGeneration: 0,
    },
    stopped: false,
    captureSequence: 0,
    tail: Promise.resolve(),
    pending: 0,
  };
  const record: BrowserRecord = {
    lifetime: createBrowserLifetime(tab.binding.browserId, 0),
    browserId: tab.binding.browserId,
    browserGeneration: 0,
    mode: 'ephemeral',
    manager: { pid: process.pid, birth: 'test-double-only' },
    launchEntered: false,
    rootAttributed: false,
    identities: [],
    inventoryComplete: false,
    status: 'running',
    tabs: new Map([[tab.binding.tabId, tab]]),
  };
  return {
    config,
    tab,
    record,
    command: parseBrowserCommand({
      kind: 'capture',
      requestId,
      binding: { ...tab.binding },
    }) as CaptureCommand,
  };
}

it('bounds capture queue and refuses generation changes during the actual byte acquisition', async () => {
  let release!: (bytes: Uint8Array) => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const bytes = new Promise<Uint8Array>((resolve) => {
    release = resolve;
  });
  const owned = await setup(() => {
    entered();
    return bytes;
  });
  const first = captureTab(owned.config, owned.record, owned.command);
  const firstFailure = expect(first).rejects.toMatchObject({ code: 'STALE_BINDING' });
  await held;
  const second = captureTab(owned.config, owned.record, owned.command);
  const secondFailure = expect(second).rejects.toMatchObject({ code: 'STALE_BINDING' });
  await expect(captureTab(owned.config, owned.record, owned.command)).rejects.toMatchObject({
    code: 'CAPTURE_QUEUE_FULL',
  });
  owned.tab.binding = { ...owned.tab.binding, navigationGeneration: 1 };
  release(new Uint8Array([1, 2, 3]));
  await firstFailure;
  await secondFailure;
  expect(owned.tab.pending).toBe(0);
});

it.each(['policy', 'screenshot'] as const)(
  'redacts a %s implementation error to a fixed lifecycle code',
  async (kind) => {
    const owned = await setup(async () => {
      throw Error('PRIVATE-URL-SECRET');
    });
    if (kind === 'policy')
      owned.config.policy.authorizeAction = async () => {
        throw Error('PRIVATE-URL-SECRET');
      };
    const error = await captureTab(owned.config, owned.record, owned.command).catch(
      (error) => error
    );
    expect(error.code).toBe(kind === 'policy' ? 'POLICY_UNAVAILABLE' : 'CAPTURE_FAILED');
    expect(String(error)).not.toContain('PRIVATE-URL-SECRET');
  }
);

it('refuses counter exhaustion without wrapping or leaving its canonical Page active', async () => {
  const owned = await setup(async () => new Uint8Array([1, 2, 3]));
  const close = vi.fn(async () => {});
  owned.tab.page.close = close;
  owned.tab.captureSequence = Number.MAX_SAFE_INTEGER;
  await expect(captureTab(owned.config, owned.record, owned.command)).rejects.toMatchObject({
    code: 'COUNTER_EXHAUSTED',
  });
  expect(owned.tab.captureSequence).toBe(Number.MAX_SAFE_INTEGER);
  expect(owned.tab.stopped).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});

it('bounds and freezes public fixed error codes even for caller-created lifecycle errors', () => {
  const error = new BrowserLifecycleError('PRIVATE-SECRET', 'OTHER-SECRET');
  expect(error.code).toBe('OPERATION_FAILED');
  expect(error.cleanupCode).toBe('observationUnavailable');
  expect(String(error)).not.toContain('PRIVATE-SECRET');
  expect(Object.isFrozen(error)).toBe(true);
});

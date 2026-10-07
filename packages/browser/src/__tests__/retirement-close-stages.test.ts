import { expect, it, onTestFinished, vi } from 'vitest';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserRecord } from '../lifecycle/records.js';
import { closeRecord, readRetirementCloseRefusal } from '../lifecycle/close.js';
import {
  bindOrdinaryRecord,
  createBrowserLifetime,
  installRetirementDriver,
} from '../lifecycle/ownership.js';

function fixture() {
  const record = {
    browserId: 'browser',
    browserGeneration: 0,
    mode: 'ephemeral',
    lifetime: createBrowserLifetime('browser', 0),
    status: 'running',
    tabs: new Map(),
    identities: [],
    launchEntered: false,
    rootAttributed: false,
  } as unknown as BrowserRecord;
  const records = new Map([[record.browserId, record]]);
  expect(bindOrdinaryRecord(record, records)).toBe(true);
  expect(installRetirementDriver(record, () => {})).toBe(true);
  // No launch means no process observer is applicable; an unexpected read fails this control.
  const config = {
    processes: {
      observe: vi.fn(() => {
        throw new Error('unexpected observer');
      }),
      descendants: vi.fn(() => {
        throw new Error('unexpected descendants');
      }),
    },
  } as unknown as EngineConfiguration;
  return { record, config };
}

it('leaves a genuinely settled terminal close without a refusal stage', async () => {
  const { record, config } = fixture();
  const result = await closeRecord(config, record);
  expect(result).toEqual({ cleanup: 'observed' });
  expect(readRetirementCloseRefusal(record)).toBeUndefined();
  expect(config.processes.observe).not.toHaveBeenCalled();
  expect(config.processes.descendants).not.toHaveBeenCalled();
});

it.each([false, undefined])(
  'retains the first navigation failure %s while joining an independent original proxy close',
  async (cause) => {
    const { record, config } = fixture();
    let release!: () => void;
    let entered!: () => void;
    const proxyEntered = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    const navigation = vi.fn(() => Promise.reject(cause));
    const proxy = vi.fn(async () => {
      entered();
      await held;
      throw new Error('later proxy failure');
    });
    record.ownerNavigationObserver = { close: navigation };
    record.proxy = { close: proxy } as unknown as NonNullable<BrowserRecord['proxy']>;
    const closing = closeRecord(config, record);
    onTestFinished(async () => {
      release();
      await closing;
    });
    let returned = false;
    void closing.then(() => {
      returned = true;
    });
    await proxyEntered;
    await Promise.resolve();
    await Promise.resolve();
    expect(readRetirementCloseRefusal(record)).toBe('navigation');
    expect(returned).toBe(false);
    expect(navigation).toHaveBeenCalledOnce();
    expect(proxy).toHaveBeenCalledOnce();
    release();
    expect(await closing).toEqual({ cleanup: 'failed', reason: 'closeFailed' });
    expect(readRetirementCloseRefusal(record)).toBe('navigation');
    expect(closeRecord(config, record)).toBe(closing);
  }
);

it('records an actual refused journal result without replacing its close outcome', async () => {
  const { record, config } = fixture();
  const stop = vi.fn(async () => 'unknown');
  record.journal = {
    stop,
    custody: () => ({ pending: false, uncertain: false }),
  } as unknown as NonNullable<BrowserRecord['journal']>;
  expect(await closeRecord(config, record)).toEqual({
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  expect(stop).toHaveBeenCalledExactlyOnceWith(false);
  expect(readRetirementCloseRefusal(record)).toBe('journal');
});

it.each([false, undefined])(
  'records the original release refusal %s after earlier owners settle',
  async (cause) => {
    const { record, config } = fixture();
    const release = vi.fn(() => Promise.reject(cause));
    record.reservation = { release } as unknown as NonNullable<BrowserRecord['reservation']>;
    expect(await closeRecord(config, record)).toEqual({
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    });
    expect(release).toHaveBeenCalledOnce();
    expect(readRetirementCloseRefusal(record)).toBe('release');
    expect(record.lifetime.releasePending).toBe(false);
  }
);

it('records snapshot attribution refusal without making a process read', async () => {
  const { record, config } = fixture();
  record.launchEntered = true;
  expect(await closeRecord(config, record)).toEqual({
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  expect(readRetirementCloseRefusal(record)).toBe('snapshot');
  expect(config.processes.descendants).not.toHaveBeenCalled();
  expect(config.processes.observe).not.toHaveBeenCalled();
});

it('records missing original directory custody before release is entered', async () => {
  const { record, config } = fixture();
  const release = vi.fn(async () => {});
  record.profileDir = '/not-used-by-this-refusal';
  record.reservation = { release } as unknown as NonNullable<BrowserRecord['reservation']>;
  expect(await closeRecord(config, record)).toEqual({
    cleanup: 'unverified',
    reason: 'observationUnavailable',
  });
  expect(readRetirementCloseRefusal(record)).toBe('directory');
  expect(release).not.toHaveBeenCalled();
});

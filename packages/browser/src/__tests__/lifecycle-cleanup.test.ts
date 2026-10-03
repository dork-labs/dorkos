import { createPointerLedger } from '../tabs/pointer.js';
import { unavailableDiagnostics } from '../tabs/diagnostics.js';
import { createDiagnosticsBudget } from '../tabs/diagnostics-budget.js';
import { createBrowserLifetime } from '../lifecycle/ownership.js';
import { it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, access, rm, rename, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserContext } from 'playwright-core';
import { closeRecord } from '../lifecycle/close.js';
import type { BrowserRecord, TabRecord } from '../lifecycle/records.js';
import { hostIdentity } from '../runtime/host-identity.js';
import { ownDirectory } from '../profiles/owned-directory.js';
import { realpathSync } from 'node:fs';
import { parseBrowserId, parseTabId } from '../ids.js';
import { configuration } from './lifecycle-fixture.js';

async function ownedChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const exited = once(child, 'exit');
  await once(child, 'spawn');
  const identity = hostIdentity(child.pid!);
  if (!identity) throw Error('CHILD_IDENTITY_UNAVAILABLE');
  return {
    identity,
    async stop() {
      child.kill('SIGTERM');
      await exited;
      expect(hostIdentity(identity.pid)).toBe(null);
    },
  };
}

it('does not reuse a previously complete inventory after the current observer becomes unavailable', async () => {
  const child = await ownedChild();
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-'));
  let closeCalls = 0;
  try {
    const config = await configuration(root, 'http://127.0.0.1:9001');
    config.processes = {
      descendants: async () => ({ status: 'unknown', identities: [] }),
      observe: async () => ({ status: 'dead' }),
    };
    const record = ledger(root, child.identity, {
      close: async () => {
        closeCalls++;
      },
    } as unknown as BrowserContext);
    record.inventoryComplete = true;
    record.identities = [child.identity];
    expect(await closeRecord(config, record)).toEqual({
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    });
    expect(closeCalls).toBe(1);
    await expect(access(root)).resolves.toBeUndefined();
  } finally {
    await child.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it('bounds live-process teardown even when the injected clock does not advance', async () => {
  const child = await ownedChild();
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-'));
  const config = await configuration(root, 'http://127.0.0.1:9001');
  let frozen = true;
  config.clock.monotonicNow = () => (frozen ? 0 : 10000);
  config.processes = {
    descendants: async () => ({ status: 'complete', identities: [child.identity] }),
    observe: async () => ({ status: 'alive' }),
  };
  const operation = closeRecord(
    config,
    ledger(root, child.identity, { close: async () => {} } as unknown as BrowserContext)
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const bounded = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('TEARDOWN_NOT_BOUNDED')), 2600);
    });
    expect(await Promise.race([operation, bounded])).toEqual({
      cleanup: 'failed',
      reason: 'processesRemain',
    });
    await expect(access(root)).resolves.toBeUndefined();
  } finally {
    clearTimeout(timer);
    frozen = false;
    await operation;
    await child.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

function ledger(
  profileDir: string,
  identity: NonNullable<ReturnType<typeof hostIdentity>>,
  context: BrowserContext
): BrowserRecord {
  return {
    diagnosticsBudget: createDiagnosticsBudget(),
    lifetime: createBrowserLifetime('browser_0123456789abcdef0123456789ab', 0),
    browserId: parseBrowserId('browser_0123456789abcdef0123456789ab'),
    browserGeneration: 0,
    mode: 'ephemeral',
    profileDir: realpathSync(profileDir),
    directory: ownDirectory(realpathSync(profileDir)),
    manager: hostIdentity(process.pid)!,
    root: identity,
    rootAttributed: true,
    context,
    launchEntered: true,
    identities: [],
    inventoryComplete: false,
    status: 'running',
    tabs: new Map(),
  };
}

it('retains the owned directory and fixed failure when context close rejects while its exact root lives', async () => {
  const child = await ownedChild();
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-'));
  try {
    const config = await configuration(root, 'http://127.0.0.1:9001');
    const result = await closeRecord(
      config,
      ledger(root, child.identity, {
        close: async () => {
          throw Error('PRIVATE-URL-SECRET');
        },
      } as unknown as BrowserContext)
    );
    expect(result).toEqual({ cleanup: 'failed', reason: 'closeFailed' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-URL-SECRET');
    expect(hostIdentity(child.identity.pid)).toEqual(child.identity);
    await access(root);
  } finally {
    await child.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

it('does not delete a replacement directory after freshly verified exact-root disappearance', async () => {
  const child = await ownedChild();
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-'));
  const moved = root + '-moved';
  try {
    const config = await configuration(root, 'http://127.0.0.1:9001');
    const record = ledger(root, child.identity, {
      close: () => child.stop(),
    } as unknown as BrowserContext);
    await rename(root, moved);
    await mkdir(root, { mode: 0o700 });
    await writeFile(join(root, 'replacement-seed'), 'UNCHANGED');
    expect(await closeRecord(config, record)).toEqual({
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    });
    expect(await readFile(join(root, 'replacement-seed'), 'utf8')).toBe('UNCHANGED');
  } finally {
    await child.stop();
    await rm(root, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

it('refuses corrupt extra identities in a claimed complete census and still attempts owned graceful close', async () => {
  const child = await ownedChild();
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-'));
  try {
    const config = await configuration(root, 'http://127.0.0.1:9001');
    config.processes.descendants = async () => ({
      status: 'complete',
      identities: [child.identity, { pid: 0, birth: 'not-an-identity' }],
    });
    const record = ledger(root, child.identity, {
      close: () => child.stop(),
    } as unknown as BrowserContext);
    expect(await closeRecord(config, record)).toEqual({
      cleanup: 'unverified',
      reason: 'observationUnavailable',
    });
    expect(hostIdentity(child.identity.pid)).toBe(null);
    await access(root);
  } finally {
    await child.stop();
    await rm(root, { recursive: true, force: true });
  }
});

it('drops acquired Page and context references only after fresh complete disappearance proof', async () => {
  const child = await ownedChild();
  const root = await mkdtemp(join(tmpdir(), 'browser-engine-cleanup-'));
  try {
    const config = await configuration(root, 'http://127.0.0.1:9001');
    const record = ledger(root, child.identity, {
      close: () => child.stop(),
    } as unknown as BrowserContext);
    const tabId = parseTabId('tab_0123456789abcdef0123456789abcdef');
    record.tabs.set(tabId, {
      pointer: createPointerLedger(() => null),
      diagnostics: unavailableDiagnostics,
      page: {} as TabRecord['page'],
      binding: {
        browserId: record.browserId,
        browserGeneration: record.browserGeneration,
        tabId,
        navigationGeneration: 0,
        viewportVersion: 0,
        epoch: 0,
        inputGeneration: 0,
      },
      stopped: false,
      captureSequence: 0,
      pending: 0,
      tail: Promise.resolve(),
    });
    expect(await closeRecord(config, record)).toEqual({ cleanup: 'observed' });
    expect(record.context).toBeUndefined();
    expect(record.tabs.size).toBe(0);
    expect(record.root).toBeUndefined();
    expect(record.identities).toEqual([]);
    expect(record.profileDir).toBeUndefined();
    await expect(access(root)).rejects.toThrow();
  } finally {
    await child.stop();
    await rm(root, { recursive: true, force: true });
  }
});

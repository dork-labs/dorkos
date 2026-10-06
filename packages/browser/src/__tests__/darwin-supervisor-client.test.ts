import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, expect, it, onTestFinished, vi } from 'vitest';
import type { ProcessIdentity } from '../configuration.js';
import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';
import { startDarwinSupervisorClient } from '../runtime/darwin-supervisor-client.js';

const rawOriginals = vi.hoisted(() => ({ returns: new Set<Promise<void>>() }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(...args: Parameters<typeof actual.spawn>) {
      const child = actual.spawn(...args);
      const originalClose = (source: ChildProcess | NonNullable<ChildProcess['stdout']>) =>
        new Promise<void>((resolve) => source.once('close', () => resolve()));
      // Capture real terminal and both pipe closes before returning the actual child to the client.
      const returned = Promise.allSettled([
        originalClose(child),
        child.stdout
          ? originalClose(child.stdout)
          : Promise.reject(new Error('FIXTURE_PIPE_MISSING')),
        child.stderr
          ? originalClose(child.stderr)
          : Promise.reject(new Error('FIXTURE_PIPE_MISSING')),
      ]).then((results) => {
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      });
      rawOriginals.returns.add(returned);
      void returned.then(
        () => rawOriginals.returns.delete(returned),
        () => {}
      );
      return child;
    },
  };
});
const acceptedStartupFailures = new Set<unknown>();
afterAll(() => {
  acceptedStartupFailures.clear();
});
const roots: string[] = [];
const originalFinalizers = new Set<() => Promise<void>>();
afterEach(async () => {
  let first: { reason: unknown } | undefined;
  const joined = await Promise.allSettled([...originalFinalizers].map((finish) => finish()));
  originalFinalizers.clear();
  for (const result of joined)
    if (result.status === 'rejected' && !acceptedStartupFailures.has(result.reason))
      first ??= { reason: result.reason };
  const rawReturns = await Promise.allSettled([...rawOriginals.returns]);
  for (const result of rawReturns)
    if (result.status === 'rejected') first ??= { reason: result.reason };
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (reason) {
      first ??= { reason };
    }
  }
  if (first) throw first.reason;
});
async function fixture(
  wrongNonce = false,
  rootFailure: 'none' | 'matching' | 'reused' = 'none',
  onRootFailure: () => void = () => {},
  rootReturn:
    | 'none'
    | 'matching'
    | 'duplicate'
    | 'pre-close'
    | 'pre-ready'
    | 'wrong-nonce'
    | 'reused' = 'none',
  originalRootReturned?: (root: ProcessIdentity) => void | Promise<void>
) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-client-'));
  roots.push(root);
  const workerPath = join(root, 'worker.cjs');
  // A genuine Node/IPC/pipe fixture only; no Chromium or native cleanup claim.
  await writeFile(
    workerPath,
    `let seed; process.on('message', message => {
    if (!seed) { seed=message; ${rootReturn === 'pre-ready' ? `process.send({kind:'rootReturned',nonce:seed.nonce,sequence:1,root:{pid:123,birth:'semantic-only'}});` : ''} process.send({kind:'ready',nonce:seed.nonce,reservationNonce:seed.reservationNonce,browserId:seed.browserId,generation:seed.generation,root:{pid:123,birth:'semantic-only'},supervisor:{pid:process.pid,birth:'semantic-only'},endpointURL:'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',proxyURL:'http://127.0.0.1:1234'}); ${rootReturn === 'pre-close' ? `process.send({kind:'rootReturned',nonce:seed.nonce,sequence:1,root:{pid:123,birth:'semantic-only'}});` : ''} return; }
    if (message.action.kind==='close') { ${rootReturn !== 'none' && rootReturn !== 'pre-close' && rootReturn !== 'pre-ready' ? `process.send({kind:'rootReturned',nonce:${rootReturn === 'wrong-nonce' ? "'wrong'" : 'seed.nonce'},sequence:message.sequence,root:{pid:123,birth:${JSON.stringify(rootReturn === 'reused' ? 'reused-birth' : 'semantic-only')}}}); ${rootReturn === 'duplicate' ? `process.send({kind:'rootReturned',nonce:seed.nonce,sequence:message.sequence,root:{pid:123,birth:'semantic-only'}});` : ''}` : ''} process.send({kind:'closed',nonce:seed.nonce,sequence:message.sequence,returned:true},()=>process.disconnect()); }
    else { ${rootFailure !== 'none' ? `process.send({kind:'rootFailure',nonce:seed.nonce,root:{pid:123,birth:${JSON.stringify(rootFailure === 'matching' ? 'semantic-only' : 'reused-birth')}}});` : ''} process.send({kind:'reply',nonce:${wrongNonce ? "'wrong'" : 'seed.nonce'},sequence:message.sequence,value:[{tab:1,url:'about:blank'}]}); }
  });`
  );
  return startDarwinSupervisorClient(
    {
      workerPath,
      browserId: 'fixture',
      generation: 0,
      reservationNonce: randomUUID(),
      manager: { pid: process.pid, birth: 'fixture-only' },
      profileDir: root,
      origin: 'http://127.0.0.1:1234',
      artifact: { path: join(root, 'not-executed'), sha256: 'a'.repeat(64) },
      runtime: {
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: root,
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: join(root, 'not-executed-browser'),
          sha256: 'b'.repeat(64),
          revision: '1243',
          version: '153.0.8010.12',
          platform: 'darwin',
          arch: 'arm64',
        },
        identity: { mode: 'native', policyRevision: 1 },
      } as BrowserRuntimeDescriptor,
    },
    onRootFailure,
    originalRootReturned
  );
}
it('retains genuine supervisor originals until IPC completion and natural pipe/terminal return', async () => {
  const client = await fixture();
  try {
    expect(await client.list()).toEqual([{ tab: 1, url: 'about:blank' }]);
    expect(client.custody().pending).toBe(true);
    const closing = client.close();
    expect(client.close()).toBe(closing);
    expect(await closing).toEqual({ pending: false, uncertain: false });
    await expect(client.list()).rejects.toThrow('SUPERVISOR_STOPPED');
  } finally {
    await client.close();
  }
});
it('refuses mismatched replies without healing uncertainty when the actual worker later returns', async () => {
  const client = await fixture(true);
  try {
    await expect(client.list()).rejects.toThrow('SUPERVISOR_UNAVAILABLE');
  } finally {
    expect((await client.close()).uncertain).toBe(true);
  }
});

it.each(['matching', 'reused'] as const)(
  'accepts only the exact original root failure %s over genuine IPC',
  async (mode) => {
    let calls = 0;
    const client = await fixture(false, mode, () => {
      calls++;
    });
    try {
      await client.list().catch(() => {});
      expect(calls).toBe(mode === 'matching' ? 1 : 0);
      expect(client.custody().uncertain).toBe(true);
      await expect(client.list()).rejects.toThrow('SUPERVISOR_STOPPED');
      expect((await client.close()).uncertain).toBe(true);
    } finally {
      await client.close();
    }
  }
);

function ownedFixture(release: () => void, ...args: Parameters<typeof fixture>) {
  const originals: {
    starting?: ReturnType<typeof fixture>;
    closing?: ReturnType<Awaited<ReturnType<typeof fixture>>['close']>;
    finalizing?: Promise<void>;
  } = {};
  const finalize = () =>
    (originals.finalizing ??= (async () => {
      let first: { reason: unknown } | undefined;
      try {
        release();
      } catch (reason) {
        first = { reason };
      }
      try {
        if (originals.starting) {
          const original = await originals.starting;
          originals.closing ??= original.close();
          await originals.closing;
        }
      } catch (reason) {
        first ??= { reason };
      }
      const raw = await Promise.allSettled([...rawOriginals.returns]);
      for (const result of raw)
        if (result.status === 'rejected') first ??= { reason: result.reason };
      if (first) throw first.reason;
    })());
  originalFinalizers.add(finalize);
  onTestFinished(async () => {
    try {
      await finalize();
    } catch (reason) {
      // Only the exact startup rejection asserted by the negative control is expected.
      if (!acceptedStartupFailures.has(reason)) throw reason;
    }
  }); // Before fixture acquisition or its original callback can enter.
  originals.starting = fixture(...args);
  void originals.starting.catch(() => {});
  return { starting: originals.starting, finalize };
}

it('joins the captured original root-return receiver through genuine IPC and child EOF', async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const roots: ProcessIdentity[] = [];
  const owned = ownedFixture(
    release,
    false,
    'none',
    () => {},
    'matching',
    (root) => {
      roots.push(root);
      entered();
      return held;
    }
  );
  const client = await owned.starting;
  let settled = false;
  const closing = client.close();
  void closing.then(() => {
    settled = true;
  });
  try {
    await entering;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(roots).toEqual([{ pid: 123, birth: 'semantic-only' }]);
    expect(settled).toBe(false);
    release();
    expect(await closing).toEqual({ pending: false, uncertain: false });
  } finally {
    await owned.finalize();
  }
});

it('retains a falsy original root-return receiver failure instead of reporting healthy closure', async () => {
  const owned = ownedFixture(
    () => {},
    false,
    'none',
    () => {},
    'matching',
    () => {
      throw undefined;
    }
  );
  const client = await owned.starting;
  expect((await client.close()).uncertain).toBe(true);
});

it.each(['none', 'duplicate', 'wrong-nonce', 'reused', 'pre-close'] as const)(
  'refuses missing or uncorrelated original root-return IPC: %s',
  async (mode) => {
    let calls = 0;
    const owned = ownedFixture(
      () => {},
      false,
      'none',
      () => {},
      mode,
      () => {
        calls++;
      }
    );
    const client = await owned.starting;
    try {
      if (mode === 'pre-close') await client.list().catch(() => {});
      expect((await client.close()).uncertain).toBe(true);
      expect(calls).toBe(mode === 'duplicate' ? 1 : 0);
    } finally {
      await client.close();
    }
  }
);

it('joins actual child and pipe return when startup rejects before the private client handle exists', async () => {
  let calls = 0;
  const owned = ownedFixture(
    () => {},
    false,
    'none',
    () => {},
    'pre-ready',
    () => {
      calls++;
    }
  );
  let rejected: { reason: unknown } | undefined;
  try {
    await owned.starting;
  } catch (reason) {
    rejected = { reason };
  }
  expect(rejected).toBeDefined();
  if (!rejected) throw new Error('ORIGINAL_STARTUP_REFUSAL_REQUIRED');
  expect(rejected.reason).toBeInstanceOf(Error);
  acceptedStartupFailures.add(rejected.reason);
  await expect(owned.finalize()).rejects.toBe(rejected.reason);
  expect(rawOriginals.returns.size).toBe(0);
  expect(calls).toBe(0);
});

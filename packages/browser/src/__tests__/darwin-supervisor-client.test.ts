import { captureOriginalSupervisorCloseDiagnostic } from '../lifecycle/supervisor-close-diagnostic.js';
import type { SupervisorOriginalChild } from '../runtime/darwin-supervisor-protocol.js';
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
const baselineOriginal = vi.hoisted(() => ({ observe: vi.fn() }));
vi.mock('../runtime/darwin-engine-processes.js', () => ({
  createDarwinEngineProcesses: () => ({ observeTerminated: baselineOriginal.observe }),
}));
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
  originalRootReturned?: (root: ProcessIdentity) => void | Promise<void>,
  birthMode:
    | 'none'
    | 'matching'
    | 'nonce'
    | 'browser'
    | 'generation'
    | 'manager'
    | 'supervisor'
    | 'ready-root'
    | 'duplicate'
    | 'incomplete' = 'none',
  originalChild?: NonNullable<Parameters<typeof startDarwinSupervisorClient>[3]>,
  baseline: 'none' | 'reported' | 'missing' = 'none',
  originalDiagnostic = ''
) {
  const root = await mkdtemp(join(tmpdir(), 'supervisor-client-'));
  roots.push(root);
  const workerPath = join(root, 'worker.cjs');
  // A genuine Node/IPC/pipe fixture only; no Chromium or native cleanup claim.
  await writeFile(
    workerPath,
    `let seed; const ready=()=>process.send({kind:'ready',nonce:seed.nonce,reservationNonce:seed.reservationNonce,browserId:seed.browserId,generation:seed.generation,root:{pid:123,birth:${JSON.stringify('semantic-only')}},supervisor:{pid:process.pid,birth:'semantic-only'},endpointURL:'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',proxyURL:'http://127.0.0.1:1234'}); process.on('message', message => {
    if (!seed) { seed=message; process.stderr.write(${JSON.stringify(originalDiagnostic)});
      ${birthMode !== 'none' ? `const original={identities:[{pid:123,birth:'semantic-only'}],complete:${birthMode !== 'incomplete'},root:{pid:123,birth:'semantic-only'},supervisor:{pid:${birthMode === 'supervisor' ? 'process.pid+1' : 'process.pid'},birth:'semantic-only'},manager:${birthMode === 'manager' ? "{...seed.manager,birth:'wrong-manager'}" : 'seed.manager'}}; const birth={kind:'originalChild',nonce:${birthMode === 'nonce' ? "'00000000-0000-4000-8000-000000000000'" : 'seed.nonce'},reservationNonce:seed.reservationNonce,browserId:${birthMode === 'browser' ? "'foreign-browser'" : 'seed.browserId'},generation:${birthMode === 'generation' ? 'seed.generation+1' : 'seed.generation'},original};process.send(birth);${birthMode === 'duplicate' ? 'process.send(birth);' : ''} return;` : ''}
      ${rootReturn === 'pre-ready' ? `process.send({kind:'rootReturned',nonce:seed.nonce,sequence:1,root:{pid:123,birth:'semantic-only'}});` : ''} process.send({kind:'ready',nonce:seed.nonce,reservationNonce:seed.reservationNonce,browserId:seed.browserId,generation:seed.generation,root:{pid:123,birth:'semantic-only'},supervisor:{pid:process.pid,birth:'semantic-only'},endpointURL:'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',proxyURL:'http://127.0.0.1:1234'}); ${rootReturn === 'pre-close' ? `process.send({kind:'rootReturned',nonce:seed.nonce,sequence:1,root:{pid:123,birth:'semantic-only'}});` : ''} return; }
    if(message.kind==='originalChildObserved') { ${birthMode === 'ready-root' ? "process.send({kind:'ready',nonce:seed.nonce,reservationNonce:seed.reservationNonce,browserId:seed.browserId,generation:seed.generation,root:{pid:123,birth:'reused-root'},supervisor:{pid:process.pid,birth:'semantic-only'},endpointURL:'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',proxyURL:'http://127.0.0.1:1234'});" : 'ready();'} return; }
    if (message.action.kind==='close') { ${baseline === 'reported' ? `process.send({kind:'nativeBaselineObserved',nonce:seed.nonce,identities:[{pid:321,birth:'original-baseline-semantic'}]});` : ''} ${rootReturn !== 'none' && rootReturn !== 'pre-close' && rootReturn !== 'pre-ready' ? `process.send({kind:'rootReturned',nonce:${rootReturn === 'wrong-nonce' ? "'wrong'" : 'seed.nonce'},sequence:message.sequence,root:{pid:123,birth:${JSON.stringify(rootReturn === 'reused' ? 'reused-birth' : 'semantic-only')}}}); ${rootReturn === 'duplicate' ? `process.send({kind:'rootReturned',nonce:seed.nonce,sequence:message.sequence,root:{pid:123,birth:'semantic-only'}});` : ''}` : ''} process.send({kind:'closed',nonce:seed.nonce,sequence:message.sequence,returned:true},()=>process.disconnect()); }
    else { ${rootFailure !== 'none' ? `process.send({kind:'rootFailure',nonce:seed.nonce,root:{pid:123,birth:${JSON.stringify(rootFailure === 'matching' ? 'semantic-only' : 'reused-birth')}}});` : ''} process.send({kind:'reply',nonce:${wrongNonce ? "'wrong'" : 'seed.nonce'},sequence:message.sequence,value:[{tab:1,url:'about:blank',targetId:'original-target'}]}); }
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
      ...(baseline !== 'none'
        ? {
            identityPreparation: {
              nativeRuntime: {
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
          }
        : {}),
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
        identity: { mode: baseline === 'none' ? 'native' : 'chrome-compatible', policyRevision: 1 },
      } as BrowserRuntimeDescriptor,
    },
    onRootFailure,
    originalRootReturned,
    originalChild
  );
}
it('retains genuine supervisor originals until IPC completion and natural pipe/terminal return', async () => {
  const client = await fixture();
  try {
    expect(await client.list()).toEqual([
      { tab: 1, url: 'about:blank', targetId: 'original-target' },
    ]);
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

it.each([false, undefined])(
  'retains original root-return receiver failure %s with its fixed branch',
  async (cause) => {
    const owned = ownedFixture(
      () => {},
      false,
      'none',
      () => {},
      'matching',
      () => {
        throw cause;
      }
    );
    const client = await owned.starting;
    expect((await client.close()).uncertain).toBe(true);
    expect(client.diagnostics()).toContain('SUPERVISOR_UNCERTAIN: CLIENT_ROOT_FORWARD_REFUSED');
  }
);

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

it('joins the exact private child observer before readiness over actual child IPC and pipes', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const observe = vi.fn(async (original: SupervisorOriginalChild) => {
    expect(original.root).toEqual({ pid: 123, birth: 'semantic-only' });
    expect(original.manager.pid).toBe(process.pid);
    expect(original.supervisor.pid).not.toBe(process.pid);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.root)).toBe(true);
    entered();
    await held;
  });
  const owned = ownedFixture(
    release,
    false,
    'none',
    () => {},
    'none',
    undefined,
    'matching',
    observe
  );
  let settled = false;
  void owned.starting.then(() => {
    settled = true;
  });
  try {
    await entering;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    const client = await owned.starting;
    expect(observe).toHaveBeenCalledOnce();
    expect(await client.close()).toEqual({ pending: false, uncertain: false });
  } finally {
    await owned.finalize();
  }
});

it.each([
  'nonce',
  'browser',
  'generation',
  'manager',
  'supervisor',
  'ready-root',
  'duplicate',
  'incomplete',
] as const)(
  'refuses substituted private child role/correlation %s through actual IPC',
  async (mode) => {
    const observe = vi.fn(async () => {});
    const owned = ownedFixture(
      () => {},
      false,
      'none',
      () => {},
      'none',
      undefined,
      mode,
      observe
    );
    let failure: unknown,
      rejected = false;
    try {
      await owned.starting;
    } catch (value) {
      failure = value;
      rejected = true;
      acceptedStartupFailures.add(value);
    }
    expect(rejected).toBe(true);
    expect(failure).toBeInstanceOf(Error);
    if (!['ready-root', 'duplicate', 'incomplete'].includes(mode))
      expect(observe).not.toHaveBeenCalled();
    await owned.finalize().catch((value) => {
      expect(value).toBe(failure);
    });
  }
);

it.each([undefined, false])(
  'preserves private original child receiver rejection %s and joins real EOF',
  async (original) => {
    const observe = vi.fn(async () => {
      throw original;
    });
    const owned = ownedFixture(
      () => {},
      false,
      'none',
      () => {},
      'none',
      undefined,
      'matching',
      observe
    );
    let rejected = false;
    try {
      await owned.starting;
    } catch (value) {
      rejected = true;
      expect(value).toBe(original);
      acceptedStartupFailures.add(value);
    }
    expect(rejected).toBe(true);
    expect(observe).toHaveBeenCalledOnce();
    await owned.finalize().catch((value) => {
      expect(value).toBe(original);
    });
  }
);

it.each(['dead', 'unknown', 'undefined', 'missing'] as const)(
  'joins genuine IPC/pipe return and independently observes original baseline subjects: %s',
  async (status) => {
    baselineOriginal.observe.mockReset();
    if (status === 'undefined') baselineOriginal.observe.mockRejectedValue(undefined);
    else
      baselineOriginal.observe.mockResolvedValue({
        status: status === 'dead' ? 'dead' : 'unknown',
      });
    const owned = ownedFixture(
      () => {},
      false,
      'none',
      () => {},
      'matching',
      () => {},
      'none',
      undefined,
      status === 'missing' ? 'missing' : 'reported'
    );
    const client = await owned.starting;
    const result = await client.close();
    expect(result).toEqual({ pending: false, uncertain: status !== 'dead' });
    if (status === 'dead') expect(client.diagnostics()).not.toContain('SUPERVISOR_UNCERTAIN');
    else
      expect(client.diagnostics()).toContain(
        status === 'missing' ? 'CLIENT_BASELINE_MISSING' : 'CLIENT_BASELINE_RETURN'
      );
    if (status === 'missing') expect(baselineOriginal.observe).not.toHaveBeenCalled();
    else {
      expect(baselineOriginal.observe).toHaveBeenCalledTimes(1);
      expect(baselineOriginal.observe.mock.calls[0]?.[0]).toEqual({
        pid: 321,
        birth: 'original-baseline-semantic',
      });
    }
    await owned.finalize();
    expect(rawOriginals.returns.size).toBe(0);
  }
);

it('retains the original pre-init child acknowledgement and Chrome baseline return duties together', async () => {
  baselineOriginal.observe.mockReset();
  baselineOriginal.observe.mockResolvedValue({ status: 'dead' });
  const originalChild = vi.fn(async (original: SupervisorOriginalChild) => {
    expect(original.manager.pid).toBe(process.pid);
    expect(original.root.birth).toBe('semantic-only');
  });
  const owned = ownedFixture(
    () => {},
    false,
    'none',
    () => {},
    'matching',
    () => {},
    'matching',
    originalChild,
    'reported'
  );
  try {
    const client = await owned.starting;
    expect(originalChild).toHaveBeenCalledOnce();
    expect(baselineOriginal.observe).not.toHaveBeenCalled();
    expect(await client.close()).toEqual({ pending: false, uncertain: false });
    expect(baselineOriginal.observe).toHaveBeenCalledOnce();
    expect(rawOriginals.returns.size).toBe(0);
  } finally {
    await owned.finalize();
  }
});

it('projects client refusal after a genuine original pipe ends with unterminated diagnostic text', async () => {
  baselineOriginal.observe.mockReset();
  baselineOriginal.observe.mockResolvedValue({ status: 'unknown' });
  const owned = ownedFixture(
    () => {},
    false,
    'none',
    () => {},
    'matching',
    () => {},
    'none',
    undefined,
    'reported',
    'fixture-private-unterminated'
  );
  const client = await owned.starting;
  expect(await client.close()).toEqual({ pending: false, uncertain: true });
  expect(client.diagnostics()).toContain(
    'fixture-private-unterminated\nSUPERVISOR_UNCERTAIN: CLIENT_BASELINE_RETURN'
  );
  const projected: string[] = [];
  captureOriginalSupervisorCloseDiagnostic(client, (value) => projected.push(value))();
  expect(projected).toHaveLength(1);
  expect(projected[0]).toContain('"state":"observed"');
  expect(projected[0]).toContain('CLIENT_BASELINE_RETURN');
  expect(projected[0]).not.toContain('fixture-private-unterminated');
  expect(baselineOriginal.observe).toHaveBeenCalledTimes(1);
  await owned.finalize();
});

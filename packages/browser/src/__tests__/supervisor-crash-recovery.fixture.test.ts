import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdtemp,
  realpath,
  readFile,
  writeFile,
  readdir,
  rm,
  mkdir,
  unlink,
  lstat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { constructOwnedBrowserEngine, type PrivateBrowserRetirementReceiver } from '../engine.js';
import type { EngineConfiguration, ProcessIdentity } from '../configuration.js';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { verifiedLibrary } from '../runtime/public-library.js';
import { validateJournalSnapshot, type JournalSnapshot } from '../lifecycle/process-journal.js';
import { reserveProfile } from '../profiles/reservation.js';
import { parseProfileId } from '../ids.js';
import { parseBrowserResult } from '../contracts.js';
import { ownFixtureManager } from './fixture-manager-custody.js';
import { ownFixtureSession } from './fixture-session-custody.js';
import { ownFixtureCustody } from './fixture-custody.js';
// Private native arm; ordinary tests never launch Chromium or signal any process.
// eslint-disable-next-line no-restricted-syntax
const fixtureJSON = process.env.DORKOS_DARWIN_SUPERVISOR_FIXTURE;
const requestId = () => randomBytes(16).toString('base64url');
const profileId = 'profile_crash_original_00000000000';
async function fixture() {
  const input = JSON.parse(await readFile(fixtureJSON!, 'utf8')) as {
    helper: string;
    worker: string;
    executable: string;
    executableSHA256: string;
  };
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'supervisor-recovery-')));
  const custody = ownFixtureCustody();
  try {
    let effects = 0;
    const server = createServer((request, response) => {
      if (request.url === '/effect') {
        effects++;
        response.end('effect');
      } else
        response.end(
          '<button style="position:fixed;left:20px;top:20px;width:120px;height:60px" onclick="fetch(\'/effect\')">Effect</button>'
        );
    });
    custody.adopt(
      'origin-server:close',
      server,
      (original) =>
        new Promise<void>((resolve, reject) =>
          original.close((error) => (error ? reject(error) : resolve()))
        )
    );
    server.listen(0, '127.0.0.1');
    await custody.operation('origin-server:listening', () => once(server, 'listening'));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('FIXTURE_SERVER_UNAVAILABLE');
    const artifact = {
      path: input.helper,
      sha256: createHash('sha256')
        .update(await readFile(input.helper))
        .digest('hex'),
    };
    const require = createRequire(import.meta.url);
    const config: EngineConfiguration = {
      dataDir: join(directory, 'data'),
      runtime: {
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: await realpath(dirname(require.resolve('playwright-core/package.json'))),
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: input.executable,
          sha256: input.executableSHA256,
          revision: '1243',
          version: '153.0.8010.12',
          platform: 'darwin',
          arch: 'arm64',
        },
        identity: { mode: 'native', policyRevision: 1 },
      },
      network: { kind: 'fixture', origin: `http://127.0.0.1:${address.port}` },
      clock: { monotonicNow: () => performance.now(), wallNow: () => Date.now() },
      processes: {
        observe: async () => ({ status: 'unknown' }),
        descendants: async () => ({ status: 'unknown', identities: [] }),
      },
      policy: { authorizeAction: async () => 'allowed', verifyBrokerLease: async () => 'unknown' },
      nativeJournal: {
        workerPath: new URL('../../dist/runtime/darwin-journal-worker.js', import.meta.url)
          .pathname,
        browserWorkerPath: input.worker,
        artifact,
        duration: 30000,
        maxGap: 5000,
      },
    };
    const native = createDarwinEngineProcesses(artifact);
    const receivers: PrivateBrowserRetirementReceiver[] = [];
    const expectedCrashReturns = new Map<
      string,
      Awaited<PrivateBrowserRetirementReceiver['observation']>
    >();
    const engine = constructOwnedBrowserEngine(config, {
      registerBirth: (value) => {
        receivers.push(value);
      },
      refuseBirth() {},
    });
    custody.adopt(
      'engine:shutdown',
      engine,
      (original) => original.shutdown(),
      (value) => {
        if (!Array.isArray(value) || value.length !== receivers.length) return false;
        const expected = new Set(
          receivers.map((receiver) => `${receiver.browserId}:${receiver.browserGeneration}`)
        );
        return (
          value.every((item) => {
            const result = parseBrowserResult(item);
            if (result.kind !== 'close') return false;
            const key = `${result.browserId}:${result.browserGeneration}`;
            if (!expected.delete(key)) return false;
            if (result.cleanup !== 'observed') {
              const crash = expectedCrashReturns.get(key);
              if (
                !crash ||
                crash.firstCause !== 'engineFault' ||
                result.cleanup !== crash.terminal.cleanup ||
                !('reason' in result) ||
                !('reason' in crash.terminal) ||
                result.reason !== crash.terminal.reason
              )
                return false;
            }
            return true;
          }) && expected.size === 0
        );
      }
    );
    return {
      directory,
      custody,
      config,
      native,
      engine,
      receivers,
      expectedCrashReturns,
      nativeFacts: {
        snapshots: [] as JournalSnapshot[],
        final: [] as { identity: ProcessIdentity; status: string }[],
        queries: 0,
      },
      effects: () => effects,
      closeServer: () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        ),
    };
  } catch (primary) {
    const result = await custody.finish();
    if (result.observed) {
      try {
        await custody.operation('setup-root:remove', () =>
          rm(directory, { recursive: true, force: true })
        );
      } catch {
        /* Keep the original failure. */
      }
    }
    throw primary;
  }
}
async function originals(f: Awaited<ReturnType<typeof fixture>>) {
  let snapshot: ReturnType<typeof validateJournalSnapshot> | undefined;
  await expect
    .poll(
      async () => {
        const names = await readdir(join(f.config.dataDir, 'journals'));
        snapshot = validateJournalSnapshot(
          JSON.parse(
            await readFile(join(f.config.dataDir, 'journals', names[0]!, 'snapshot.json'), 'utf8')
          )
        );
        return snapshot.retainedIdentities.filter(
          (value) =>
            value.role === 'descendant' && value.parent?.pid !== snapshot!.binding.manager.pid
        ).length;
      },
      { timeout: 5000 }
    )
    .toBeGreaterThan(0);
  expect(snapshot!.gaps).toEqual([]);
  expect(snapshot!.root.kind).toBe('attributed');
  f.nativeFacts.snapshots.push(snapshot!);
  return snapshot!;
}
async function gone(
  f: Awaited<ReturnType<typeof fixture>>,
  identities: readonly ProcessIdentity[]
) {
  await expect
    .poll(
      async () => {
        const values = await f.custody.operation(
          'native-originals:inspect',
          () =>
            Promise.all(
              identities.map((identity) =>
                f.native.processes.observe(identity, new AbortController().signal)
              )
            ),
          2000
        );
        f.nativeFacts.queries++;
        f.nativeFacts.final = identities.map((identity, index) => ({
          identity,
          status: values[index]!.status,
        }));
        return values.every((value) => value.status === 'dead');
      },
      { timeout: 10000 }
    )
    .toBe(true);
}
async function restart(
  f: Awaited<ReturnType<typeof fixture>>,
  old: { browserId: string; browserGeneration: number; tab: unknown },
  originalCleanupObserved = false
) {
  const marker = join(f.config.dataDir, 'profiles', profileId, 'fixture-marker');
  const owner = join(f.config.dataDir, 'reservations', profileId, 'owner.json');
  if (!originalCleanupObserved) {
    const before = await readFile(owner, 'utf8');
    await expect(
      f.engine.open({ kind: 'open', mode: 'persistent', profileId, requestId: requestId() })
    ).rejects.toMatchObject({ code: 'PROFILE_UNCERTAIN' });
    expect(await readFile(owner, 'utf8')).toBe(before);
  }
  expect(await readFile(marker, 'utf8')).toBe('original-value');
  await expect(
    f.engine.capture({ kind: 'capture', binding: old.tab, requestId: requestId() })
  ).rejects.toBeDefined();
  const opened = await f.engine.open({
    kind: 'open',
    mode: 'persistent',
    profileId: originalCleanupObserved ? profileId : 'profile_crash_fresh_00000000000000',
    requestId: requestId(),
  });
  expect(opened.browserId).not.toBe(old.browserId);
  const capture = await f.custody.operation('fresh:capture', () =>
    f.engine.capture({
      kind: 'capture',
      binding: opened.tab,
      requestId: requestId(),
    })
  );
  expect(capture.receipt.width).toBe(1280);
  expect(f.effects()).toBe(1); // No interrupted input or old native IDs were replayed.
  const closed = await f.custody.operation('fresh:close', () =>
    f.engine.close({
      kind: 'close',
      browserId: opened.browserId,
      browserGeneration: opened.browserGeneration,
      requestId: requestId(),
    })
  );
  expect(closed.cleanup).toBe('observed');
  expect(
    (await f.custody.operation('fresh:retirement', () => f.receivers.at(-1)!.observation, 6000))
      .firstCause
  ).toBe('explicitStop');
}

async function finishFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: string,
  observed: boolean,
  failed: boolean,
  primary: unknown,
  controller?: { close(): Promise<void> }
) {
  void controller; // Its original is already retained by the acquisition ledger.
  const cleanup = await f.custody.finish(5000);
  const expectedCrashUncertainty = [...f.expectedCrashReturns.entries()].map(
    ([generation, retirement]) => ({ generation, retirement })
  );
  let hasPrimary = failed,
    original = primary;
  try {
    const evidence = new URL('../../.temp/', import.meta.url).pathname;
    await mkdir(evidence, { recursive: true, mode: 0o700 });
    await f.custody.operation('receipt:write', () =>
      writeFile(
        join(evidence, `crash-${mode}-${randomBytes(8).toString('hex')}.json`),
        JSON.stringify({
          mode,
          observed,
          coverage: observed ? 'complete-observed' : 'unverified',
          nativeFacts: f.nativeFacts,
          outcome:
            hasPrimary || !cleanup.observed
              ? 'failed'
              : observed && !expectedCrashUncertainty.length
                ? 'pass'
                : 'held',
          expectedCrashUncertainty,
          proof: observed ? 'native-crash-recovery-observed' : 'unverified',
          fixtureDirectory: f.directory,
          cleanup,
          primary: hasPrimary
            ? original instanceof Error
              ? original.message
              : String(original)
            : null,
        }),
        { mode: 0o600 }
      )
    );
    if (
      observed &&
      cleanup.observed &&
      !expectedCrashUncertainty.length &&
      f.custody.snapshot().observed &&
      !hasPrimary
    )
      await f.custody.operation('fixture-root:remove', () =>
        rm(f.directory, { recursive: true, force: true })
      );
  } catch (error) {
    if (!hasPrimary) {
      hasPrimary = true;
      original = error;
    }
  }
  if (!hasPrimary && !cleanup.observed) {
    hasPrimary = true;
    original = new Error('FIXTURE_UNEXPECTED_AUXILIARY_CLEANUP');
  }
  if (hasPrimary) throw original;
}

it.skipIf(!fixtureJSON || process.platform !== 'darwin').each(['renderer', 'browser'] as const)(
  'original %s crash retires IDs, retains quarantine and permits a distinct fresh relationship without replay',
  async (mode) => {
    const f = await fixture();
    let observed = false,
      failed = false,
      primary: unknown;
    let controller:
      | Awaited<ReturnType<Awaited<ReturnType<typeof verifiedLibrary>>['connectOverCDP']>>
      | undefined;
    try {
      const opened = await f.engine.open({
        kind: 'open',
        mode: 'persistent',
        profileId,
        requestId: requestId(),
      });
      await writeFile(
        join(f.config.dataDir, 'profiles', profileId, 'fixture-marker'),
        'original-value',
        { mode: 0o600 }
      );
      expect(
        await f.engine.input({
          kind: 'input',
          requestId: requestId(),
          binding: opened.tab,
          steps: [{ kind: 'click', x: 60, y: 45, button: 'left' }],
        })
      ).toMatchObject({ outcome: 'completed' });
      await expect.poll(f.effects).toBe(1);
      const snapshot = await originals(f),
        receiver = f.receivers[0]!;
      const endpoint = receiver.verifiedBrowserAdminEndpoint();
      if (!endpoint) throw new Error('FIXTURE_ORIGINAL_ENDPOINT_UNAVAILABLE');
      if (mode === 'browser') {
        const version = await f.custody.operation('crash-socket:discovery', async () => {
          const response = await fetch(`${endpoint.url}/json/version`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error('FIXTURE_CDP_DISCOVERY_FAILED');
          return (await response.json()) as { webSocketDebuggerUrl?: string };
        });
        const socketURL = new URL(version.webSocketDebuggerUrl!);
        if (
          socketURL.protocol !== 'ws:' ||
          socketURL.host !== new URL(endpoint.url).host ||
          !socketURL.pathname.startsWith('/devtools/browser/')
        )
          throw new Error('FIXTURE_CDP_ENDPOINT_MISMATCH');
        const socket = new WebSocket(socketURL);
        const originalSend = socket.send,
          originalClose = socket.close;
        const closed = new Promise<void>((resolve) =>
          socket.addEventListener(
            'close',
            (event) => {
              if (event.target === socket) resolve();
            },
            { once: true }
          )
        );
        f.custody.adopt('crash-socket:close', socket, async (original) => {
          if (original.readyState !== WebSocket.CLOSED) Reflect.apply(originalClose, original, []);
          await closed;
        });
        await f.custody.operation(
          'crash-socket:open',
          () =>
            new Promise<void>((resolve, reject) => {
              socket.addEventListener('open', () => resolve(), { once: true });
              socket.addEventListener(
                'error',
                () => reject(new Error('FIXTURE_CDP_SOCKET_FAILED')),
                { once: true }
              );
            })
        );
        await f.custody.operation('named-crash:submission', async () => {
          const currentEndpoint = receiver.verifiedBrowserAdminEndpoint();
          if (
            !currentEndpoint ||
            currentEndpoint.url !== endpoint.url ||
            JSON.stringify(currentEndpoint.root) !== JSON.stringify(endpoint.root) ||
            JSON.stringify(currentEndpoint.supervisor) !== JSON.stringify(endpoint.supervisor)
          )
            throw new Error('FIXTURE_ORIGINAL_ENDPOINT_CHANGED');
          Reflect.apply(originalSend, socket, [JSON.stringify({ id: 1, method: 'Browser.crash' })]);
        });
      } else {
        const library = await f.custody.operation('fixture-library:verify', () =>
          verifiedLibrary(f.config.runtime)
        );
        controller = await f.custody.acquire(
          'controller:attach',
          () => library.connectOverCDP(endpoint.url, { timeout: 5000 }),
          (value) => value.close()
        );
        const originalController = controller;
        const sessionOwner = await f.custody.acquire(
          'crash-session:attach',
          async () => {
            const native =
              mode === 'renderer'
                ? await originalController
                    .contexts()[0]!
                    .newCDPSession(originalController.contexts()[0]!.pages()[0]!)
                : await originalController.newBrowserCDPSession();
            return ownFixtureSession(native, originalController);
          },
          (value) => value.close(),
          5000,
          (value) =>
            !!value && typeof value === 'object' && 'observed' in value && value.observed === true
        );
        const session = sessionOwner.session;
        // A named native crash may reject its command response; retain that exact original settlement.
        void f.custody
          .operation('named-crash:command', () =>
            Promise.allSettled([session.send(mode === 'renderer' ? 'Page.crash' : 'Browser.crash')])
          )
          .catch(() => {});
      }
      const retired = await f.custody.operation(
        'crash:retirement',
        () => receiver.observation,
        6000
      );
      expect(retired.firstCause).toBe('engineFault');
      if (retired.terminal.cleanup !== 'observed') {
        if (retired.terminal.cleanup === 'failed') {
          expect(mode).toBe('browser');
          expect(retired.terminal.reason).toBe('closeFailed');
        } else expect(retired.terminal.cleanup).toBe('unverified');
        expect(retired.uncertainty.length).toBeGreaterThan(0);
        const crashGaps = new Set([
          'permitUnavailable',
          'targetChanged',
          'drainTimeout',
          'releaseTimeout',
          'custodyPending',
          'observationUnavailable',
          'drainFailed',
          'releaseFailed',
          'terminalCloseFailed',
        ]);
        expect(retired.uncertainty.every((gap) => crashGaps.has(gap))).toBe(true);
        f.expectedCrashReturns.set(`${receiver.browserId}:${receiver.browserGeneration}`, retired);
      }
      expect(receiver.isOrdinary()).toBe(false);
      const ownerPath = join(f.config.dataDir, 'reservations', profileId, 'owner.json');
      try {
        expect(JSON.parse(await readFile(ownerPath, 'utf8')).failure).toBe(mode);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        expect(retired.terminal.cleanup).toBe('observed');
      }
      await gone(
        f,
        snapshot.retainedIdentities
          .filter((value) => value.role !== 'manager')
          .map((value) => value.identity)
      );
      observed = true;
      await restart(f, opened, retired.terminal.cleanup === 'observed');
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finishFixture(f, mode, observed, failed, primary, controller);
    }
  },
  45000
);

it.skipIf(!fixtureJSON || process.platform !== 'darwin')(
  'original manager death refuses its live root before profile mutation and reconciles only recorded descendants after loss',
  async () => {
    const f = await fixture();
    let observed = false,
      failed = false,
      primary: unknown;
    try {
      const seed = join(f.directory, 'seed.json'),
        script = join(f.directory, 'manager.cjs');
      await writeFile(seed, JSON.stringify(f.config), { mode: 0o600 });
      const module = new URL('../../dist/engine.js', import.meta.url).href;
      await writeFile(
        script,
        `(async()=>{
      const fs=require('node:fs/promises');const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
      config.clock={monotonicNow:()=>performance.now(),wallNow:()=>Date.now()};
      config.processes={observe:async()=>({status:'unknown'}),descendants:async()=>({status:'unknown',identities:[]})};
      config.policy={authorizeAction:async()=> 'allowed',verifyBrokerLease:async()=> 'unknown'};
      const {constructOwnedBrowserEngine}=await import(${JSON.stringify(module)});
      const engine=constructOwnedBrowserEngine(config,{registerBirth(){},refuseBirth(){}});
      let closing; const close=()=>closing??=(async()=>{try{await engine.shutdown()}finally{if(process.connected)process.disconnect()}})();
      process.on('message',()=>{void close().catch(()=>{process.exitCode=1})});
      process.once('disconnect',()=>{void close().catch(()=>{process.exitCode=1})});
      try {
      const opened=await engine.open({kind:'open',mode:'persistent',profileId:${JSON.stringify(profileId)},requestId:${JSON.stringify(requestId())}});
      const input=await engine.input({kind:'input',binding:opened.tab,requestId:${JSON.stringify(requestId())},steps:[{kind:'click',x:60,y:45,button:'left'}]});
      if(input.outcome!=='completed')throw new Error('FIXTURE_INPUT_NOT_COMPLETED');
      process.send(opened);
      } catch(primary) { await close().catch(()=>{}); throw primary; }
    })().catch(error=>{console.error(error);process.exitCode=1;if(process.connected)process.disconnect()});`,
        { mode: 0o600 }
      );
      const manager = spawn(process.execPath, [script, seed], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      const managerOwner = ownFixtureManager(manager);
      f.custody.adopt(
        'manager:close',
        managerOwner,
        (owner) => owner.close(),
        (value) =>
          !!value && typeof value === 'object' && 'observed' in value && value.observed === true
      );
      const opened = parseBrowserResult(await managerOwner.ready());
      if (opened.kind !== 'opened') throw new Error('FIXTURE_OPENED_RESULT_REQUIRED');
      await expect.poll(f.effects).toBe(1);
      const snapshot = await originals(f);
      expect(snapshot.binding.manager.pid).toBe(manager.pid);
      const marker = join(f.config.dataDir, 'profiles', profileId, 'fixture-marker');
      await writeFile(marker, 'original-value', { mode: 0o600 });
      const ownerPath = join(f.config.dataDir, 'reservations', profileId, 'owner.json');
      const owner = await readFile(ownerPath, 'utf8');
      // Remove only this fictitious profile's native lock to exercise the absent-lock mutant.
      const nativeLock = join(f.config.dataDir, 'profiles', profileId, 'SingletonLock');
      expect((await lstat(nativeLock)).isSymbolicLink()).toBe(true);
      await unlink(nativeLock);
      await expect(lstat(nativeLock)).rejects.toMatchObject({ code: 'ENOENT' });
      const currentManager = await f.native.identity(process.pid);
      if (!currentManager) throw new Error('FIXTURE_RECOVERY_MANAGER_UNAVAILABLE');
      // Exact journal metadata automatically reaches the genuine native observer; no synthetic recovery callback.
      await expect(
        reserveProfile(f.config, f.config.dataDir, parseProfileId(profileId), currentManager)
      ).rejects.toMatchObject({ code: 'PROFILE_IN_USE' });
      expect(await readFile(ownerPath, 'utf8')).toBe(owner);
      await expect(lstat(nativeLock)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(marker, 'utf8')).toBe('original-value');
      // Signal only this actual original fixture-owned manager child; never a PID from metadata.
      expect(managerOwner.crash()).toBe(true);
      expect(await f.custody.operation('manager:returned', () => managerOwner.returned, 2000)).toBe(
        true
      );
      await gone(
        f,
        snapshot.retainedIdentities.map((value) => value.identity)
      );
      observed = true;
      await restart(f, opened);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finishFixture(f, 'manager', observed, failed, primary);
    }
  },
  45000
);

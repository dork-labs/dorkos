import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  createRuntimeInstallation,
  type InstallationConfiguration,
} from '@dorkos/browser/runtime-installation';
import { createDb, runMigrations, workspaces } from '@dorkos/db';
import { createAuth } from '../../../../core/auth/index.js';
import { initConfigManager, configManager } from '../../../../core/config-manager.js';
import { createServerInventory } from '../server-inventory.js';
import { createInputAcceptanceComposition } from './input-acceptance-composition.js';
// Explicit fixture-owned installation input. No default-suite browser, download or personal profile.
const fixturePath = process.env.DORKOS_BROWSER_INPUT_ACCEPTANCE_FIXTURE;
const cleanups: Array<() => Promise<void>> = [];
// Actual originals remain strongly held if a detach/connection-close rejects.
const retainedFixtureControllers = new Set<object>();
const retainedFixtureReaders = new Set<object>();
const retainedFixtureListeners = new Set<object>();
let fixtureCleanupFailed = false;
async function boundedFixtureOperation<T>(original: Promise<T>): Promise<T> {
  // Timeout is uncertainty; retain the actual object/promise and never retry its close.
  void original.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('FIXTURE_ORIGINAL_OPERATION_HELD')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  let failed = false;
  let first: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
      fixtureCleanupFailed = true;
    }
  }
  console.info(
    JSON.stringify({
      fixtureCleanupFailed,
      heldControllers: retainedFixtureControllers.size,
      heldReaders: retainedFixtureReaders.size,
      heldListeners: retainedFixtureListeners.size,
    })
  );
  if (failed) throw first;
});
const closeServer = async (original: ReturnType<typeof createServer>) => {
  const slot = { original, pending: undefined as Promise<void> | undefined };
  retainedFixtureListeners.add(slot);
  try {
    original.closeAllConnections();
    slot.pending = Promise.resolve().then(
      () =>
        new Promise<void>((resolve, reject) =>
          original.close((error) => (error ? reject(error) : resolve()))
        )
    );
    await boundedFixtureOperation(slot.pending);
    retainedFixtureListeners.delete(slot);
  } catch (error) {
    fixtureCleanupFailed = true;
    throw error;
  }
};
async function smallFile(path: string, cap: number): Promise<Buffer> {
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.size > BigInt(cap)) throw new Error('FIXTURE_INPUT_INVALID');
  const original = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  retainedFixtureReaders.add(original);
  let failed = false,
    primary: unknown,
    result: Buffer | undefined;
  try {
    const before = await original.stat({ bigint: true });
    if (before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size)
      throw new Error('FIXTURE_INPUT_CHANGED');
    const bytes = Buffer.alloc(cap + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await original.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await original.stat({ bigint: true });
    if (
      count > cap ||
      BigInt(count) !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error('FIXTURE_INPUT_CHANGED');
    result = bytes.subarray(0, count);
  } catch (error) {
    failed = true;
    primary = error;
  }
  try {
    await original.close();
    retainedFixtureReaders.delete(original);
  } catch (error) {
    if (!failed) primary = error;
    failed = true;
  }
  if (failed) throw primary;
  return result!;
}
it.skipIf(!fixturePath || process.platform !== 'darwin' || process.arch !== 'arm64').each([
  { scenario: 'healthy original shutdown', blockedFault: false },
  { scenario: 'blocked original effect retains uncertainty', blockedFault: true },
])(
  'actual generation input/reset: $scenario',
  async ({ blockedFault }) => {
    const fixture = JSON.parse((await smallFile(fixturePath!, 16384)).toString('utf8')) as {
      installation: InstallationConfiguration;
    };
    const installation = createRuntimeInstallation(fixture.installation);
    const status = await installation.inspectExisting();
    if (status.state !== 'installed-files' || status.lastFreshVerifiedVersion !== '153.0.8010.12')
      throw new Error('FIXTURE_OWN_INSTALLATION_REQUIRED');
    const require = createRequire(import.meta.url);
    const packageRoot = await realpath(dirname(dirname(require.resolve('@dorkos/browser'))));
    const browserRequire = createRequire(join(packageRoot, 'package.json'));
    const libraryRoot = await realpath(
      dirname(browserRequire.resolve('playwright-core/package.json'))
    );
    if (libraryRoot !== (await realpath(fixture.installation.libraryRoot)))
      throw new Error('FIXTURE_OWN_LIBRARY_REQUIRED');
    const helper = join(packageRoot, 'dist/runtime/native/darwin-process-observer');
    const helperSHA256 = createHash('sha256')
      .update(await smallFile(helper, 4 * 1024 * 1024))
      .digest('hex');
    const worker = join(packageRoot, 'dist/runtime/darwin-supervisor-worker.js');
    const journalWorker = join(packageRoot, 'dist/runtime/darwin-journal-worker.js');
    const executable = join(
      fixture.installation.cacheRoot,
      'candidates',
      status.installationId,
      'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    );
    if (![helper, worker, journalWorker, executable].every(isAbsolute))
      throw new Error('FIXTURE_OWN_PATH_REQUIRED');
    const home = await realpath(await mkdtemp(join(tmpdir(), 'browser-input-acceptance-')));
    let closureProven = false;
    cleanups.push(async () => {
      if (
        closureProven &&
        !fixtureCleanupFailed &&
        retainedFixtureControllers.size === 0 &&
        retainedFixtureReaders.size === 0 &&
        retainedFixtureListeners.size === 0
      )
        await rm(home, { recursive: true, force: true });
    });
    const db = createDb(join(home, 'fixture.db'));
    cleanups.push(async () => {
      db.$client.close();
    });
    runMigrations(db);
    initConfigManager(home);
    configManager.set('auth', { enabled: true });
    const auth = createAuth(db, home);
    const signup = await auth.api.signUpEmail({
      body: {
        name: 'Fixture owner',
        email: 'owner' + '@' + 'dork.test',
        password: 'fixture-only-not-personal',
      },
      asResponse: true,
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((field) => field.split(';')[0])
      .join('; ');
    db.insert(workspaces)
      .values({
        id: 'owned-fixture',
        projectKey: 'owned-fixture',
        key: 'owned',
        path: join(home, 'workspace'),
        source: home,
        provider: 'clone',
        status: 'ready',
        portBase: 6400,
        portBlockSize: 10,
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      })
      .run();
    type Event = {
      type: string;
      key: string;
      shift: boolean;
      buttons: number;
      value: string;
      trusted: boolean;
    };
    const events: Event[] = [];
    let originRequests = 0,
      originConnections = 0,
      leaks = 0;
    const origin = createServer((incoming, response) => {
      originRequests++;
      if (incoming.headers['proxy-authorization'] || incoming.headers.authorization) leaks++;
      if (incoming.url?.startsWith('/event?')) {
        const encoded = new URL(incoming.url, 'http://fixture.test').searchParams.get('data');
        events.push(JSON.parse(encoded!) as Event);
        response.end('observed');
        return;
      }
      response.setHeader('cache-control', 'no-store');
      response.end(`<title>Owned input acceptance</title><link rel="icon" href="data:,"><input autofocus style="position:fixed;left:20px;top:20px;width:400px;height:100px"><script>
        const input=document.querySelector('input');
        for(const type of ['keydown','keyup','mousedown','mouseup','mousemove','input','compositionstart','compositionend']) {
          input.addEventListener(type,e=>{
            fetch('/event?data='+encodeURIComponent(JSON.stringify({type,key:e.key||'',shift:e.shiftKey||false,buttons:e.buttons||0,value:input.value,trusted:e.isTrusted})),{cache:'no-store'});
            if(type==='keydown' && e.key==='Enter') {const end=performance.now()+2600;while(performance.now()<end){}}
          });
        }
      </script>`);
    });
    cleanups.push(() => closeServer(origin));
    origin.on('connection', () => originConnections++);
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const inventory = createServerInventory({
      instances: [{ id: 'server', listeners: ['http'] }],
      adminAuthorities: [],
      now: () => Math.floor(performance.now()),
    });
    const adminServer = inventory.acquire(
      'server',
      'http',
      () => createServer((_request, response) => response.end('private server')),
      (original) => original.listen(0, '127.0.0.1')
    );
    cleanups.push(() => closeServer(adminServer));
    await once(adminServer, 'listening');
    const composition = createInputAcceptanceComposition({
      scope: 'private-fixture',
      db,
      auth,
      config: configManager,
      inventory,
      now: () => Math.floor(performance.now()),
      resolver: async () => {
        throw new Error('FIXTURE_NO_DNS');
      },
      engineConfiguration: {
        dataDir: join(home, 'browser'),
        runtime: {
          library: {
            package: 'playwright-core',
            version: '1.63.0',
            rootDir: libraryRoot,
            assets: { manifest: 'browsers.json', cli: 'cli.js' },
          },
          executable: {
            path: executable,
            sha256: status.executableSHA256,
            revision: '1243',
            version: '153.0.8010.12',
            platform: 'darwin',
            arch: 'arm64',
          },
          identity: { mode: 'native', policyRevision: 1 },
        },
        network: { kind: 'owned', origin: 'about:blank', policyRevision: 1 },
        clock: { monotonicNow: () => performance.now(), wallNow: () => Date.now() },
        processes: {
          observe: async () => ({ status: 'unknown' }),
          descendants: async () => ({ status: 'unknown', identities: [] }),
        },
        policy: {
          authorizeAction: async () => 'refused',
          verifyBrokerLease: async () => 'unknown',
        },
        nativeJournal: {
          workerPath: journalWorker,
          browserWorkerPath: worker,
          artifact: { path: helper, sha256: helperSHA256 },
          duration: 30000,
          maxGap: 5000,
        },
      },
    });
    let opened: Awaited<ReturnType<typeof composition.open>> | undefined;
    let shutdownAttempted = false;
    let nativeOriginals: unknown;
    let fixtureControllerCleanup: (() => Promise<void>) | undefined;
    let primaryFailed = false;
    let primary: unknown;
    let failed = false;
    let first: unknown;
    try {
      const grant = await composition.authorizeWorkspace(
        { cookie },
        'owned-fixture',
        new AbortController().signal
      );
      opened = await composition.open(grant, {
        kind: 'open',
        mode: 'ephemeral',
        requestId: randomBytes(16).toString('base64url'),
      });
      expect(originRequests).toBe(0); // Launch/ready has no uncontrolled navigation.
      opened.grantFixtureOrigin(origin);
      expect(opened.checkProtectedOwnersDenied()).toBe(true);
      expect(
        await opened.navigateFixtureOrigin(origin, randomBytes(16).toString('base64url'))
      ).toMatchObject({ kind: 'action', outcome: 'completed' });
      expect(originRequests).toBeGreaterThan(0);
      expect(leaks).toBe(0);
      const binding = opened.engine.listTabs(
        opened.opened.browserId,
        opened.opened.browserGeneration
      )[0]!;
      expect(
        (
          await opened.engine.capture({
            kind: 'capture',
            requestId: randomBytes(16).toString('base64url'),
            binding,
          })
        ).bytes.length
      ).toBeGreaterThan(0);
      const command = (steps: unknown[], exact: unknown = binding) => ({
        kind: 'input',
        requestId: randomBytes(16).toString('base64url'),
        binding: exact,
        steps,
      });
      const observed = async (predicate: (event: Event) => boolean) => {
        await expect.poll(() => events.some(predicate), { timeout: 3000 }).toBe(true);
      };
      const completed = async (steps: unknown[]) => {
        expect(await opened!.engine.input(command(steps))).toMatchObject({ outcome: 'completed' });
      };
      for (const stale of [
        { ...binding, tabId: randomBytes(16).toString('base64url') },
        { ...binding, navigationGeneration: binding.navigationGeneration + 1 },
        { ...binding, viewportVersion: binding.viewportVersion + 1 },
      ]) {
        expect(
          await opened.engine.input(command([{ kind: 'text', text: 'STALE' }], stale))
        ).toMatchObject({ outcome: 'rejected' });
      }
      await completed([
        { kind: 'click', x: 100, y: 60, button: 'left' },
        { kind: 'text', text: 'A' },
      ]);
      await observed((event) => event.type === 'input' && event.value === 'A');
      await completed([
        // Place the real pointer beyond the existing text before Shift+down; this
        // preserves an empty end selection when Chromium starts composition.
        { kind: 'mouseMove', x: 400, y: 60 },
        { kind: 'keyDown', key: 'Shift' },
        { kind: 'mouseDown', button: 'left' },
      ]);
      await observed((event) => event.type === 'mousedown' && event.shift && event.buttons === 1);
      // These are real owner authority checks. Reset arrives before the newly queued native entry;
      // no test policy promise manufactures authorization or native custody.
      // The sole target is the engine's canonical original page. This extra fixture-only
      // controller never supplies authorization or a cleanup capability to the engine.
      const library = browserRequire('playwright-core') as {
        chromium: {
          connectOverCDP(
            url: string,
            options: { timeout: number }
          ): Promise<{
            contexts(): Array<{
              pages(): Array<{
                url(): string;
                context(): {
                  newCDPSession(page: unknown): Promise<{
                    send(method: string, value: unknown): Promise<unknown>;
                    detach(): Promise<void>;
                  }>;
                };
              }>;
            }>;
            close(): Promise<void>;
          }>;
        };
      };
      const admin = opened.readFixtureAdminEndpoint();
      nativeOriginals = { root: admin.root, supervisor: admin.supervisor };
      const acquisition = { original: undefined as Promise<unknown> | undefined };
      retainedFixtureControllers.add(acquisition); // Before the real SDK enters acquisition.
      const controllerOriginal = library.chromium.connectOverCDP(admin.url, { timeout: 2000 });
      acquisition.original = controllerOriginal;
      const controller = await controllerOriginal;
      const originalController = {
        controller,
        cleanupBegan: false,
        detachOriginal: undefined as Promise<void> | undefined,
        controllerCloseOriginal: undefined as Promise<void> | undefined,
        compositionOriginal: undefined as Promise<unknown> | undefined,
        detachOperation: undefined as Promise<void> | undefined,
        sessionPending: false,
        sessionUncertain: false,
        sessionAcquisition: undefined as
          | Promise<{
              send(method: string, value: unknown): Promise<unknown>;
              detach(): Promise<void>;
            }>
          | undefined,
        session: undefined as
          | { send(method: string, value: unknown): Promise<unknown>; detach(): Promise<void> }
          | undefined,
      };
      retainedFixtureControllers.add(originalController);
      const detachSessionOnce = () => {
        if (originalController.detachOperation) return originalController.detachOperation;
        if (!originalController.session) return Promise.resolve();
        // Publish the same one-shot duty before entering the actual original detach.
        const session = originalController.session;
        originalController.detachOriginal = Promise.resolve().then(() => session.detach());
        originalController.detachOperation = boundedFixtureOperation(
          originalController.detachOriginal
        ).catch((error) => {
          originalController.sessionUncertain = true;
          fixtureCleanupFailed = true;
          throw error;
        });
        void originalController.detachOperation.catch(() => {});
        return originalController.detachOperation;
      };
      let controllerCleanup: Promise<void> | undefined;
      const closeController = () =>
        (controllerCleanup ??= (async () => {
          originalController.cleanupBegan = true;
          let failed = false,
            primary: unknown;
          if (originalController.sessionPending && originalController.sessionAcquisition) {
            try {
              await boundedFixtureOperation(originalController.sessionAcquisition);
            } catch (error) {
              failed = true;
              primary = error;
            }
          }
          if (originalController.session) {
            try {
              await detachSessionOnce();
            } catch (error) {
              if (!failed) primary = error;
              failed = true;
            }
          }
          try {
            originalController.controllerCloseOriginal ??= Promise.resolve().then(() =>
              originalController.controller.close()
            );
            await boundedFixtureOperation(originalController.controllerCloseOriginal);
          } catch (error) {
            if (!failed) primary = error;
            failed = true;
          }
          if (originalController.sessionPending || originalController.sessionUncertain) {
            if (!failed) primary = new Error('FIXTURE_SESSION_ACQUISITION_HELD');
            failed = true;
          }
          if (failed) {
            fixtureCleanupFailed = true;
            throw primary;
          }
          retainedFixtureControllers.delete(originalController);
          retainedFixtureControllers.delete(acquisition);
        })());
      fixtureControllerCleanup = closeController;
      cleanups.push(closeController);
      const contexts = controller.contexts();
      expect(contexts).toHaveLength(1);
      const pages = contexts[0]!.pages();
      expect(pages).toHaveLength(1);
      const page = pages[0]!;
      const address = origin.address();
      if (!address || typeof address === 'string') throw new Error('FIXTURE_ORIGIN_UNAVAILABLE');
      expect(new URL(page.url()).origin).toBe(`http://127.0.0.1:${address.port}`);
      expect(
        opened.engine.listTabs(opened.opened.browserId, opened.opened.browserGeneration)
      ).toEqual([binding]);
      expect(opened.readFixtureAdminEndpoint()).toEqual(admin);
      originalController.sessionPending = true; // Before the exact SDK attach enters.
      let compositionSession: NonNullable<typeof originalController.session>;
      try {
        const attachOriginal = page.context().newCDPSession(page);
        originalController.sessionAcquisition = attachOriginal;
        void attachOriginal.then(
          (session) => {
            originalController.session = session;
            originalController.sessionPending = false;
            if (originalController.cleanupBegan) void detachSessionOnce().catch(() => {});
          },
          () => {
            originalController.sessionPending = false;
            originalController.sessionUncertain = true;
          }
        );
        compositionSession = await boundedFixtureOperation(attachOriginal);
      } catch (error) {
        originalController.sessionUncertain = true;
        throw error;
      }
      expect(opened.readFixtureAdminEndpoint()).toEqual(admin);
      originalController.compositionOriginal = Promise.resolve().then(() =>
        compositionSession.send('Input.imeSetComposition', {
          text: 'pending',
          // Bind the real renderer replacement range to the end of the one
          // existing character; held Shift/mouse state must not select it.
          replacementStart: 1,
          replacementEnd: 1,
          selectionStart: 7,
          selectionEnd: 7,
        })
      );
      try {
        await boundedFixtureOperation(originalController.compositionOriginal);
      } catch (error) {
        originalController.sessionUncertain = true;
        throw error;
      }
      await observed((event) => event.type === 'compositionstart' && event.trusted);
      expect(
        opened.engine.listTabs(opened.opened.browserId, opened.opened.browserGeneration)
      ).toEqual([binding]);
      const active = opened.engine.input(command([{ kind: 'text', text: 'OLD' }]));
      const cancellation = new AbortController();
      const queuedRelease = opened.engine.input(
        command([
          { kind: 'keyUp', key: 'Shift' },
          { kind: 'mouseUp', button: 'left' },
        ]),
        cancellation.signal
      );
      cancellation.abort();
      const reset = await opened.engine.resetInput(binding);
      console.info(
        JSON.stringify({
          resetDiagnostic: {
            before: binding,
            reset,
            active: await active,
            queued: await queuedRelease,
            tabs: opened.engine.listTabs(opened.opened.browserId, opened.opened.browserGeneration),
          },
        })
      );
      expect((await queuedRelease).outcome).toBe('rejected');
      expect((await active).outcome).not.toBe('completed');
      expect(reset.status).toBe('ready');
      // Chromium's real CDP cancellation emits an untrusted renderer end event.
      // The actual native command, trusted start, end event and restored value
      // prove CDP-native cancellation; this does not prove physical OS IME.
      await observed((event) => event.type === 'compositionend' && event.value === 'A');
      await observed((event) => event.type === 'input' && event.value === 'A');
      await closeController();
      expect(reset.binding.inputGeneration).toBe(binding.inputGeneration + 1);
      expect(reset.binding.epoch).toBe(binding.epoch + 1);
      await observed((event) => event.type === 'keyup' && event.key === 'Shift' && !event.shift);
      await observed((event) => event.type === 'mouseup' && event.buttons === 0);
      expect(await opened.engine.input(command([{ kind: 'text', text: 'STALE' }]))).toMatchObject({
        outcome: 'rejected',
      });
      expect(
        await opened.engine.input(
          command(
            [
              { kind: 'keyDown', key: 'ArrowRight' },
              { kind: 'keyUp', key: 'ArrowRight' },
              { kind: 'mouseMove', x: 120, y: 60 },
              { kind: 'text', text: 'B' },
            ],
            reset.binding
          )
        )
      ).toMatchObject({ outcome: 'completed' });
      await observed((event) => event.type === 'input' && event.value === 'AB');
      await observed(
        (event) => event.type === 'keydown' && event.key === 'ArrowRight' && !event.shift
      );
      await observed((event) => event.type === 'mousemove' && !event.shift && event.buttons === 0);
      if (blockedFault) {
        // A real renderer handler blocks the original native acknowledgement beyond the fixed budget.
        const started = performance.now();
        const blocked = opened.engine.input(
          command([{ kind: 'keyDown', key: 'Enter' }], reset.binding)
        );
        const late = opened.engine.input(command([{ kind: 'text', text: 'LATE' }], reset.binding));
        expect(await blocked).toMatchObject({ outcome: 'uncertain', reason: 'deadline' });
        expect(performance.now() - started).toBeLessThan(2300);
        expect((await late).outcome).not.toBe('completed');
        await observed((event) => event.type === 'keydown' && event.key === 'Enter');
        expect(
          await opened.engine.input(command([{ kind: 'text', text: 'RESTORED' }], reset.binding))
        ).toMatchObject({ outcome: 'rejected' });
        expect(
          events.some(
            (event) =>
              event.value.includes('STALE') ||
              event.value.includes('OLD') ||
              event.value.includes('LATE') ||
              event.value.includes('RESTORED')
          )
        ).toBe(false);
      }
      expect(leaks).toBe(0);
      shutdownAttempted = true;
      const closed = await opened.close();
      expect(closed.length).toBeGreaterThan(0);
      console.info(JSON.stringify({ originalShutdown: closed, blockedFault }));
      expect(
        closed.every((result) => result.cleanup === (blockedFault ? 'unverified' : 'observed'))
      ).toBe(true);
      expect(
        closed.some(
          (result) =>
            result.browserId === opened!.opened.browserId &&
            result.browserGeneration === opened!.opened.browserGeneration &&
            result.cleanup === (blockedFault ? 'unverified' : 'observed')
        )
      ).toBe(true);
      // Started-effect uncertainty deliberately quarantines this original root.
      // Only the separate healthy generation proves positive cleanup/deletion.
      closureProven = !blockedFault;
    } catch (error) {
      primaryFailed = true;
      primary = error;
    } finally {
      if (fixtureControllerCleanup) {
        try {
          await fixtureControllerCleanup();
        } catch (error) {
          failed = true;
          first = error;
        }
      }
      try {
        composition.stopAdmission();
      } catch (error) {
        if (!failed) first = error;
        failed = true;
      }
      if (opened && !shutdownAttempted) {
        try {
          const closed = await opened.close();
          closureProven =
            closed.length > 0 &&
            closed.every((result) => result.cleanup === 'observed') &&
            closed.some(
              (result) =>
                result.browserId === opened!.opened.browserId &&
                result.browserGeneration === opened!.opened.browserGeneration &&
                result.cleanup === 'observed'
            );
        } catch (error) {
          if (!failed) first = error;
          failed = true;
        }
      }
    }
    if (failed) fixtureCleanupFailed = true;
    console.info(
      JSON.stringify({
        fixture: 'generation-bound-input-acceptance',
        browser: opened?.opened,
        scenario: blockedFault ? 'blocked-effect-uncertainty' : 'healthy-shutdown',
        nativeOriginals,
        retainedHome: !closureProven ? home : undefined,
        installationId: status.installationId,
        executableSHA256: status.executableSHA256,
        events,
        closureProven,
        heldFixtureControllers: retainedFixtureControllers.size,
        heldFixtureReaders: retainedFixtureReaders.size,
        heldFixtureListeners: retainedFixtureListeners.size,
        primaryFailed,
        cleanupFailed: failed,
      })
    );
    if (primaryFailed) throw primary;
    if (failed) throw first;
  },
  60000
);

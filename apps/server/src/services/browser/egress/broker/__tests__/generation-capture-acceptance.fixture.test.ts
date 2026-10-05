import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, rm, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserBinding } from '@dorkos/browser';
import type {
  BrowserRecord,
  TabRecord,
} from '../../../../../../../../packages/browser/src/lifecycle/records.js';
import type { BrowserCapture } from '../../../../../../../../packages/browser/src/tabs/capture.js';
import type { DiagnosticsOwner } from '../../../../../../../../packages/browser/src/tabs/diagnostics.js';
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
type FixtureController = {
  contexts(): Array<Pick<ReturnType<TabRecord['page']['context']>, 'pages' | 'on' | 'off'>>;
  close(): Promise<void>;
};
const fixturePath = process.env.DORKOS_BROWSER_CAPTURE_ACCEPTANCE_FIXTURE;
const cleanups: Array<() => Promise<void>> = [];
// Actual originals remain strongly held if a detach/connection-close rejects.
const retainedFixtureControllers = new Set<object>();
const retainedFixtureReaders = new Set<object>();
const retainedFixtureListeners = new Set<object>();
const retainedFixtureOperations = new Set<Promise<unknown>>();
let fixtureCleanupFailed = false;
async function boundedFixtureOperation<T>(original: Promise<T>): Promise<T> {
  // Timeout is uncertainty; retain the actual object/promise and never retry its close.
  retainedFixtureOperations.add(original);
  void original.then(
    () => retainedFixtureOperations.delete(original),
    () => retainedFixtureOperations.delete(original)
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      original,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          fixtureCleanupFailed = true;
          reject(new Error('FIXTURE_ORIGINAL_OPERATION_HELD'));
        }, 2000);
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
      heldOperations: retainedFixtureOperations.size,
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
it.skipIf(!fixturePath || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual original capture observes caret pixels, pointer races, telemetry bounds and delayed popup bytes',
  async () => {
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
    const home = await realpath(await mkdtemp(join(tmpdir(), 'browser-capture-acceptance-')));
    let closureProven = false;
    cleanups.push(async () => {
      if (
        closureProven &&
        !fixtureCleanupFailed &&
        retainedFixtureControllers.size === 0 &&
        retainedFixtureReaders.size === 0 &&
        retainedFixtureListeners.size === 0 &&
        retainedFixtureOperations.size === 0
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
    let originRequests = 0,
      leaks = 0;
    const origin = createServer((incoming, response) => {
      originRequests++;
      if (incoming.headers['proxy-authorization'] || incoming.headers.authorization) leaks++;
      response.setHeader('cache-control', 'no-store');
      if (incoming.url?.startsWith('/telemetry')) {
        response.setHeader('X-Fixture-Secret', 'HEADER_SECRET_NEVER_PROJECTED');
        response.end('BODY_SECRET_NEVER_PROJECTED');
        return;
      }
      if (incoming.url === '/popup') {
        response.end(
          '<title>Original popup</title><link rel="icon" href="data:,"><style>html,body{margin:0;background:rgb(0,0,255)}</style>'
        );
        return;
      }
      response.end(`<title>Original capture acceptance</title><link rel="icon" href="data:,"><style>
        html,body{margin:0;background:rgb(255,0,0)}
        input{position:fixed;left:32px;top:32px;width:200px;height:96px;box-sizing:border-box;border:0;padding:16px;background:black;color:white;caret-color:white;font:64px monospace;outline:none}
        button{position:fixed;width:140px;height:48px}
      </style><input aria-label="Native caret"><button id="network" style="left:260px;top:140px">Telemetry</button>
      <button id="overflow" style="left:430px;top:140px">Overflow</button><button id="popup" style="left:260px;top:210px">Popup</button><script>
        network.onclick=()=>{console.info('CONSOLE_SECRET_NEVER_PROJECTED');fetch('/telemetry?URL_SECRET_NEVER_PROJECTED').then(response=>response.text()).then(()=>setTimeout(()=>{throw Error('ERROR_SECRET_NEVER_PROJECTED')},0))};
        overflow.onclick=()=>{for(let i=0;i<300;i++)console.info('OVERFLOW_SECRET_NEVER_PROJECTED');setTimeout(()=>{throw Error('OVERFLOW_ERROR_SECRET_NEVER_PROJECTED')},0)};
        popup.onclick=()=>{const original=window.open('','original-popup');setTimeout(()=>{original.location='/popup'},300)};
      </script>`);
    });
    cleanups.push(() => closeServer(origin));
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
    // Forward the real private producer; observation supplies no qualification or authority.
    const registryModule = (await import(join(packageRoot, 'dist/tabs/registry.js'))) as {
      trackPage: (...args: unknown[]) => TabRecord;
    };
    const originalTrack = registryModule.trackPage;
    const tracked: TabRecord[] = [];
    const originalRecords = new Map<TabRecord, BrowserRecord>();
    const track = vi.spyOn(registryModule, 'trackPage').mockImplementation((...args) => {
      const tab = Reflect.apply(originalTrack, registryModule, args) as TabRecord;
      if (!tracked.includes(tab)) tracked.push(tab);
      originalRecords.set(tab, args[0] as BrowserRecord);
      return tab;
    });
    cleanups.push(async () => {
      track.mockRestore();
    });
    let opened: Awaited<ReturnType<typeof composition.open>> | undefined;
    let engineClose: Promise<Awaited<ReturnType<NonNullable<typeof opened>['close']>>> | undefined;
    const closeEngine = async () => {
      let failed = false,
        first: unknown;
      try {
        composition.stopAdmission();
      } catch (error) {
        failed = true;
        first = error;
        fixtureCleanupFailed = true;
      }
      // Admission cleanup cannot skip the actual original engine shutdown duty.
      try {
        if (opened) {
          engineClose ??= opened.close();
          const closed = await boundedFixtureOperation(engineClose);
          closureProven =
            closed.length > 0 &&
            closed.every((result) => result.cleanup === 'observed') &&
            closed.some(
              (result) =>
                result.browserId === opened!.opened.browserId &&
                result.browserGeneration === opened!.opened.browserGeneration
            );
          if (!closureProven) throw new Error('FIXTURE_ENGINE_CLOSURE_UNKNOWN');
        }
      } catch (error) {
        if (!failed) first = error;
        failed = true;
        fixtureCleanupFailed = true;
      }
      if (failed) throw first;
    };
    cleanups.push(closeEngine);
    let primaryFailed = false,
      primary: unknown;
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
      expect(originRequests).toBe(0);
      opened.grantFixtureOrigin(origin, 30000);
      expect(opened.checkProtectedOwnersDenied()).toBe(true);
      await opened.navigateFixtureOrigin(origin, randomBytes(16).toString('base64url'));
      let binding = opened.engine.listTabs(
        opened.opened.browserId,
        opened.opened.browserGeneration
      )[0]!;
      expect(tracked).toHaveLength(1);
      const original = tracked[0]!;
      const record = originalRecords.get(original)!;
      expect(original.binding).toEqual(binding);
      const capture = (exact: BrowserBinding = binding) =>
        opened!.engine.capture({
          kind: 'capture',
          requestId: randomBytes(16).toString('base64url'),
          binding: exact,
        });
      const input = (steps: unknown[], exact: BrowserBinding = binding) =>
        opened!.engine.input({
          kind: 'input',
          requestId: randomBytes(16).toString('base64url'),
          binding: exact,
          steps,
        });
      const completed = async (steps: unknown[]) =>
        expect(await input(steps)).toMatchObject({ outcome: 'completed' });
      const reset = async () => {
        const result = await opened!.engine.resetInput(binding);
        expect(result.status).toBe('ready');
        binding = result.binding;
        expect(original.binding).toEqual(binding);
      };
      // Exact private fixture endpoint, solely the original engine Page; controller reads only pixels.
      const library = browserRequire('playwright-core') as {
        chromium: {
          connectOverCDP(url: string, options: { timeout: number }): Promise<FixtureController>;
        };
      };
      const admin = opened.readFixtureAdminEndpoint();
      const slot = {
        acquisition: undefined as Promise<FixtureController> | undefined,
        controller: undefined as FixtureController | undefined,
        close: undefined as Promise<void> | undefined,
        reads: new Set<Promise<unknown>>(),
        uncertain: false,
        cleanupBegan: false,
      };
      retainedFixtureControllers.add(slot); // Before SDK entry and any returned asynchronous duty.
      const closeOriginalController = () => {
        if (!slot.controller) return Promise.resolve();
        const original = slot.controller;
        slot.close ??= Promise.resolve().then(() => original.close());
        void slot.close.catch(() => {
          slot.uncertain = true;
          fixtureCleanupFailed = true;
        });
        return slot.close;
      };
      let controllerCleanup: Promise<void> | undefined;
      const closeController = () =>
        (controllerCleanup ??= (async () => {
          slot.cleanupBegan = true;
          let failed = false,
            first: unknown;
          const attempt = async (original: Promise<unknown>) => {
            try {
              await boundedFixtureOperation(original);
            } catch (error) {
              if (!failed) first = error;
              failed = true;
              slot.uncertain = true;
              fixtureCleanupFailed = true;
            }
          };
          if (slot.acquisition) await attempt(slot.acquisition);
          await attempt(Promise.all([...slot.reads]));
          await attempt(closeOriginalController());
          if (slot.uncertain || slot.reads.size) {
            if (!failed) first = new Error('FIXTURE_CONTROLLER_UNKNOWN');
            failed = true;
          }
          if (failed) throw first;
          retainedFixtureControllers.delete(slot);
        })());
      cleanups.push(closeController);
      const acquisition = library.chromium.connectOverCDP(admin.url, { timeout: 2000 });
      slot.acquisition = acquisition;
      void acquisition.then(
        (controller) => {
          slot.controller = controller;
          if (slot.cleanupBegan) void closeOriginalController().catch(() => {});
        },
        () => {
          slot.uncertain = true;
        }
      );
      const controller = await boundedFixtureOperation(acquisition);
      expect(controller.contexts()).toHaveLength(1);
      const context = controller.contexts()[0]!;
      expect(context.pages()).toHaveLength(1);
      const page = context.pages()[0]!;
      expect(page.url()).toBe(original.page.url());
      expect(opened.readFixtureAdminEndpoint()).toEqual(admin);
      // OffscreenCanvas decodes actual captured JPEG bytes, with no DOM writes or synthetic caret.
      const pixels = async (frame: BrowserCapture) => {
        if (frame.bytes.length > 2 * 1024 * 1024) throw new Error('FIXTURE_PIXEL_INPUT_CAP');
        const data = Buffer.from(frame.bytes).toString('base64');
        const pending = page.evaluate(
          async ({ data }) => {
            const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
            try {
              if (bitmap.width !== 1280 || bitmap.height !== 720)
                throw Error('FIXTURE_RASTER_GEOMETRY');
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const ctx = canvas.getContext('2d');
              if (!ctx) throw Error('FIXTURE_DECODER_UNAVAILABLE');
              ctx.drawImage(bitmap, 0, 0);
              const roi = ctx.getImageData(47, 45, 8, 72).data;
              let bright = 0;
              for (let i = 0; i < roi.length; i += 4)
                if (roi[i]! > 140 && roi[i + 1]! > 140 && roi[i + 2]! > 140) bright++;
              return { bright, center: [...ctx.getImageData(640, 360, 1, 1).data] };
            } finally {
              bitmap.close();
            }
          },
          { data }
        );
        slot.reads.add(pending);
        void pending.then(
          () => slot.reads.delete(pending),
          () => {
            slot.uncertain = true;
            slot.reads.delete(pending);
          }
        );
        return boundedFixtureOperation(pending);
      };
      await completed([{ kind: 'click', x: 100, y: 80, button: 'left' }]);
      const caretSamples: number[] = [];
      const caretEnd = performance.now() + 2400;
      for (let count = 0; count < 16 && performance.now() < caretEnd; count++) {
        const frame = await capture();
        expect(frame.receipt.binding).toEqual(binding);
        caretSamples.push((await pixels(frame)).bright);
        if (caretSamples.some((value) => value > 20) && caretSamples.some((value) => value === 0))
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(caretSamples.some((value) => value > 20)).toBe(true);
      expect(caretSamples.some((value) => value === 0)).toBe(true);
      await completed([{ kind: 'click', x: 800, y: 500, button: 'left' }]);
      expect((await pixels(await capture())).bright).toBe(0);
      await completed([{ kind: 'mouseMove', x: 120, y: 90 }]);
      expect((await capture()).receipt.pointer).toMatchObject({ x: 120, y: 90 });
      await completed([{ kind: 'click', x: 140, y: 90, button: 'left' }]);
      expect((await capture()).receipt.pointer).toMatchObject({ x: 140, y: 90 });
      // Hold only publication of the real original native JPEG; move via the real owner while held.
      const screenshot = original.page.screenshot.bind(original.page);
      let captured!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => (captured = resolve));
      const held = new Promise<void>((resolve) => (release = resolve));
      const screenshotSpy = vi
        .spyOn(original.page, 'screenshot')
        .mockImplementation(async (options) => {
          const bytes = await screenshot(options);
          captured();
          await held;
          return bytes;
        });
      let raced: Awaited<ReturnType<typeof capture>> | undefined;
      let raceFailed = false,
        raceFailure: unknown;
      let pendingCapture: ReturnType<typeof capture> | undefined;
      try {
        const pending = (pendingCapture = capture());
        void pending.catch(() => {});
        await boundedFixtureOperation(entered);
        await completed([{ kind: 'mouseMove', x: 160, y: 110 }]);
        release();
        raced = await boundedFixtureOperation(pending);
      } catch (error) {
        raceFailed = true;
        raceFailure = error;
      } finally {
        const raceCleanupFailure = (error: unknown) => {
          if (!raceFailed) raceFailure = error;
          raceFailed = true;
          fixtureCleanupFailed = true;
        };
        try {
          release();
        } catch (error) {
          raceCleanupFailure(error);
        }
        try {
          screenshotSpy.mockRestore();
        } catch (error) {
          raceCleanupFailure(error);
        }
        if (pendingCapture) {
          try {
            await boundedFixtureOperation(pendingCapture);
          } catch (error) {
            raceCleanupFailure(error);
          }
        }
      }
      if (raceFailed) throw raceFailure;
      expect(raced!.receipt.pointer).toBe(null);
      expect((await capture()).receipt.pointer).toMatchObject({ x: 160, y: 110 });
      const stale = { ...binding };
      await reset();
      expect((await capture()).receipt.pointer).toBe(null);
      await expect(capture(stale)).rejects.toMatchObject({ code: 'STALE_BINDING' });
      const summary = (): NonNullable<ReturnType<DiagnosticsOwner['read']>> => {
        const value = original.diagnostics.read();
        if (!value) throw new Error('FIXTURE_DIAGNOSTICS_UNAVAILABLE');
        expect(value.binding).toEqual(binding);
        return value;
      };
      expect(summary().entries).toEqual([]);
      await completed([{ kind: 'click', x: 320, y: 164, button: 'left' }]);
      try {
        await expect.poll(() => summary().entries.length, { timeout: 2000 }).toBe(5);
      } catch (error) {
        console.info(JSON.stringify({ fixtureTelemetry: summary() }));
        throw error;
      }
      const healthy = summary();
      expect(healthy.entries.map((entry) => entry.category).sort()).toEqual([
        'console',
        'error',
        'network',
        'network',
        'network',
      ]);
      expect(
        healthy.entries.filter((entry) => entry.category === 'network').map((entry) => entry.status)
      ).toEqual([undefined, 'success', 'success']);
      expect(healthy.counts).toEqual({
        dropped: 0,
        truncated: 1,
        correlationDropped: 0,
        unmatchedCallbacks: 0,
      });
      expect(healthy.lastAccountedSequence).toBe(5);
      expect(healthy.terminal).toBe('none');
      expect(record.diagnosticsBudget.snapshot()).toMatchObject({
        owners: 1,
        entries: 5,
        correlations: 0,
        correlationBytes: 0,
      });
      await reset();
      await completed([{ kind: 'click', x: 500, y: 164, button: 'left' }]);
      await expect.poll(() => summary().counts.dropped, { timeout: 2000 }).toBe(45);
      const overflow = summary();
      expect(overflow.entries).toHaveLength(256);
      expect(
        overflow.entries.every((entry) => entry.category === 'console' && entry.severity === 'info')
      ).toBe(true);
      expect(overflow.counts).toEqual({
        dropped: 45,
        truncated: 0,
        correlationDropped: 0,
        unmatchedCallbacks: 0,
      });
      expect(overflow.lastAccountedSequence).toBe(256);
      expect(overflow.subsequentEventsUncounted).toBe(false);
      expect(overflow.terminal).toBe('none');
      const usage = record.diagnosticsBudget.snapshot();
      expect(usage).toMatchObject({
        owners: 1,
        entries: 256,
        correlations: 0,
        correlationBytes: 0,
      });
      expect(usage.bytes).toBeGreaterThan(0);
      expect(usage.bytes).toBeLessThanOrEqual(256 * 1024);
      for (const value of [healthy, overflow])
        expect(JSON.stringify(value)).not.toMatch(/SECRET|telemetry|127\.0\.0\.1|fixture\.test/);
      await reset();
      let blankPage: TabRecord['page'] | undefined;
      const onPage = (candidate: TabRecord['page']) => {
        blankPage = candidate;
      };
      context.on('page', onPage);
      const originalContext = original.page.context();
      const createSession = originalContext.newCDPSession.bind(originalContext);
      let observedAcquisition!: () => void, releaseAcquisition!: () => void;
      const acquisitionEntered = new Promise<void>((resolve) => (observedAcquisition = resolve));
      const acquisitionHeld = new Promise<void>((resolve) => (releaseAcquisition = resolve));
      const popupAcquisitions: Array<
        Promise<ReturnType<typeof createSession> extends Promise<infer T> ? T : never>
      > = [];
      const sessionSpy = vi.spyOn(originalContext, 'newCDPSession').mockImplementation((target) => {
        const native = createSession(target);
        if (target === original.page) return native;
        observedAcquisition();
        const pending = native.then(async (session) => {
          await acquisitionHeld;
          return session;
        });
        popupAcquisitions.push(pending);
        void pending.catch(() => {});
        return pending;
      });
      let popupFailed = false,
        popupFirst: unknown;
      try {
        await completed([{ kind: 'click', x: 320, y: 234, button: 'left' }]);
        await expect
          .poll(
            () =>
              opened!.engine.listTabs(opened!.opened.browserId, opened!.opened.browserGeneration)
                .length,
            { timeout: 1500 }
          )
          .toBe(2);
        await boundedFixtureOperation(acquisitionEntered);
        await expect.poll(() => tracked.length, { timeout: 1500 }).toBe(2);
        const popup = tracked[1]!;
        const blank = { ...popup.binding };
        expect(blankPage).toBeDefined();
        expect(await blankPage!.opener()).toBe(page);
        expect(blankPage!.context()).toBe(context);
        expect(blankPage!.url()).toBe('about:blank');
        await expect(capture(blank)).rejects.toMatchObject({ code: 'STALE_BINDING' });
        expect((await input([{ kind: 'mouseMove', x: 50, y: 50 }], blank)).outcome).toBe(
          'rejected'
        );
        // Real canonical receiver/broker probe while the original popup session is still held.
        // Baseline currently refuses this interval: the private pending-custody fix is prerequisite.
        expect(opened.readFixtureAdminEndpoint()).toEqual(admin);
        releaseAcquisition();
        await boundedFixtureOperation(Promise.all(popupAcquisitions));
        await expect
          .poll(
            () => {
              try {
                return opened!.engine
                  .listTabs(opened!.opened.browserId, opened!.opened.browserGeneration)
                  .find((tab) => tab.tabId === blank.tabId)?.navigationGeneration;
              } catch (cause) {
                console.info(
                  JSON.stringify({
                    fixturePopup: {
                      status: record.status,
                      firstCause: record.lifetime.ordinary.retirement.firstCause,
                      stopped: record.lifetime.gate.stopped,
                      tabs: [...record.tabs.values()].map((tab) => {
                        const slot = record.lifetime.inputs.get(tab);
                        return {
                          binding: tab.binding,
                          stopped: tab.stopped,
                          ready: slot?.ready,
                          uncertain: slot?.uncertain,
                          constructing: slot?.constructing,
                        };
                      }),
                    },
                  })
                );
                throw new Error('FIXTURE_ORIGINAL_POPUP_LIST_REFUSED', { cause });
              }
            },
            { timeout: 1500 }
          )
          .toBe(blank.navigationGeneration + 1);
        const committed = opened!.engine
          .listTabs(opened!.opened.browserId, opened!.opened.browserGeneration)
          .find((tab) => tab.tabId === blank.tabId)!;
        expect(committed.tabId).toBe(blank.tabId);
        expect((await input([{ kind: 'mouseMove', x: 50, y: 50 }], blank)).outcome).toBe(
          'rejected'
        );
        const popupViewport = popup.page.viewportSize();
        const popupMove = await input([{ kind: 'mouseMove', x: 50, y: 50 }], committed);
        if (popupMove.outcome !== 'completed')
          console.info(
            JSON.stringify({ fixturePopupInput: { viewport: popupViewport, result: popupMove } })
          );
        expect(popupMove.outcome).toBe('completed');
        const main = await capture(),
          other = await capture(committed);
        expect(main.receipt.binding).toEqual(binding);
        expect(other.receipt.binding).toEqual(committed);
        const red = (await pixels(main)).center,
          blue = (await pixels(other)).center;
        expect(red[0]).toBeGreaterThan(180);
        expect(red[2]).toBeLessThan(60);
        expect(blue[2]).toBeGreaterThan(180);
        expect(blue[0]).toBeLessThan(60);
        // Same existing wrong-Page oracle: forged expected metadata cannot hide actual blue bytes.
        const wrong = await pixels({ receipt: main.receipt, bytes: other.bytes });
        expect(wrong.center[0]).toBeLessThan(60);
        expect(wrong.center[2]).toBeGreaterThan(180);
        expect(opened.readFixtureAdminEndpoint()).toEqual(admin);
      } catch (error) {
        popupFailed = true;
        popupFirst = error;
      } finally {
        // Attempt every original duty independently; even a thrown undefined remains primary.
        const attempt = async (duty: () => void | Promise<unknown>) => {
          try {
            await duty();
          } catch (error) {
            if (!popupFailed) popupFirst = error;
            popupFailed = true;
            fixtureCleanupFailed = true;
          }
        };
        await attempt(() => releaseAcquisition());
        await attempt(() => {
          sessionSpy.mockRestore();
        });
        await attempt(() => {
          context.off('page', onPage);
        });
        // Returned sessions belong to the original engine input producer; it owns detach/close.
        await attempt(() => boundedFixtureOperation(Promise.all(popupAcquisitions)));
      }
      if (popupFailed) throw popupFirst;
      expect(leaks).toBe(0);
      await closeController();
      await closeEngine();
      expect(record.diagnosticsBudget.snapshot()).toEqual({
        owners: 0,
        entries: 0,
        bytes: 0,
        correlations: 0,
        correlationBytes: 0,
      });
      console.info(
        JSON.stringify({
          fixture: 'generation-capture-acceptance',
          caretSamples,
          healthy,
          overflow,
          closureProven,
          heldControllers: retainedFixtureControllers.size,
        })
      );
    } catch (error) {
      primaryFailed = true;
      primary = error;
    }
    if (primaryFailed) throw primary;
  },
  60000
);

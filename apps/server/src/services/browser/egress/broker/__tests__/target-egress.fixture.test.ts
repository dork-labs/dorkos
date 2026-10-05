import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { realpath, open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import {
  createTargetOrigin,
  ownTargetOperations,
  assertTargetReport,
  ownTargetHome,
  finishTargetReceipt,
  isTargetAuthorityRefusal,
} from './target-egress-fixture.js';
import {
  createRuntimeInstallation,
  type InstallationConfiguration,
} from '@dorkos/browser/runtime-installation';
import { createDb, runMigrations, workspaces } from '@dorkos/db';
import { createAuth } from '../../../../core/auth/index.js';
import { initConfigManager, configManager } from '../../../../core/config-manager.js';
import { createServerInventory } from '../server-inventory.js';
import { createPrivateLiveBrowserComposition } from '../live/private-composition.js';
// Explicit fixture-owned installation input. No default-suite browser, download or personal profile.
const fixturePath = process.env.DORKOS_BROWSER_TARGET_EGRESS_FIXTURE;
const cleanups: Array<() => Promise<void>> = [];
const retainedGenerations = new Set<object>();
const retainedReads = new Set<Awaited<ReturnType<typeof open>>>();
let readUncertain = false;
let cleanupFailed = false;
let diagnosticReceipt: (() => object) | undefined;
afterEach(async () => {
  let failed = false;
  let first: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
      cleanupFailed = true;
    }
  }
  finishTargetReceipt({ present: failed, value: first }, diagnosticReceipt);
});
const closeServer = async (original: ReturnType<typeof createServer>) => {
  original.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    original.close((error) => (error ? reject(error) : resolve()))
  );
};
async function smallFile(path: string, cap: number): Promise<Buffer> {
  if (readUncertain) throw Error('TARGET_READER_UNCERTAIN');
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.size > BigInt(cap)) throw new Error('FIXTURE_INPUT_INVALID');
  const original = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  retainedReads.add(original);
  let primaryFailed = false;
  let primary: unknown;
  let result: Buffer | undefined;
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
    primaryFailed = true;
    primary = error;
  }
  try {
    await original.close();
    retainedReads.delete(original);
  } catch (error) {
    readUncertain = true;
    if (!primaryFailed) {
      primaryFailed = true;
      primary = error;
    }
  }
  if (primaryFailed) throw primary;
  return result!;
}
it.skipIf(!fixturePath || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual owned broker carries resources, workers, cache and WS then revocation prevents further traffic',
  async () => {
    const duties = ownTargetOperations();
    let fixtureCleanupFailed = false;
    cleanups.push(async () => {
      if (!duties.finish().observed) throw Error('TARGET_ORIGINALS_HELD');
    });
    const call = <T>(invoke: () => Promise<T>, milliseconds = 5000) =>
      duties.run(invoke, milliseconds);
    let stage = 'fixture-input';
    let preflightFailed = false;
    const preflight: Array<
      Readonly<{ stage: string; elapsedMilliseconds: number; classified: 'returned' | 'failed' }>
    > = [];
    const preflightCall = async <T>(
      name: 'fixture-input' | 'installed-files',
      invoke: () => Promise<T>,
      milliseconds: number
    ): Promise<T> => {
      stage = name;
      const start = performance.now();
      try {
        const value = await call(invoke, milliseconds);
        preflight.push(
          Object.freeze({
            stage: name,
            elapsedMilliseconds: Math.round(performance.now() - start),
            classified: 'returned',
          })
        );
        return value;
      } catch (error) {
        preflightFailed = true;
        preflight.push(
          Object.freeze({
            stage: name,
            elapsedMilliseconds: Math.round(performance.now() - start),
            classified: 'failed',
          })
        );
        throw error;
      }
    };
    // Exists before any original file acquisition; records classification, never cancellation/return proof.
    diagnosticReceipt = () => ({
      stage,
      preflightClassificationFailed: preflightFailed,
      preflight,
      duties: duties.snapshot(),
      cleanupFailed,
    });
    const fixture = JSON.parse(
      (await preflightCall('fixture-input', () => smallFile(fixturePath!, 16384), 5000)).toString(
        'utf8'
      )
    ) as {
      installation: InstallationConfiguration;
    };
    const installation = createRuntimeInstallation(fixture.installation);
    // Full immutable files inspection measured 9.7s; its separate 20-second allowance changes no engine/network/cleanup deadline.
    const status = await preflightCall(
      'installed-files',
      () => installation.inspectExisting(),
      20000
    );
    stage = 'own-library';
    if (status.state !== 'installed-files' || status.lastFreshVerifiedVersion !== '153.0.8010.12')
      throw new Error('FIXTURE_OWN_INSTALLATION_REQUIRED');
    const require = createRequire(import.meta.url);
    const packageRoot = await call(() =>
      realpath(dirname(dirname(require.resolve('@dorkos/browser'))))
    );
    const browserRequire = createRequire(join(packageRoot, 'package.json'));
    const libraryRoot = await call(() =>
      realpath(dirname(browserRequire.resolve('playwright-core/package.json')))
    );
    if (libraryRoot !== (await call(() => realpath(fixture.installation.libraryRoot))))
      throw new Error('FIXTURE_OWN_LIBRARY_REQUIRED');
    const helper = join(packageRoot, 'dist/runtime/native/darwin-process-observer');
    const helperSHA256 = createHash('sha256')
      .update(await call(() => smallFile(helper, 4 * 1024 * 1024)))
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
    const homeOwner = ownTargetHome(join(tmpdir(), 'browser-target-egress-'));
    let closureProven = false;
    cleanups.push(async () => {
      const observed =
        closureProven &&
        !cleanupFailed &&
        !fixtureCleanupFailed &&
        !readUncertain &&
        retainedReads.size === 0 &&
        duties.snapshot().observed;
      if (await call(() => homeOwner.removeIfObserved(observed)))
        retainedGenerations.delete(retainedGeneration);
    }); // Registered before even mkdtemp can acquire the original directory.
    stage = 'owned-home';
    const home = await call(homeOwner.acquire);
    const db = createDb(join(home, 'fixture.db'));
    cleanups.push(async () => {
      db.$client.close();
    });
    runMigrations(db);
    initConfigManager(home);
    configManager.set('auth', { enabled: true });
    const auth = createAuth(db, home);
    stage = 'owned-auth';
    const signup = await call(() =>
      auth.api.signUpEmail({
        body: {
          name: 'Fixture owner',
          email: 'owner' + '@' + 'dork.test',
          password: 'fixture-only-not-personal',
        },
        asResponse: true,
      })
    );
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
    const inventory = createServerInventory({
      instances: [{ id: 'server', listeners: ['http'] }],
      adminAuthorities: [],
      now: () => Math.floor(performance.now()),
    });
    let forbiddenRequests = 0,
      forbiddenConnections = 0;
    const forbidden = createServer((_request, response) => {
      forbiddenRequests++;
      response.end('FORBIDDEN');
    });
    cleanups.push(() => call(() => closeServer(forbidden)));
    forbidden.on('connection', () => forbiddenConnections++);
    await call(async () => {
      const ready = once(forbidden, 'listening');
      inventory.acquire(
        'server',
        'http',
        () => forbidden,
        (original) => original.listen(0, '127.0.0.1')
      );
      await ready;
    });
    const forbiddenAddress = forbidden.address();
    if (!forbiddenAddress || typeof forbiddenAddress === 'string')
      throw Error('TARGET_LISTENER_UNKNOWN');
    const originOwner = createTargetOrigin(`http://127.0.0.1:${forbiddenAddress.port}/denied`);
    const origin = originOwner.server;
    cleanups.push(() => call(originOwner.close));
    await call(async () => {
      const ready = once(origin, 'listening');
      origin.listen(0, '127.0.0.1');
      await ready;
    });
    const composition = createPrivateLiveBrowserComposition({
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
    let closeOriginal:
      Promise<Awaited<ReturnType<NonNullable<typeof opened>['close']>>> | undefined;
    let cleanupBegan = false;
    stage = 'open';
    let closeRows: Array<{ cleanup: string; reason?: string }> | null = null;
    const closeGeneration = () => {
      if (!opened) throw Error('TARGET_GENERATION_NOT_ACQUIRED');
      return (closeOriginal ??= Promise.resolve()
        .then(() => opened!.close())
        .then((rows) => {
          closeRows = rows.map((row) => ({
            cleanup: row.cleanup,
            ...('reason' in row ? { reason: row.reason } : {}),
          }));
          return rows;
        }));
    };
    // Retain the composition and its genuine late generation even if caller classification expires.
    const retainedGeneration = {
      composition,
      get opened() {
        return opened;
      },
      get closeOriginal() {
        return closeOriginal;
      },
    };
    retainedGenerations.add(retainedGeneration);
    let primaryFailed = false;
    let primary: unknown;
    let failed = false;
    let first: unknown;
    diagnosticReceipt = () => {
      const origin = originOwner.snapshot();
      return {
        stage,
        preflight,
        primary: primaryFailed ? 'failed' : 'none',
        duties: duties.snapshot(),
        cleanupFailed,
        origin: {
          connections: origin.connections,
          requests: Object.values(origin.counts).reduce((a, b) => a + b, 0),
          messages: origin.messages,
          cacheRequests: origin.cacheRequests,
          upgrades: origin.upgrades,
          websocketConnections: origin.websocketConnections,
          reportPhase: origin.reportPhase,
          overflow: origin.overflow,
          admitted: origin.admitted,
          routeProgress: Object.fromEntries(
            [
              '/',
              '/script.js',
              '/pixel',
              '/frame',
              '/worker.js',
              '/dedicated',
              '/shared.js',
              '/shared',
              '/sw.js',
              '/sw-install',
              '/sw-background',
              '/cache',
              '/shared-background',
              '/report',
            ].map((path) => [path, origin.counts[path] ?? 0])
          ),
        },

        generationClose: closeRows,
      };
    };
    try {
      const grant = await call(() =>
        composition.authorizeWorkspace({ cookie }, 'owned-fixture', new AbortController().signal)
      );
      opened = await call(
        () =>
          composition
            .open(grant, {
              kind: 'open',
              mode: 'ephemeral',
              requestId: randomBytes(16).toString('base64url'),
            })
            .then(async (original) => {
              opened = original;
              if (cleanupBegan) await closeGeneration();
              return original;
            }),
        15000
      );
      if (!opened) throw Error('TARGET_GENERATION_NOT_ACQUIRED');
      expect(originOwner.snapshot().connections).toBe(0); // Launch/ready has no uncontrolled navigation.
      opened.grantFixtureOrigin(origin, 30000);
      opened.grantFixtureOrigin(origin, 30000, 'websocket-connect');
      expect(opened.checkProtectedOwnersDenied()).toBe(true);
      stage = 'initial-navigation';
      expect(
        await call(
          () => opened!.navigateFixtureOrigin(origin, randomBytes(16).toString('base64url')),
          8000
        )
      ).toMatchObject({ kind: 'action', outcome: 'completed' });
      stage = 'target-report';
      assertTargetReport(await call(() => originOwner.report, 10000));
      const initial = originOwner.snapshot();
      expect(initial.cacheRequests).toBe(1);
      expect(initial.messages).toBeGreaterThan(0);
      expect(initial.overflow).toBe(false);
      for (const target of [
        '/script.js',
        '/pixel',
        '/frame',
        '/dedicated',
        '/shared',
        '/sw-install',
        '/sw-background',
        '/shared-background',
      ])
        expect(initial.counts[target]).toBeGreaterThan(0);
      expect(forbiddenConnections).toBe(0);
      expect(forbiddenRequests).toBe(0);
      expect(initial.leaks).toBe(0);
      const binding = opened.engine.listTabs(
        opened.opened.browserId,
        opened.opened.browserGeneration
      )[0]!;
      expect(
        (
          await call(() =>
            opened!.engine.capture({
              kind: 'capture',
              requestId: randomBytes(16).toString('base64url'),
              binding,
            })
          )
        ).bytes.length
      ).toBeGreaterThan(0);
      const click = () => ({
        kind: 'input',
        requestId: randomBytes(16).toString('base64url'),
        binding,
        steps: [{ kind: 'click', x: 100, y: 80, button: 'left' }],
      });
      expect(await call(() => opened!.engine.input(click()), 2500)).toMatchObject({
        kind: 'action',
        outcome: 'completed',
      });
      await call(() => originOwner.probe);
      const admittedBeforeRevoke = originOwner.snapshot();
      stage = 'revocation';
      composition.revokeWorkspace(grant);
      const afterRevoke = await call(() => opened!.engine.input(click()), 2500);
      expect(afterRevoke).toMatchObject({ kind: 'action', outcome: 'rejected', reason: 'stopped' });
      expect(
        await call(async () => {
          try {
            await opened!.navigateFixtureOrigin(origin, randomBytes(16).toString('base64url'));
            return false;
          } catch (error) {
            return isTargetAuthorityRefusal(error);
          }
        })
      ).toBe(true);
      await call(originOwner.transportBarrier); // Real original native transport returns; admitted in-flight bytes precede cutoff.
      const cutoff = originOwner.snapshot();
      expect(cutoff.connections).toBeGreaterThanOrEqual(admittedBeforeRevoke.connections);
      expect(cutoff.admitted).toBe(0);
      await call(() => new Promise<void>((resolve) => setTimeout(resolve, 500)));
      expect(originOwner.snapshot()).toEqual(cutoff);
      expect(forbiddenConnections).toBe(0);
      expect(forbiddenRequests).toBe(0);
      stage = 'generation-close';
      const closed = await call(closeGeneration, 8000);
      expect(closed.length).toBeGreaterThan(0);
      expect(closed.every((result) => result.cleanup === 'observed')).toBe(true);
      expect(
        closed.some(
          (result) =>
            result.browserId === opened!.opened.browserId &&
            result.browserGeneration === opened!.opened.browserGeneration &&
            result.cleanup === 'observed'
        )
      ).toBe(true);
      closureProven = true;
    } catch (error) {
      primaryFailed = true;
      primary = error;
    } finally {
      cleanupBegan = true;
      try {
        composition.stopAdmission();
      } catch (error) {
        failed = true;
        first = error;
      }
      if (opened && !closureProven) {
        try {
          const closed = await call(closeGeneration, 8000);
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
    if (primaryFailed) throw primary;
    if (failed) throw first;
  },
  60000
);

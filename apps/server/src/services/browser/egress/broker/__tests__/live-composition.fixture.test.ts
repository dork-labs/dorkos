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
import { createPrivateLiveBrowserComposition } from '../live/private-composition.js';
// Explicit fixture-owned installation input. No default-suite browser, download or personal profile.
const fixturePath = process.env.DORKOS_BROWSER_LIVE_AUTHORITY_FIXTURE;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  let failed = false;
  let first: unknown;
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  if (failed) throw first;
});
const closeServer = async (original: ReturnType<typeof createServer>) => {
  original.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    original.close((error) => (error ? reject(error) : resolve()))
  );
};
async function smallFile(path: string, cap: number): Promise<Buffer> {
  const named = await lstat(path, { bigint: true });
  if (!named.isFile() || named.size > BigInt(cap)) throw new Error('FIXTURE_INPUT_INVALID');
  const original = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
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
    return bytes.subarray(0, count);
  } finally {
    await original.close();
  }
}
it.skipIf(!fixturePath || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual authenticated owner composes cold broker, supervised Chromium, local consent and revocation',
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
    const home = await realpath(await mkdtemp(join(tmpdir(), 'browser-live-composition-')));
    let closureProven = false;
    cleanups.push(async () => {
      if (closureProven) await rm(home, { recursive: true, force: true });
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
      originConnections = 0,
      leaks = 0,
      probeRequests = 0;
    let firstProbeResolve!: () => void;
    const firstProbe = new Promise<void>((resolve) => {
      firstProbeResolve = resolve;
    });
    const origin = createServer((incoming, response) => {
      originRequests++;
      if (incoming.headers['proxy-authorization'] || incoming.headers.authorization) leaks++;
      if (incoming.url === '/probe') {
        probeRequests++;
        firstProbeResolve();
      }
      response.setHeader('cache-control', 'no-store');
      response.end(
        `<title>Owned broker fixture</title><link rel="icon" href="data:,"><button style="position:fixed;left:40px;top:40px;width:200px;height:80px" onclick="fetch('/probe',{cache:'no-store'})">Probe origin</button>`
      );
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
      const click = () => ({
        kind: 'input',
        requestId: randomBytes(16).toString('base64url'),
        binding,
        steps: [{ kind: 'click', x: 100, y: 80, button: 'left' }],
      });
      expect(await opened.engine.input(click())).toMatchObject({
        kind: 'action',
        outcome: 'completed',
      });
      await firstProbe; // Only the actual controlled origin handler can resolve this observation.
      expect(probeRequests).toBe(1);
      const beforeRequests = originRequests,
        beforeConnections = originConnections;
      const beforeProbeRequests = probeRequests;
      composition.revokeWorkspace(grant);
      const afterRevoke = await opened.engine.input(click());
      expect(afterRevoke).toMatchObject({ kind: 'action', outcome: 'rejected', reason: 'stopped' });
      await expect(
        opened.navigateFixtureOrigin(origin, randomBytes(16).toString('base64url'))
      ).rejects.toThrow('AUTHORITY_REFUSED');
      expect(originRequests).toBe(beforeRequests);
      expect(originConnections).toBe(beforeConnections);
      expect(probeRequests).toBe(beforeProbeRequests);
      expect(leaks).toBe(0);
      const closed = await opened.close();
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
      try {
        composition.stopAdmission();
      } catch (error) {
        failed = true;
        first = error;
      }
      if (opened && !closureProven) {
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
    if (primaryFailed) throw primary;
    if (failed) throw first;
  },
  60000
);

import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDb, runMigrations, workspaces } from '@dorkos/db';
import {
  createRuntimeInstallation,
  type InstallationConfiguration,
} from '@dorkos/browser/runtime-installation';
import type { TabRecord } from '../../../../../../../../packages/browser/src/lifecycle/records.js';
import { ownFixtureCustody } from '../../../../../../../../packages/browser/src/__tests__/fixture-custody.js';
import { createAuth } from '../../../../core/auth/index.js';
import { initConfigManager, configManager } from '../../../../core/config-manager.js';
import { createServerInventory } from '../server-inventory.js';
import { createInputAcceptanceComposition } from './input-acceptance-composition.js';
import {
  ownWebRtcEndpoints,
  ownWebRtcPreflight,
  readOwnedBytes,
  deriveOmittedWebRtcFlag,
  classifyRestriction,
  type IceObservation,
} from './webrtc-acceptance-endpoints.js';
// Explicit fixture-only installation input; no ordinary suite browser, download or personal profile.
const supplied = process.env.DORKOS_BROWSER_WEBRTC_ACCEPTANCE_FIXTURE;
type Controller = {
  contexts(): Array<{ pages(): TabRecord['page'][] }>;
  close(): Promise<void>;
};
const requestId = () => randomBytes(16).toString('base64url');

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'actual ICE data-channel attempts restrict endpoint UDP beside one-flag native traffic calibration',
  async () => {
    const outer = ownWebRtcPreflight(); // Charge before the first read, inspection or filesystem producer.
    let failed = false,
      primary: unknown,
      allClosed = false;
    let canonicalHome: string | undefined;
    let receiptRows = 0;
    const writeReceipt = (row: unknown) => {
      const line = JSON.stringify(row) + '\n';
      if (receiptRows >= 4 || Buffer.byteLength(line) > 4096)
        throw new Error('FIXTURE_RECEIPT_CAP');
      receiptRows++;
      // Inherited stdout belongs to the original test runner; do not close it.
      process.stdout.write(line);
    };
    try {
      const { status, packageRoot, browserRequire, libraryRoot, helper, helperSHA256, executable } =
        await outer.operation(
          'original files inspection',
          async () => {
            const preflightStart = performance.now();
            const stage = (name: string) =>
              console.log(
                JSON.stringify({
                  fixture: 'native-webrtc-preflight',
                  phase: 'files-inspection',
                  stage: name,
                  elapsedMs: performance.now() - preflightStart,
                })
              );
            stage('fixture-input-read:start');
            const input = JSON.parse((await readOwnedBytes(supplied!, 16384)).toString('utf8')) as {
              installation: InstallationConfiguration;
            };
            stage('fixture-input-read:return');
            stage('installation-inspect:start');
            const status = await createRuntimeInstallation(input.installation).inspectExisting();
            stage('installation-inspect:return');
            if (
              status.state !== 'installed-files' ||
              status.lastFreshVerifiedVersion !== '153.0.8010.12'
            )
              throw new Error('FIXTURE_OWN_INSTALLATION_REQUIRED');
            stage('package-library-resolve:start');
            const require = createRequire(import.meta.url);
            const packageRoot = await realpath(
              dirname(dirname(require.resolve('@dorkos/browser')))
            );
            const browserRequire = createRequire(join(packageRoot, 'package.json'));
            const libraryRoot = await realpath(
              dirname(browserRequire.resolve('playwright-core/package.json'))
            );
            if (libraryRoot !== (await realpath(input.installation.libraryRoot)))
              throw new Error('FIXTURE_OWN_LIBRARY_REQUIRED');
            stage('package-library-resolve:return');
            stage('helper-read:start');
            const helper = join(packageRoot, 'dist/runtime/native/darwin-process-observer');
            const helperSHA256 = createHash('sha256')
              .update(await readOwnedBytes(helper, 4 * 1024 * 1024))
              .digest('hex');
            stage('helper-read:return');
            const executable = join(
              input.installation.cacheRoot,
              'candidates',
              status.installationId,
              'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
            );
            return {
              input,
              status,
              packageRoot,
              browserRequire,
              libraryRoot,
              helper,
              helperSHA256,
              executable,
            };
          },
          20000
        );
      const { home, mutant } = await outer.operation(
        'original home derivation',
        async () => {
          const preflightStart = performance.now();
          const stage = (name: string) =>
            console.log(
              JSON.stringify({
                fixture: 'native-webrtc-preflight',
                phase: 'home-derivation',
                stage: name,
                elapsedMs: performance.now() - preflightStart,
              })
            );
          // Generated derivative stays in this worktree's dependency-resolution ancestry; no donor assets.
          const parent = join(packageRoot, 'node_modules/.cache');
          stage('cache-mkdir:start');
          await mkdir(parent, { recursive: true });
          stage('cache-mkdir:return');
          stage('named-home-acquire:start');
          const namedHome = await outer.acquireHome(() =>
            mkdtemp(join(parent, 'webrtc-acceptance-'))
          );
          stage('named-home-acquire:return');
          stage('home-realpath:start');
          const home = await realpath(namedHome);
          stage('home-realpath:return');
          stage('owned-derivation:start');
          const mutant = await deriveOmittedWebRtcFlag(
            join(packageRoot, 'dist'),
            join(home, 'omitted-dist'),
            join(packageRoot, 'src/runtime/darwin-supervisor-browser.ts'),
            join(packageRoot, 'node_modules/.cache/webrtc-owned-emitted-files.json')
          );
          await writeFile(join(home, 'mutation.json'), JSON.stringify(mutant, null, 2) + '\n');
          stage('owned-derivation:return');
          return { home, mutant };
        },
        5000
      );
      canonicalHome = home;
      // Both original files-only phases must return on time before endpoint construction.
      const endpoints = await outer.acquire(
        'owned endpoints',
        async () => ownWebRtcEndpoints(),
        (original) => original.close()
      );
      const addresses = await outer.operation('endpoint listen', () => endpoints.listen());
      const cohorts: Array<{ ice: IceObservation; packets: number; tcpAccepts: number }> = [];
      for (const mode of ['restricted', 'omitted'] as const) {
        const rowIndex = cohorts.length;
        const custody = ownFixtureCustody();
        let cohortFailed = false,
          cohortFirst: unknown;
        let stopAdmission: (() => void) | undefined,
          closeController: (() => Promise<void>) | undefined;
        let closeEngine: (() => Promise<unknown>) | undefined;
        try {
          const cohortHome = join(home, mode);
          await custody.operation('original cohort directory', () => mkdir(cohortHome));
          const db = createDb(join(cohortHome, 'fixture.db'));
          custody.adopt('database', db, async (original) => {
            original.$client.close();
          });
          runMigrations(db);
          initConfigManager(cohortHome);
          configManager.set('auth', { enabled: true });
          const auth = createAuth(db, cohortHome);
          const signup = await custody.operation('sign up', () =>
            auth.api.signUpEmail({
              body: {
                name: 'WebRTC fixture owner',
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
              path: join(cohortHome, 'workspace'),
              source: cohortHome,
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
          const admin = inventory.acquire(
            'server',
            'http',
            () => createServer((_request, response) => response.end('private fixture')),
            (original) => original.listen(0, '127.0.0.1')
          );
          custody.adopt(
            'original admin',
            admin,
            (original) =>
              new Promise<void>((resolve, reject) => {
                original.closeAllConnections();
                original.close((error) => (error ? reject(error) : resolve()));
              })
          );
          await custody.operation('admin listen', () => once(admin, 'listening'));
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
              dataDir: join(cohortHome, 'browser'),
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
                workerPath: join(packageRoot, 'dist/runtime/darwin-journal-worker.js'),
                browserWorkerPath:
                  mode === 'restricted'
                    ? join(packageRoot, 'dist/runtime/darwin-supervisor-worker.js')
                    : mutant.workerPath,
                artifact: { path: helper, sha256: helperSHA256 },
                duration: 30000,
                maxGap: 5000,
              },
            },
          });
          stopAdmission = () => composition.stopAdmission();
          custody.adopt('admission', composition, async (original) => {
            original.stopAdmission();
          });
          const grant = await custody.operation('real authorization', () =>
            composition.authorizeWorkspace(
              { cookie },
              'owned-fixture',
              new AbortController().signal
            )
          );
          let selected: { browserId: string; browserGeneration: number } | undefined;
          const opened = await custody.acquire(
            'original engine',
            async () => {
              const original = await composition.open(grant, {
                kind: 'open',
                mode: 'ephemeral',
                requestId: requestId(),
              });
              selected = {
                browserId: original.binding.browserId,
                browserGeneration: original.binding.browserGeneration,
              };
              return original;
            },
            (original) => {
              return closeEngine ? closeEngine() : original.close();
            },
            10000,
            (returned) =>
              Array.isArray(returned) &&
              !!selected &&
              returned.some(
                (row) =>
                  row.browserId === selected!.browserId &&
                  row.browserGeneration === selected!.browserGeneration &&
                  row.cleanup === 'observed'
              ) &&
              returned.every((row) => row.cleanup === 'observed')
          );
          let engineClose: ReturnType<typeof opened.close> | undefined;
          closeEngine = () => (engineClose ??= opened.close());
          const originalUrl = opened.grantFixtureOrigin(endpoints.origin, 30000);
          const navigationBefore = endpoints.snapshot();
          const navigation = await custody.operation('initial original navigation', () =>
            opened.navigateFixtureOrigin(endpoints.origin, requestId())
          );
          const library = browserRequire('playwright-core') as {
            chromium: {
              connectOverCDP(url: string, options: { timeout: number }): Promise<Controller>;
            };
          };
          const controller = await custody.acquire(
            'original controller',
            () =>
              library.chromium.connectOverCDP(opened.readFixtureAdminEndpoint().url, {
                timeout: 2000,
              }),
            (original) => (closeController ? closeController() : original.close()),
            2000
          );
          let controllerClose: Promise<void> | undefined;
          closeController = () => (controllerClose ??= controller.close());
          expect(controller.contexts()).toHaveLength(1);
          expect(controller.contexts()[0]!.pages()).toHaveLength(1);
          const page = controller.contexts()[0]!.pages()[0]!;
          const before = endpoints.snapshot();
          expect(navigation.outcome).toBe('completed');
          expect(navigation.binding.browserId).toBe(selected!.browserId);
          expect(navigation.binding.browserGeneration).toBe(selected!.browserGeneration);
          expect(page.url()).toBe(new URL(originalUrl).href);
          expect(before.originRequests - navigationBefore.originRequests).toBeGreaterThan(0);
          expect(before.leakedCredentials).toBe(0);
          const ice = await custody.operation(
            'actual native ICE APIs',
            () =>
              page.evaluate(async ({ udpPort, tcpPort }) => {
                const start = performance.now();
                if (typeof RTCPeerConnection !== 'function')
                  return {
                    api: false,
                    dataChannel: false,
                    localDescription: false,
                    candidates: 0,
                    gatheringComplete: false,
                    elapsed: 0,
                  };
                const peer = new RTCPeerConnection({
                  iceServers: [
                    { urls: `stun:127.0.0.1:${udpPort}` },
                    {
                      urls: `turn:127.0.0.1:${tcpPort}?transport=tcp`,
                      username: 'owned-fixture',
                      credential: 'owned-fixture',
                    },
                  ],
                });
                let candidates = 0;
                peer.onicecandidate = (event) => {
                  if (event.candidate) candidates++;
                };
                let channel: RTCDataChannel | undefined;
                let failed = false,
                  first: unknown,
                  result: IceObservation | undefined;
                try {
                  channel = peer.createDataChannel('owned-native-calibration');
                  await peer.setLocalDescription(await peer.createOffer());
                  const end = performance.now() + 3000;
                  while (peer.iceGatheringState !== 'complete' && performance.now() < end)
                    await new Promise((resolve) => setTimeout(resolve, 20));
                  result = {
                    api: true,
                    dataChannel: channel.readyState !== 'closed',
                    localDescription: peer.localDescription?.type === 'offer',
                    candidates,
                    gatheringComplete: peer.iceGatheringState === 'complete',
                    elapsed: performance.now() - start,
                  };
                } catch (error) {
                  failed = true;
                  first = error;
                }
                for (const close of [() => channel?.close(), () => peer.close()]) {
                  try {
                    close();
                  } catch (error) {
                    if (!failed) first = error;
                    failed = true;
                  }
                }
                if (failed) throw first;
                return result!;
              }, addresses),
            5000
          );
          const after = endpoints.snapshot();
          if (after.uncertain || after.malformed)
            throw new Error('FIXTURE_ENDPOINT_OBSERVATION_UNVERIFIED');
          cohorts.push({
            ice,
            packets: after.packets - before.packets,
            tcpAccepts: after.accepts - before.accepts,
          });
          expect(opened.readFixtureAdminEndpoint()).toBeDefined();
        } catch (error) {
          cohortFailed = true;
          cohortFirst = error;
        }
        // Independent original duties: admission failure cannot skip controller or engine close.
        for (const [label, operation] of [
          [
            'admission stop',
            stopAdmission
              ? async () => {
                  stopAdmission!();
                }
              : undefined,
          ],
          ['controller close', closeController],
          ['engine close', closeEngine],
        ] as const) {
          if (!operation) continue;
          try {
            await custody.operation<unknown>(label, operation, 5000);
          } catch (error) {
            if (!cohortFailed) cohortFirst = error;
            cohortFailed = true;
          }
        }
        const closed = await custody.finish(5000);
        if (!closed.observed) {
          if (!cohortFailed) cohortFirst = new Error('FIXTURE_ORIGINAL_COHORT_UNKNOWN');
          cohortFailed = true;
        }
        try {
          writeReceipt({ mode, originalClosure: closed, observation: cohorts[rowIndex] ?? null });
        } catch (error) {
          if (!cohortFailed) cohortFirst = error;
          cohortFailed = true;
        }
        if (cohortFailed) throw cohortFirst;
      }
      const [restricted, calibration] = cohorts;
      const verdict = classifyRestriction({
        restricted: restricted!.ice,
        calibration: calibration!.ice,
        restrictedPackets: restricted!.packets,
        calibrationPackets: calibration!.packets,
      });
      expect(
        restricted!.tcpAccepts,
        'denied native TURN TCP endpoint must not receive a direct connection'
      ).toBe(0);
      writeReceipt({
        fixture: 'native-webrtc-UDP',
        verdict,
        cohorts,
        tcp: 'UNVERIFIED: contact counters only; proxy-omission TURN calibration not exercised',
        tlsTurn: 'UNVERIFIED',
        relayDelivery: 'UNVERIFIED',
        workerMatrix: 'UNVERIFIED',
      });
      expect(
        verdict,
        'genuine API and nonzero omitted-restriction native packet calibration required'
      ).toBe('observed');
      allClosed = true;
    } catch (error) {
      failed = true;
      primary = error;
    }
    const closed = await outer.finish(5000);
    if (!closed.observed) {
      if (!failed) primary = new Error('FIXTURE_ENDPOINT_CLOSURE_UNKNOWN');
      failed = true;
    }
    // Failed/unknown originals and their generated assets remain available for diagnosis.
    if (allClosed && closed.observed && !failed && canonicalHome) {
      try {
        await outer.removeHome(canonicalHome, 5000);
      } catch (error) {
        if (!failed) primary = error;
        failed = true;
      }
    }
    try {
      writeReceipt({
        fixture: 'native-webrtc-original-cleanup',
        failed,
        retainedOriginalHomeCount: outer.homes().length,
        closure: closed,
        homeRemoval: outer.removalSnapshot(),
      });
    } catch (error) {
      if (!failed) primary = error;
      failed = true;
    }
    if (failed) throw primary;
  },
  60000
);

import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { createDb, runMigrations, workspaces } from '@dorkos/db';
import {
  createRuntimeInstallation,
  type InstallationConfiguration,
} from '@dorkos/browser/runtime-installation';
import { parseBrowserCommand } from '@dorkos/browser';
import type { TabRecord } from '../../../../../../../../packages/browser/src/lifecycle/records.js';
import { ownFixtureCustody } from '../../../../../../../../packages/browser/src/__tests__/fixture-custody.js';
import { createAuth } from '../../../../core/auth/index.js';
import { initConfigManager, configManager } from '../../../../core/config-manager.js';
import { createServerInventory } from '../server-inventory.js';
import { createInputAcceptanceComposition } from './input-acceptance-composition.js';
import { readOwnedBytes, ownWebRtcPreflight } from './webrtc-acceptance-endpoints.js';
import {
  ownDeniedQuicEndpoint,
  ownQuicSchemeEndpoints,
  deriveProxyOmission,
  classifyWebTransport,
  type TransportAttempt,
} from './quic-scheme-acceptance-endpoints.js';
const supplied = process.env.DORKOS_BROWSER_QUIC_SCHEME_ACCEPTANCE_FIXTURE;
const id = () => randomBytes(16).toString('base64url');
type Controller = { contexts(): Array<{ pages(): TabRecord['page'][] }>; close(): Promise<void> };

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'native WebTransport proxy restriction beside original Page UDP calibration and private scheme documents',
  async () => {
    const outer = ownWebRtcPreflight();
    let failed = false,
      primary: unknown,
      home: string | undefined;
    try {
      const setup = await outer.operation(
        'QUIC original files inspection',
        async () => {
          const input = JSON.parse((await readOwnedBytes(supplied!, 16384)).toString()) as {
            installation: InstallationConfiguration;
          };
          const status = await createRuntimeInstallation(input.installation).inspectExisting();
          if (
            status.state !== 'installed-files' ||
            status.lastFreshVerifiedVersion !== '153.0.8010.12'
          )
            throw Error('QUIC_OWN_INSTALLATION_REQUIRED');
          const require = createRequire(import.meta.url);
          const root = await realpath(dirname(dirname(require.resolve('@dorkos/browser'))));
          const browserRequire = createRequire(join(root, 'package.json'));
          const libraryRoot = await realpath(
            dirname(browserRequire.resolve('playwright-core/package.json'))
          );
          if (libraryRoot !== (await realpath(input.installation.libraryRoot)))
            throw Error('QUIC_OWN_LIBRARY_REQUIRED');
          const helper = join(root, 'dist/runtime/native/darwin-process-observer');
          const helperSHA256 = createHash('sha256')
            .update(await readOwnedBytes(helper, 4 * 1024 * 1024))
            .digest('hex');
          return {
            root,
            browserRequire,
            libraryRoot,
            status,
            helper,
            helperSHA256,
            input,
          };
        },
        20000
      );
      const mutant = await outer.operation(
        'QUIC original home derivation',
        async () => {
          await mkdir(join(setup.root, 'node_modules/.cache'), { recursive: true });
          const named = await outer.acquireHome(() =>
            mkdtemp(join(setup.root, 'node_modules/.cache/quic-scheme-'))
          );
          home = await realpath(named);
          return deriveProxyOmission(
            join(setup.root, 'dist'),
            join(home, 'proxy-omitted-dist'),
            join(setup.root, 'src/runtime/darwin-supervisor-browser.ts'),
            join(setup.root, 'node_modules/.cache/webrtc-owned-emitted-files.json')
          );
        },
        5000
      );
      const endpoints = ownQuicSchemeEndpoints();
      outer.adopt('original QUIC endpoints', endpoints, (original) => original.close());
      const addresses = await outer.operation('original QUIC listen', () => endpoints.listen());
      const rows: Array<{ attempt: TransportAttempt; packets: number }> = [];
      for (const mode of ['restricted', 'proxy-omitted'] as const) {
        const rowIndex = rows.length;
        const owner = ownFixtureCustody();
        let bad = false,
          first: unknown;
        let stopAdmission: (() => void) | undefined,
          closeController: (() => Promise<void>) | undefined,
          closeEngine: (() => Promise<unknown>) | undefined;
        try {
          const directory = join(home!, mode);
          await owner.operation('cohort directory', () => mkdir(directory));
          const db = createDb(join(directory, 'fixture.db'));
          owner.adopt('original database', db, async (original) => {
            original.$client.close();
          });
          runMigrations(db);
          initConfigManager(directory);
          configManager.set('auth', { enabled: true });
          const auth = createAuth(db, directory);
          const signup = await owner.operation('actual signup', () =>
            auth.api.signUpEmail({
              body: {
                name: 'QUIC fixture',
                email: 'quic@dork.test',
                password: 'fixture-only-not-personal',
              },
              asResponse: true,
            })
          );
          expect(signup.status).toBe(200);
          const cookie = signup.headers
            .getSetCookie()
            .map((s) => s.split(';')[0])
            .join('; ');
          db.insert(workspaces)
            .values({
              id: 'owned-fixture',
              projectKey: 'owned-fixture',
              key: 'owned',
              path: join(directory, 'workspace'),
              source: directory,
              provider: 'clone',
              status: 'ready',
              portBase: 6400,
              portBlockSize: 10,
              createdAt: new Date().toISOString(),
              lastUsedAt: new Date().toISOString(),
            })
            .run();
          const denied = ownDeniedQuicEndpoint();
          owner.adopt('original denied endpoint', denied, (original) => original.close());
          const inventory = createServerInventory({
            instances: [{ id: 'server', listeners: ['http'] }],
            adminAuthorities: [],
            now: () => Math.floor(performance.now()),
          });
          const admin = inventory.acquire(
            'server',
            'http',
            () => denied.server,
            (original) => original.listen(0, '127.0.0.1')
          );
          await owner.operation('admin ready', () => once(admin, 'listening'));
          const address = admin.address();
          if (!address || typeof address === 'string') throw Error('QUIC_ADMIN_UNKNOWN');
          const composition = createInputAcceptanceComposition({
            scope: 'private-fixture',
            db,
            auth,
            config: configManager,
            inventory,
            now: () => Math.floor(performance.now()),
            resolver: async () => {
              throw Error('QUIC_NO_DNS');
            },
            engineConfiguration: {
              dataDir: join(directory, 'browser'),
              runtime: {
                library: {
                  package: 'playwright-core',
                  version: '1.63.0',
                  rootDir: setup.libraryRoot,
                  assets: { manifest: 'browsers.json', cli: 'cli.js' },
                },
                executable: {
                  path: join(
                    setup.input.installation.cacheRoot,
                    'candidates',
                    setup.status.installationId,
                    'payload/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
                  ),
                  sha256: setup.status.executableSHA256,
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
                workerPath: join(setup.root, 'dist/runtime/darwin-journal-worker.js'),
                browserWorkerPath:
                  mode === 'restricted'
                    ? join(setup.root, 'dist/runtime/darwin-supervisor-worker.js')
                    : mutant.workerPath,
                artifact: { path: setup.helper, sha256: setup.helperSHA256 },
                duration: 30000,
                maxGap: 5000,
              },
            },
          });
          stopAdmission = () => composition.stopAdmission();
          owner.adopt('admission', composition, async (original) => {
            original.stopAdmission();
          });
          const grant = await owner.operation('original grant', () =>
            composition.authorizeWorkspace(
              { cookie },
              'owned-fixture',
              new AbortController().signal
            )
          );
          let selected: { browserId: string; browserGeneration: number } | undefined;
          const opened = await owner.acquire(
            'original generation',
            async () => {
              const original = await composition.open(grant, {
                kind: 'open',
                mode: 'ephemeral',
                requestId: id(),
              });
              selected = original.binding;
              return original;
            },
            (original) => (closeEngine ? closeEngine() : original.close()),
            10000,
            (value) =>
              Array.isArray(value) &&
              !!selected &&
              value.length > 0 &&
              value.every((v) => v.cleanup === 'observed') &&
              value.some(
                (v) =>
                  v.browserId === selected!.browserId &&
                  v.browserGeneration === selected!.browserGeneration
              )
          );
          let engineCloseOriginal: ReturnType<typeof opened.close> | undefined;
          closeEngine = () =>
            (engineCloseOriginal ??= Promise.resolve().then(() => opened.close()));
          const originalURL = opened.grantFixtureOrigin(endpoints.origin, 30000);
          const beforeNav = endpoints.snapshot();
          const nav = await owner.operation('native initial navigation', () =>
            opened.navigateFixtureOrigin(endpoints.origin, id())
          );
          expect(nav.outcome).toBe('completed');
          expect(nav.binding.browserId).toBe(selected!.browserId);
          const chromium = (
            setup.browserRequire('playwright-core') as {
              chromium: {
                connectOverCDP(url: string, options: { timeout: number }): Promise<Controller>;
              };
            }
          ).chromium;
          const controller = await owner.acquire(
            'original controller',
            () => chromium.connectOverCDP(opened.readFixtureAdminEndpoint().url, { timeout: 2000 }),
            (original) => (closeController ? closeController() : original.close()),
            2000
          );
          let controllerCloseOriginal: Promise<void> | undefined;
          closeController = () =>
            (controllerCloseOriginal ??= Promise.resolve().then(() => controller.close()));
          expect(controller.contexts()).toHaveLength(1);
          expect(controller.contexts()[0]!.pages()).toHaveLength(1);
          const page = controller.contexts()[0]!.pages()[0]!;
          expect(page.url()).toBe(new URL(originalURL).href);
          expect(endpoints.snapshot().http.originRequests).toBeGreaterThan(
            beforeNav.http.originRequests
          );
          const before = endpoints.snapshot();
          const attempt = await owner.operation(
            'actual WebTransport constructor',
            () =>
              page.evaluate(
                async ({ port }) => {
                  type NativeTransport = {
                    ready: Promise<unknown>;
                    closed: Promise<unknown>;
                    close(): void;
                  };
                  const Constructor = (
                    globalThis as typeof globalThis & {
                      WebTransport?: new (url: string) => NativeTransport;
                    }
                  ).WebTransport;
                  if (!Constructor)
                    return {
                      api: false,
                      constructed: false,
                      secureContext: isSecureContext,
                      ready: 'rejected' as const,
                      closedSettled: false,
                    };
                  const original = new Constructor(`https://127.0.0.1:${port}/owned-webtransport`);
                  let closedSettled = false;
                  void original.closed.then(
                    () => {
                      closedSettled = true;
                    },
                    () => {
                      closedSettled = true;
                    }
                  );
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  let ready: 'returned' | 'rejected' | 'held';
                  try {
                    ready = await Promise.race([
                      original.ready.then(
                        () => 'returned' as const,
                        () => 'rejected' as const
                      ),
                      new Promise<'held'>((resolve) => {
                        timer = setTimeout(() => resolve('held'), 1500);
                      }),
                    ]);
                  } finally {
                    if (timer) clearTimeout(timer);
                    original.close();
                  }
                  const end = performance.now() + 500;
                  while (!closedSettled && performance.now() < end)
                    await new Promise((resolve) => setTimeout(resolve, 5));
                  return {
                    api: true,
                    constructed: true,
                    secureContext: isSecureContext,
                    ready,
                    closedSettled,
                  };
                },
                { port: addresses.quicPort }
              ),
            3000
          );
          const after = endpoints.snapshot();
          if (after.uncertain || after.http.uncertain) throw Error('QUIC_ENDPOINT_UNVERIFIED');
          rows.push({ attempt, packets: after.packets - before.packets });
          if (mode === 'restricted') {
            for (const url of [
              'file:///fixture-only',
              'dork-fixture:external',
              'javascript:void(0)',
              'data:text/html,fixture',
              'blob:http://127.0.0.1/fixture',
            ])
              expect(() =>
                parseBrowserCommand({
                  kind: 'navigate',
                  requestId: id(),
                  binding: nav.binding,
                  url,
                })
              ).toThrow();
            const documentBefore = endpoints.snapshot();
            const probe = await owner.operation(
              'native app-owned blob/data fetch',
              () =>
                page.evaluate(
                  async ({ origin, denied }) => {
                    const results: Array<{ kind: string; reported: boolean }> = [];
                    for (const kind of ['blob', 'data']) {
                      const frame = document.createElement('iframe');
                      let url: string | undefined;
                      let timer: ReturnType<typeof setTimeout> | undefined;
                      let callback: ((e: MessageEvent) => void) | undefined;
                      const code = `fetch(${JSON.stringify(origin + '/owned-' + kind)}).catch(()=>{}).then(()=>fetch(${JSON.stringify(denied)}).catch(()=>{})).then(()=>parent.postMessage(${JSON.stringify(kind)},'*'))`;
                      const html = '<script>' + code + '<' + '/script>';
                      const report = new Promise<boolean>((resolve) => {
                        callback = (e: MessageEvent) => {
                          if (e.source === frame.contentWindow && e.data === kind) {
                            window.removeEventListener('message', callback!);
                            resolve(true);
                          }
                        };
                        window.addEventListener('message', callback);
                        timer = setTimeout(() => {
                          window.removeEventListener('message', callback!);
                          resolve(false);
                        }, 1000);
                      });
                      try {
                        frame.src =
                          kind === 'blob'
                            ? (url = URL.createObjectURL(new Blob([html], { type: 'text/html' })))
                            : 'data:text/html,' + encodeURIComponent(html);
                        document.body.append(frame);
                        results.push({ kind, reported: await report });
                      } finally {
                        if (timer) clearTimeout(timer);
                        if (callback) window.removeEventListener('message', callback);
                        frame.remove();
                        if (url) URL.revokeObjectURL(url);
                      }
                    }
                    return results;
                  },
                  {
                    origin: originalURL.replace(/\/$/, ''),
                    denied: `http://127.0.0.1:${address.port}/denied`,
                  }
                ),
              3000
            );
            expect(probe.every((r) => r.reported)).toBe(true);
            expect(denied.snapshot().requests).toBe(0);
            expect(denied.snapshot().connections).toBe(0);
            expect(endpoints.snapshot().counts['/owned-blob']).toBeGreaterThan(
              documentBefore.counts['/owned-blob'] ?? 0
            );
            expect(endpoints.snapshot().counts['/owned-data']).toBeGreaterThan(
              documentBefore.counts['/owned-data'] ?? 0
            );
          }
        } catch (error) {
          bad = true;
          first = error;
        }
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
            await owner.operation<unknown>(label, operation, 5000);
          } catch (error) {
            if (!bad) first = error;
            bad = true;
          }
        }
        const closed = await owner.finish(5000);
        if (!closed.observed) {
          if (!bad) first = Error('QUIC_ORIGINAL_COHORT_HELD');
          bad = true;
        }
        console.log(
          JSON.stringify({
            fixture: 'QUIC-cohort-originals',
            mode,
            originalClosure: closed,
            observation: rows[rowIndex] ?? null,
          })
        );
        if (bad) throw first;
      }
      const verdict = classifyWebTransport({
        restricted: rows[0]!.attempt,
        calibration: rows[1]!.attempt,
        restrictedPackets: rows[0]!.packets,
        calibrationPackets: rows[1]!.packets,
      });
      console.log(
        JSON.stringify({
          fixture: 'native-WebTransport-UDP',
          verdict,
          rows,
          http3: 'UNVERIFIED: no Alt-Svc/H3 server',
          tlsHandshake: 'UNVERIFIED: datagram observation only',
          schemeGuard: 'portable schema refusal; blob/data Page requests separately observed',
          full5_5: 'OPEN',
        })
      );
      expect(verdict, 'zero without original Page calibration is UNVERIFIED').toBe('observed');
    } catch (error) {
      failed = true;
      primary = error;
    }
    const closed = await outer.finish(5000);
    if (!closed.observed) {
      if (!failed) primary = Error('QUIC_PREFLIGHT_HELD');
      failed = true;
    }
    if (!failed && home) {
      try {
        await outer.removeHome(home, 5000);
      } catch (error) {
        failed = true;
        primary = error;
      }
    }
    if (failed) throw primary;
  },
  60000
);

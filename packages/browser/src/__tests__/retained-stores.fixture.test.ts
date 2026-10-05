import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { constructOwnedBrowserEngine, type PrivateBrowserRetirementReceiver } from '../engine.js';
import type { EngineConfiguration } from '../configuration.js';
import type { BrowserBinding } from '../contracts.js';
import { parseBrowserResult } from '../contracts.js';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
import { verifiedLibrary } from '../runtime/public-library.js';
import { ownFixtureCustody } from './fixture-custody.js';
import { ownFixtureSession } from './fixture-session-custody.js';
import {
  createStoresFixture,
  ownStoresCalls,
  assertRetainedStores,
  assertCleanStores,
  assertIsolatedStores,
  type StoresReport,
} from './retained-stores-fixture.js';
// Explicit fixture-only arm; no ordinary test/browser admission or implicit installation.
// eslint-disable-next-line no-restricted-syntax
const supplied = process.env.DORKOS_BROWSER_RETAINED_STORES_FIXTURE;
const requestId = () => randomBytes(16).toString('base64url');
const profile = (role: string) => `profile_retained_${role}_00000000000000000`;

async function setup() {
  const input = JSON.parse(await readFile(supplied!, 'utf8')) as {
    helper: string;
    helperSHA256: string;
    browserWorker: string;
    journalWorker: string;
    executable: string;
    executableSHA256: string;
  };
  const root = await realpath(await mkdtemp(join(tmpdir(), 'retained-stores-'))),
    custody = ownFixtureCustody();
  const origin = createStoresFixture();
  const calls = ownStoresCalls();
  custody.adopt('original-calls:return', calls, (value) => value.close());
  custody.adopt('origin:close', origin, (value) => value.close());
  const receivers: PrivateBrowserRetirementReceiver[] = [];
  const engines: ReturnType<typeof constructOwnedBrowserEngine>[] = [];
  try {
    const url = await custody.operation('origin:listen', () => origin.listen());
    const require = createRequire(import.meta.url);
    const artifact = { path: input.helper, sha256: input.helperSHA256 };
    const config: EngineConfiguration = {
      dataDir: join(root, 'data'),
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
      network: { kind: 'fixture', origin: url },
      clock: { monotonicNow: () => performance.now(), wallNow: () => Date.now() },
      processes: {
        observe: async () => ({ status: 'unknown' }),
        descendants: async () => ({ status: 'unknown', identities: [] }),
      },
      policy: { authorizeAction: async () => 'allowed', verifyBrokerLease: async () => 'unknown' },
      nativeJournal: {
        workerPath: input.journalWorker,
        browserWorkerPath: input.browserWorker,
        artifact,
        duration: 180000,
        maxGap: 5000,
      },
    };
    const native = createDarwinEngineProcesses(artifact);
    const makeEngine = () => {
      const owned: PrivateBrowserRetirementReceiver[] = [];
      const engine = constructOwnedBrowserEngine(config, {
        registerBirth(receiver) {
          receivers.push(receiver);
          owned.push(receiver);
        },
        refuseBirth() {},
      });
      engines.push(engine);
      custody.adopt(
        'engine:shutdown',
        engine,
        (value) => value.shutdown(),
        (results) => {
          if (!Array.isArray(results) || results.length !== owned.length) return false;
          const remaining = new Set(owned.map((r) => `${r.browserId}:${r.browserGeneration}`));
          return (
            results.every((value) => {
              const r = parseBrowserResult(value);
              return (
                r.kind === 'close' &&
                r.cleanup === 'observed' &&
                remaining.delete(`${r.browserId}:${r.browserGeneration}`)
              );
            }) && remaining.size === 0
          );
        }
      );
      return engine;
    };
    return { root, custody, calls, origin, receivers, engines, config, native, makeEngine };
  } catch (primary) {
    await custody.finish();
    throw primary;
  }
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type Engine = ReturnType<Fixture['makeEngine']>;
const open = (f: Fixture, engine: Engine, command: unknown) =>
  f.calls.call('original-open', () => engine.open(command), 15000);
async function report(f: Fixture, page: string, revision: number): Promise<StoresReport> {
  await expect
    .poll(() => f.origin.reports.filter((r) => r.page === page && r.revision === revision).length, {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  return f.origin.reports.filter((r) => r.page === page && r.revision === revision).at(-1)!;
}
async function click(f: Fixture, engine: Engine, binding: BrowserBinding, x: number) {
  expect(
    await f.calls.call(
      'original-input',
      () =>
        engine.input({
          kind: 'input',
          requestId: requestId(),
          binding,
          steps: [{ kind: 'click', x, y: 50, button: 'left' }],
        }),
      2500
    )
  ).toMatchObject({ outcome: 'completed' });
}
async function closeOriginal(
  f: Fixture,
  engine: Engine,
  opened: { browserId: string; browserGeneration: number }
) {
  const receiver = f.receivers.find(
    (r) => r.browserId === opened.browserId && r.browserGeneration === opened.browserGeneration
  )!;
  const endpoint = receiver.verifiedBrowserAdminEndpoint();
  if (!endpoint) throw Error('ORIGINAL_NATIVE_ENDPOINT_MISSING');
  const result = await f.calls.call(
    'original-close',
    () =>
      engine.close({
        kind: 'close',
        requestId: requestId(),
        browserId: opened.browserId,
        browserGeneration: opened.browserGeneration,
      }),
    6000
  );
  expect(result.cleanup).toBe('observed');
  const retirement = await f.calls.call('original-retirement', () => receiver.observation, 6000);
  expect(retirement.terminal.cleanup).toBe('observed');
  await expect
    .poll(
      async () => {
        const roots = await f.calls.call(
          'original-native-observe',
          () =>
            Promise.all(
              [endpoint.root, endpoint.supervisor].map((id) =>
                f.native.processes.observe(id, new AbortController().signal)
              )
            ),
          2500
        );
        return roots.every((value) => value.status === 'dead');
      },
      { timeout: 5000 }
    )
    .toBe(true);
}
async function finish(
  f: Fixture,
  primaryPresent: boolean,
  primary: unknown,
  scenario: string,
  sessionCookies: boolean[]
) {
  const cleanup = await f.custody.finish(5000);
  let failed = primaryPresent,
    error = primary;
  try {
    await mkdir(new URL('../../.temp/', import.meta.url), { recursive: true });
    await f.custody.operation('receipt:write', () =>
      writeFile(
        new URL(`../../.temp/retained-stores-${scenario}-${requestId()}.json`, import.meta.url),
        JSON.stringify({
          scenario,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          executableSHA256: f.config.runtime.executable.sha256,
          mutations: f.origin.reports.filter((r) => r.revision > 0).length,
          sessionCookies,
          expiredCookies: f.origin.reports.filter((r) => r.expiredCookie).length,
          viewers: 0,
          cleanup,
          outcome: failed ? 'failed' : cleanup.observed ? 'pass' : 'held',
          profileContentsExported: false,
        }),
        { mode: 0o600 }
      )
    );
    if (!cleanup.observed || !f.custody.snapshot().observed || f.origin.failed)
      throw Error('PERSISTENCE_ORIGINAL_CLEANUP_UNOBSERVED');
    if (!failed)
      await f.custody.operation('root:remove', () => rm(f.root, { recursive: true, force: true }));
  } catch (failure) {
    if (!failed) {
      failed = true;
      error = failure;
    }
  }
  if (failed) throw error;
}

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64').each([
  { scenario: 'retained-clean', mutant: false },
  { scenario: 'persistence-mutant', mutant: true },
])(
  'three exact clean process restarts and separate clean return: $scenario',
  async ({ scenario, mutant }) => {
    const f = await setup();
    let failed = false,
      primary: unknown;
    const sessions: boolean[] = [];
    try {
      let engine = f.makeEngine(),
        page = f.origin.configure({ role: 'A' });
      let opened = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'persistent',
        profileId: profile('A'),
      });
      await report(f, page, 0);
      await click(f, engine, opened.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === page && r.local === 'A'), {
          timeout: 5000,
        })
        .toBe(true);
      assertRetainedStores(f.origin.reports.filter((r) => r.page === page).at(-1)!, 'A', 0);
      const warmed = f.origin.httpRequests;
      for (let restart = 0; restart < 3; restart++) {
        const old = opened;
        await closeOriginal(f, engine, opened);
        await f.calls.call('original-shutdown', () => engine.shutdown(), 6000);
        engine = f.makeEngine();
        page = f.origin.configure({ role: 'A', reset: mutant && restart === 0 });
        opened = await open(f, engine, {
          kind: 'open',
          requestId: requestId(),
          mode: 'persistent',
          profileId: profile('A'),
        });
        expect(opened.browserId).not.toBe(old.browserId);
        expect(opened.tab.tabId).not.toBe(old.tab.tabId);
        const current = await report(f, page, 0);
        sessions.push(current.sessionCookie);
        if (mutant) {
          expect(() => assertRetainedStores(current, 'A', 0)).toThrow('RETAINED_STORE_MISSING');
          return;
        }
        assertRetainedStores(current, 'A', 0);
        expect(f.origin.httpRequests).toBe(warmed);
      }
      const durable = opened,
        pageA = page;
      const before = f.origin.httpRequests;
      const cleanPage = f.origin.configure({ role: 'C' });
      const clean = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'ephemeral',
      });
      assertCleanStores(await report(f, cleanPage, 0));
      expect(f.origin.httpRequests).toBe(before + 1);
      const ephemeral = await readdir(join(f.config.dataDir, 'ephemeral'));
      expect(ephemeral).toHaveLength(1);
      await click(f, engine, clean.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === cleanPage && r.local === 'C'), {
          timeout: 5000,
        })
        .toBe(true);
      await click(f, engine, clean.tab, 210);
      assertRetainedStores(await report(f, cleanPage, 1), 'C', 1);
      await closeOriginal(f, engine, clean);
      expect(await readdir(join(f.config.dataDir, 'ephemeral'))).toEqual([]);
      expect(engine.listTabs(durable.browserId, durable.browserGeneration)).toEqual([durable.tab]);
      const priorDurableReports = f.origin.reports.filter((r) => r.page === pageA).length;
      await click(f, engine, durable.tab, 350);
      await expect
        .poll(() => f.origin.reports.filter((r) => r.page === pageA).length)
        .toBe(priorDurableReports + 1);
      assertRetainedStores(f.origin.reports.filter((r) => r.page === pageA).at(-1)!, 'A', 0);
      await closeOriginal(f, engine, durable);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finish(f, failed, primary, scenario, sessions);
    }
  },
  120000
);

it.skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'seeded clean-context native negative control fails its named gate',
  async () => {
    const f = await setup();
    let failed = false,
      primary: unknown;
    try {
      const engine = f.makeEngine(),
        page = f.origin.configure({ role: 'C', seedClean: true });
      const opened = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'ephemeral',
      });
      const seeded = await report(f, page, 0);
      expect(() => assertCleanStores(seeded)).toThrow('CLEAN_CONTEXT_SEEDED');
      await closeOriginal(f, engine, opened);
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finish(f, failed, primary, 'clean-mutant', []);
    }
  },
  40000
);

it
  .skipIf(!supplied || process.platform !== 'darwin' || process.arch !== 'arm64')
  .each([false, true])(
  'two unattended profile workers100+100 with same-live-Page reattachment (shared mutant=%s)',
  async (shared) => {
    const f = await setup();
    let failed = false,
      primary: unknown;
    try {
      const engine = f.makeEngine(),
        pageA = f.origin.configure({ role: 'A' });
      const a = await open(f, engine, {
        kind: 'open',
        requestId: requestId(),
        mode: 'persistent',
        profileId: profile('A'),
      });
      await report(f, pageA, 0);
      await click(f, engine, a.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === pageA && r.local === 'A'), {
          timeout: 5000,
        })
        .toBe(true);
      const pageB = shared ? pageA : f.origin.configure({ role: 'B' });
      const b = shared
        ? a
        : await open(f, engine, {
            kind: 'open',
            requestId: requestId(),
            mode: 'persistent',
            profileId: profile('B'),
          });
      if (shared) {
        expect(() =>
          assertIsolatedStores(f.origin.reports.at(-1)!, f.origin.reports.at(-1)!)
        ).toThrow('PROFILE_STATE_SHARED');
        await closeOriginal(f, engine, a);
        return;
      }
      await report(f, pageB, 0);
      await click(f, engine, b.tab, 60);
      await expect
        .poll(() => f.origin.reports.some((r) => r.page === pageB && r.local === 'B'), {
          timeout: 5000,
        })
        .toBe(true);
      const library = await f.calls.call('library:verify', () => verifiedLibrary(f.config.runtime));
      const attach = async (opened: typeof a) => {
        const receiver = f.receivers.find((r) => r.browserId === opened.browserId)!;
        const endpoint = receiver.verifiedBrowserAdminEndpoint();
        if (!endpoint) throw Error('ORIGINAL_PAGE_ENDPOINT_MISSING');
        let closing: Promise<void> | undefined;
        const closeController = (value: Awaited<ReturnType<typeof library.connectOverCDP>>) =>
          (closing ??= Promise.resolve().then(() => value.close()));
        const controller = await f.custody.acquire(
          'observer:attach',
          () => library.connectOverCDP(endpoint.url, { timeout: 5000 }),
          closeController
        );
        const context = controller.contexts()[0]!,
          page = context.pages()[0]!;
        if (controller.contexts().length !== 1 || context.pages().length !== 1)
          throw Error('ORIGINAL_PAGE_AMBIGUOUS');
        const session = await f.custody.acquire(
          'observer:target-session',
          async () => ownFixtureSession(await context.newCDPSession(page), controller),
          (value) => value.close(),
          5000,
          (value) =>
            !!value && typeof value === 'object' && 'observed' in value && value.observed === true
        );
        const target = await f.calls.call('observer:target-identity', () =>
          session.session.send('Target.getTargetInfo')
        );
        if (
          typeof target.targetInfo.targetId !== 'string' ||
          !target.targetInfo.targetId ||
          target.targetInfo.type !== 'page'
        )
          throw Error('ORIGINAL_TARGET_UNAVAILABLE');
        const nativePage = await f.calls.call('observer:fixture-marker', () =>
          session.session.send('Runtime.evaluate', {
            expression:
              'JSON.stringify({page:PAGE,role:ROLE,marker:document.getElementById("marker").textContent,revision:Number(localStorage.getItem("revision")||0),url:location.href})',
            returnByValue: true,
          })
        );
        if (nativePage.exceptionDetails || typeof nativePage.result.value !== 'string')
          throw Error('ORIGINAL_PAGE_MARKER_UNAVAILABLE');
        const marker = JSON.parse(nativePage.result.value) as {
          page: string;
          role: string;
          marker: string;
          revision: number;
          url: string;
        };
        if (
          marker.page !== (opened.browserId === a.browserId ? pageA : pageB) ||
          marker.role !== (opened.browserId === a.browserId ? 'A' : 'B') ||
          marker.marker !== marker.role ||
          marker.url !== f.config.network.origin + '/'
        )
          throw Error('ORIGINAL_PAGE_MARKER_MISMATCH');
        let closed: Promise<void> | undefined;
        const close = () =>
          (closed ??= Promise.resolve().then(async () => {
            let failed = false,
              primary: unknown;
            try {
              const result = await session.close();
              if (!result.observed) throw Error('OBSERVER_SESSION_RETURN_UNOBSERVED');
            } catch (error) {
              failed = true;
              primary = error;
            }
            try {
              await closeController(controller);
            } catch (error) {
              if (!failed) primary = error;
              failed = true;
            }
            if (failed) throw primary;
          }));
        return {
          controller,
          context,
          page,
          targetId: target.targetInfo.targetId,
          contextId: target.targetInfo.browserContextId,
          marker,
          endpoint,
          close,
        };
      };
      const originals = [await attach(a), await attach(b)];
      for (const original of originals) await f.calls.call('observer:detach', original.close);
      await f.custody.operation(
        'two-workers:mutations',
        async () => {
          await Promise.all(
            (
              [
                [a, pageA],
                [b, pageB],
              ] as const
            ).map(async ([opened, page]) => {
              for (let revision = 1; revision <= 100; revision++) {
                await click(f, engine, opened.tab, 210);
                await report(f, page, revision);
              }
            })
          );
        },
        90000
      );
      assertIsolatedStores(await report(f, pageA, 100), await report(f, pageB, 100));
      for (const [index, opened] of [a, b].entries()) {
        expect(engine.listTabs(opened.browserId, opened.browserGeneration)).toEqual([opened.tab]);
        const attached = await attach(opened),
          original = originals[index]!;
        expect(attached.targetId).toBe(original.targetId);
        expect(attached.contextId).toBe(original.contextId);
        expect(attached.marker).toEqual({ ...original.marker, revision: 100 });
        expect(attached.controller).not.toBe(original.controller);
        expect(attached.page).not.toBe(original.page); // New SDK facade, same actual native target.
        expect(original.controller.isConnected()).toBe(false);
        expect(attached.endpoint).toEqual(original.endpoint);
        const role = index === 0 ? 'A' : 'B',
          page = index === 0 ? pageA : pageB;
        const before = f.origin.reports.filter((row) => row.page === page).length;
        await click(f, engine, opened.tab, 350);
        await expect
          .poll(() => f.origin.reports.filter((row) => row.page === page).length)
          .toBe(before + 1);
        assertRetainedStores(
          f.origin.reports.filter((row) => row.page === page).at(-1)!,
          role,
          100
        );
        expect(
          (
            await f.calls.call(
              'original-capture',
              () =>
                engine.capture({ kind: 'capture', binding: opened.tab, requestId: requestId() }),
              2500
            )
          ).receipt.binding
        ).toEqual(opened.tab);
        await f.calls.call('observer:detach', attached.close);
      }
      // Each worker emitted exactly one acknowledged report for revisions 1..100; the reattachment read adds one final100 report.
      for (const page of [pageA, pageB]) {
        const revisions = f.origin.reports.filter((row) => row.page === page && row.revision > 0);
        expect(revisions).toHaveLength(101);
        expect(revisions.slice(0, 100).map((row) => row.revision)).toEqual(
          Array.from({ length: 100 }, (_, index) => index + 1)
        );
      }
      for (const opened of [a, b]) await closeOriginal(f, engine, opened);
      for (const role of ['A', 'B'] as const) {
        const page = f.origin.configure({ role });
        const opened = await open(f, engine, {
          kind: 'open',
          requestId: requestId(),
          mode: 'persistent',
          profileId: profile(role),
        });
        assertRetainedStores(await report(f, page, 100), role, 100);
        await closeOriginal(f, engine, opened);
      }
    } catch (error) {
      failed = true;
      primary = error;
    } finally {
      await finish(f, failed, primary, shared ? 'shared-mutant' : 'isolated100', []);
    }
  },
  150000
);

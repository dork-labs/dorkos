/**
 * Helpers shared by the `retained-stores*.test.ts` suites. Not a `*.test.ts`, so vitest
 * never collects it as a suite.
 *
 * @module retained-stores.fixtures
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';
import {
  constructOwnedBrowserEngine,
  type PrivateBrowserRetirementReceiver,
} from '../../engine.js';
import type { EngineConfiguration } from '../../configuration.js';
import type { BrowserBinding } from '../../contracts.js';
import { parseBrowserResult } from '../../contracts.js';
import { createDarwinEngineProcesses } from '../../runtime/darwin-engine-processes.js';
import { ownFixtureCustody } from '../fixture-custody.js';
import {
  createStoresFixture,
  ownStoresCalls,
  type StoresReport,
} from '../retained-stores-fixture.js';

// Explicit fixture-only arm; no ordinary test/browser admission or implicit installation.
// eslint-disable-next-line no-restricted-syntax
export const supplied = process.env.DORKOS_BROWSER_RETAINED_STORES_FIXTURE;

export const requestId = () => randomBytes(16).toString('base64url');

export const profile = (role: string) => `profile_retained_${role}_00000000000000000`;

export async function setup() {
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
          version: '1.65.0-alpha-2026-10-30',
          rootDir: await realpath(dirname(require.resolve('playwright-core/package.json'))),
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: input.executable,
          sha256: input.executableSHA256,
          revision: '1252',
          version: '157.0.8103.15',
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

export type Fixture = Awaited<ReturnType<typeof setup>>;

export type Engine = ReturnType<Fixture['makeEngine']>;

export const open = (f: Fixture, engine: Engine, command: unknown) =>
  f.calls.call('original-open', () => engine.open(command), 15000);

export async function report(f: Fixture, page: string, revision: number): Promise<StoresReport> {
  await expect
    .poll(() => f.origin.reports.filter((r) => r.page === page && r.revision === revision).length, {
      timeout: 5000,
    })
    .toBeGreaterThan(0);
  return f.origin.reports.filter((r) => r.page === page && r.revision === revision).at(-1)!;
}

export async function click(f: Fixture, engine: Engine, binding: BrowserBinding, x: number) {
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

export async function closeOriginal(
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

export async function finish(
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

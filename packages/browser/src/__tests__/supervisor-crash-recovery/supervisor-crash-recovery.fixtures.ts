/**
 * Helpers shared by the `supervisor-crash-recovery*.fixture.test.ts` suites.
 * Not a `*.test.ts`, so vitest never collects it as a suite.
 *
 * @module __tests__/supervisor-crash-recovery/supervisor-crash-recovery.fixtures
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect } from 'vitest';
import {
  constructOwnedBrowserEngine,
  type PrivateBrowserRetirementReceiver,
} from '../../engine.js';
import type { EngineConfiguration, ProcessIdentity } from '../../configuration.js';
import { createDarwinEngineProcesses } from '../../runtime/darwin-engine-processes.js';
import { validateJournalSnapshot, type JournalSnapshot } from '../../lifecycle/process-journal.js';
import { parseBrowserResult } from '../../contracts.js';
import { ownFixtureCustody } from '../fixture-custody.js';
// Private native arm; ordinary tests never launch Chromium or signal any process.
// eslint-disable-next-line no-restricted-syntax
export const fixtureJSON = process.env.DORKOS_DARWIN_SUPERVISOR_FIXTURE;

export const requestId = () => randomBytes(16).toString('base64url');

export const profileId = 'profile_crash_original_00000000000';

export async function fixture() {
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

export async function originals(f: Awaited<ReturnType<typeof fixture>>) {
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

export async function gone(
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

export async function restart(
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

export async function finishFixture(
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

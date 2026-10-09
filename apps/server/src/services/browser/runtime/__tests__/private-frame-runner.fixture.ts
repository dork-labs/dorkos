import { captureOriginalQualificationGrant } from './qualification-grant.fixture.js';
import {
  parseOriginalResourceStart,
  parseOriginalResourceCompletion,
  originalResourceViewerInterval,
  retainOriginalResourceJob,
} from './private-resource-evidence.fixture.js';
import { createOriginalFrameRetirementReport } from './private-frame-retirement-report.fixture.js';
import { Socket } from 'node:net';
import { connectOriginalColdListener } from './private-frame-cold-listener.fixture.js';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserProductionOpenReceiptSchema } from '@dorkos/shared/browser-schemas';
import { createOriginalNativeProjectionReceiver } from '../private-native-projection.js';
import { createOriginalProjectedResourceBank } from './private-projected-resource-bank.fixture.js';
import { createOriginalViewerFileSink } from '../private-native-acceptance.js';
import { verifyPublicNativeEmits, type PublicNativeInput } from './public-native-input.js';
import { measurePrivateOriginalResourceWindow } from './private-role-resource-window.fixture.js';
import {
  createOriginalFrameChannel,
  parseOriginalFrameStatistics,
  withOriginalFrameDrain,
  stopAndJoinOriginalFrameWorker,
  joinOriginalFrameWorkerReturns,
  releaseOriginalFrameWorker,
} from './private-frame-channel.fixture.js';
import {
  launchOwnedFrontend,
  createOriginalOwnerStorage,
} from '../../../../../../e2e/fixtures/managed-owned-frontend.js';

/** Executable original built CLI production + owned Playwright worker. Parent supplies
 * the same qualified campaign signal/current guard; no new deadline or capacity claim. */
export async function runPrivateOriginalFrameWindow(options: {
  input: PublicNativeInput;
  worktree: string;
  artifacts: string;
  node: string;
  pnpm: string;
  signal: AbortSignal;
  current(): void;
  idle(): Promise<void>;
  acceptance?: 'ui' | 'performance' | 'resource';
  retain(report: unknown): Promise<void>;
}) {
  const current = options.current.bind(options),
    retain = options.retain.bind(options);
  let first: { value: unknown } | undefined;
  const retirementReport = createOriginalFrameRetirementReport();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const jobs: Promise<unknown>[] = [];
  const own = <T>(original: Promise<T>): Promise<T> => {
    jobs.push(original);
    return retainOriginalResourceJob(original, (value) => {
      first ??= { value };
      lifetime.abort(first.value);
    });
  };
  const assertRetainedFailure = () => {
    if (first) throw first.value;
  };
  const assert = () => {
    assertRetainedFailure();
    current();
    assertRetainedFailure();
    signal.throwIfAborted();
  };
  let projection: ReturnType<typeof createOriginalNativeProjectionReceiver> | undefined;
  let cli: ChildProcess | undefined;
  let cliReturned: Promise<void> | undefined;
  let cliPipes: Promise<void> | undefined;
  const cliLogs: FileHandle[] = [];
  let frontend: Awaited<ReturnType<typeof launchOwnedFrontend>> | undefined;
  let stopFrontend: (() => void) | undefined;
  let worker: ChildProcess | undefined;
  let raw: FileHandle | undefined;
  let workerReturned: Promise<void> | undefined;
  let bank: ReturnType<typeof createOriginalProjectedResourceBank> | undefined;
  let native:
    | Awaited<
        ReturnType<
          (typeof import('@dorkos/browser/runtime-installation'))['verifyInstalledNativeJournal']
        >
      >
    | undefined;
  let release: (() => Promise<void>) | undefined;

  try {
    assert();
    if (
      (await realpath(options.worktree)) !== options.worktree ||
      (await realpath(options.artifacts)) !== options.artifacts
    )
      throw new Error('FRAME_ORIGINAL_PATHS_REQUIRED');
    await own(verifyPublicNativeEmits(options.input, assert));
    const {
      resolveInstalledRuntimeConfiguration,
      createRuntimeInstallation,
      verifyInstalledNativeJournal,
    } = await import('@dorkos/browser/runtime-installation');
    const configuration = await own(
      resolveInstalledRuntimeConfiguration(
        pathToFileURL(options.input.cliEntry),
        options.input.home
      )
    );
    const installation = await own(createRuntimeInstallation(configuration).inspectExisting());
    if (installation.state !== 'installed-files')
      throw new Error('FRAME_ORIGINAL_INSTALLATION_REQUIRED');
    native = await own(verifyInstalledNativeJournal(configuration));
    const channelDirectory = join(options.artifacts, 'original-frame-channel');
    await own(mkdir(channelDirectory));
    const channel = await own(createOriginalFrameChannel(channelDirectory, signal));
    const queuePath = join(options.artifacts, 'original-viewer-queue.json');
    const publishQueue = createOriginalViewerFileSink(queuePath);
    const cliStdout = await own(
      open(join(options.artifacts, 'original-cli.stdout.raw'), 'wx', 0o600)
    );
    cliLogs.push(cliStdout);
    const cliStderr = await own(
      open(join(options.artifacts, 'original-cli.stderr.raw'), 'wx', 0o600)
    );
    cliLogs.push(cliStderr);
    assert();
    const qualificationGrant = await own(captureOriginalQualificationGrant(options.input, assert));
    cli = spawn(
      options.node,
      [
        options.input.cliEntry,
        '--no-open',
        '--no-tasks',
        '--port',
        String(options.input.port),
        '--dir',
        options.input.home,
        '--boundary',
        options.input.home,
      ],
      {
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          NODE_ENV: 'production',
          DORK_HOME: options.input.home,
          DORKOS_SEARCH_NO_EXTERNAL_HISTORY: 'true',
          DORKOS_HOST: '127.0.0.1',
          DORKOS_TELEMETRY_DISABLED: '1',
          OTEL_SDK_DISABLED: 'true',
          DORKOS_BROWSER_PRIVATE_NATIVE_ACCEPTANCE: '1',
        },
      }
    );
    const originalCli = cli;
    const stopOriginalCli = () => {
      if (originalCli.exitCode === null && originalCli.signalCode === null)
        originalCli.kill('SIGTERM');
    };
    signal.addEventListener('abort', stopOriginalCli, { once: true });
    cliReturned = own(
      new Promise<void>((yes, no) => {
        originalCli.once('error', no);
        originalCli.once('close', (code, stop) => {
          signal.removeEventListener('abort', stopOriginalCli);
          return code === 0 && stop === null
            ? yes()
            : no(new Error('FRAME_ORIGINAL_CLI_RETURN_REFUSED'));
        });
      })
    );
    let cliBytes = 0;
    const cliDrain = async (stream: Readable, log: FileHandle) => {
      for await (const chunk of stream) {
        cliBytes += Buffer.byteLength(chunk);
        if (cliBytes > 32 * 1024 * 1024) throw new Error('FRAME_ORIGINAL_CLI_PIPE_BOUND');
        await log.write(Buffer.from(chunk));
      }
    };
    const cliPipeJobs = [
      own(cliDrain(originalCli.stdout!, cliStdout)),
      own(cliDrain(originalCli.stderr!, cliStderr)),
    ];
    cliPipes = own(
      (async () => {
        let failure: { value: unknown } | undefined;
        for (const original of cliPipeJobs)
          void original.catch((value) => {
            failure ??= { value };
          });
        for (const result of await Promise.allSettled(cliPipeJobs))
          if (result.status === 'rejected') failure ??= { value: result.reason };
        if (failure) throw failure.value;
      })()
    );
    bank = createOriginalProjectedResourceBank({
      parent: native.manager,
      identity: native.identity,
      attributeRoot: native.attributeRoot,
      cli: originalCli,
      processes: native.processes,
      signal,
      current: () => {
        assert();
        projection?.assertCurrent();
      },
      own,
    });
    const originalBank = bank;
    if (!originalCli.pid) throw new Error('FRAME_ORIGINAL_CLI_PID_REQUIRED');
    const queueSamples: Parameters<typeof publishQueue>[0]['samples'][number][] = [];
    projection = createOriginalNativeProjectionReceiver({
      qualification: qualificationGrant,
      pid: originalCli.pid,
      channel: {
        send(message, callback) {
          return originalCli.send(message, (error) => callback(error));
        },
        on(event, callback) {
          originalCli.on(event, callback);
        },
        off(event, callback) {
          originalCli.off(event, callback);
        },
        disconnect() {
          if (originalCli.connected) originalCli.disconnect();
        },
      },
      retainBirth: (birth) => own(originalBank.retainBirth(birth)),
      retainViewerSample: async (sample) => {
        assert();
        publishQueue({ samples: queueSamples.concat(sample) });
        queueSamples.push(sample);
      },
    });
    const cliManager = await own(bank.captureCli());
    // Playwright sends production Secure cookies over its supported local hostname exception.
    // The original server remains bound to numeric loopback; cookie flags and auth policy stay intact.
    const origin = `http://localhost:${options.input.port}`;
    // Literal public acceptance cold Socket oracle: no HTTP/auth/body failure is retried.
    const sockets = new Map<Socket, () => void>();
    for (;;) {
      assert();
      projection.assertCurrent();
      if (originalCli.exitCode !== null || originalCli.signalCode !== null)
        throw new Error('FRAME_ORIGINAL_CLI_RETURNED');
      const probe = await own(connectOriginalColdListener(options.input.port, sockets, assert));
      if (probe.state === 'connected') break;
      await own(new Promise<void>((yes) => setTimeout(yes, 50)));
      assert();
    }
    const healthy = await own(fetch(origin + '/api/health', { signal }));
    await own(healthy.arrayBuffer());
    if (healthy.status !== 200) throw new Error('FRAME_ORIGINAL_HEALTH_REFUSED');
    assert();
    frontend = await own(
      launchOwnedFrontend((original) => own(originalBank.captureFrontend(original)).then(() => {}))
    );
    const originalFrontend = frontend;
    stopFrontend = () => {
      if (
        originalFrontend.original.exitCode === null &&
        originalFrontend.original.signalCode === null
      )
        originalFrontend.original.kill('SIGTERM');
    };
    signal.addEventListener('abort', stopFrontend, { once: true });
    if (signal.aborted) stopFrontend();
    assert();
    const storageState = join(options.artifacts, 'original-owner-storage.json');
    await own(createOriginalOwnerStorage(frontend.wsEndpoint, origin, options.input, storageState));
    // One genuine sign-in for this original HTTP owner; never parse/fabricate user claims.
    const login = await own(
      fetch(origin + '/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ email: options.input.email, password: options.input.password }),
        signal,
      })
    );
    await own(login.arrayBuffer());
    if (login.status !== 200) throw new Error('FRAME_ORIGINAL_OWNER_SIGN_IN_REFUSED');
    const cookie = login.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    if (!cookie) throw new Error('FRAME_ORIGINAL_OWNER_COOKIE_REQUIRED');
    const env = {
      ...process.env,
      PATH: join(options.node, '..') + ':' + (process.env.PATH ?? ''),
      DORKOS_MANAGED_UI_BASE_URL: origin,
      DORKOS_MANAGED_UI_STORAGE_STATE: storageState,
      DORKOS_MANAGED_UI_OUTPUT: join(options.artifacts, 'original-playwright-output'),
      DORKOS_MANAGED_FRONTEND_WS: frontend.wsEndpoint,
      DORKOS_MANAGED_QUEUE_OBSERVATIONS: queuePath,
      DORKOS_MANAGED_FRAME_PARENT_DIR: channelDirectory,
      DORKOS_MANAGED_UI_WORKSPACE: options.input.workspaceId,
    };
    raw = await own(open(join(options.artifacts, 'original-frame-worker.raw'), 'wx', 0o600));
    const originalRaw = raw;
    let count = 0;
    assert();
    worker = spawn(
      options.node,
      [
        options.pnpm,
        '--filter',
        '@dorkos/e2e',
        'exec',
        'playwright',
        'test',
        '--config',
        options.acceptance === 'ui'
          ? 'playwright.managed-native.config.ts'
          : options.acceptance === 'resource'
            ? 'playwright.managed-resource.config.ts'
            : 'playwright.managed-performance.config.ts',
      ],
      { cwd: options.worktree, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const originalWorker = worker;
    const abortWorker = () => {
      if (originalWorker.exitCode === null) originalWorker.kill('SIGTERM');
    };
    signal.addEventListener('abort', abortWorker, { once: true });
    const drain = async (stream: Readable) => {
      for await (const value of stream) {
        const bytes = Buffer.from(value);
        count += bytes.length;
        if (count > 32 * 1024 * 1024) throw new Error('FRAME_ORIGINAL_WORKER_OUTPUT_BOUND');
        await originalRaw.write(bytes);
      }
    };
    const returned = new Promise<void>((resolve, reject) => {
      originalWorker.once('error', reject);
      originalWorker.once('exit', (code, stop) =>
        code === 0 && stop === null ? resolve() : reject(new Error('FRAME_ORIGINAL_WORKER_FAILED'))
      );
    });
    workerReturned = own(
      (async () => {
        try {
          await joinOriginalFrameWorkerReturns(
            [returned, drain(originalWorker.stdout!), drain(originalWorker.stderr!)],
            () => originalRaw.close(),
            abortWorker
          );
        } finally {
          signal.removeEventListener('abort', abortWorker);
        }
      })()
    );
    if (signal.aborted) abortWorker();
    assert();
    if (options.acceptance === 'ui') {
      await workerReturned;
      await own(retain({ kind: 'actual-installed-ui-worker', returned: 'PASS' }));
    } else if (options.acceptance === 'resource') {
      let released = false;
      release = async () => {
        if (!released) {
          released = true;
          await releaseOriginalFrameWorker(
            async () => {
              try {
                await channel.write('release', null);
              } catch (value) {
                first ??= { value };
                throw value;
              }
            },
            originalWorker,
            workerReturned!
          );
        }
      };
      const start = parseOriginalResourceStart(await own(channel.wait('ready')));
      const bindings = start.ready.subjects.map((row) => row.open.binding);
      await own(bank.roles(bindings));
      const nodeIdentities = bank.resourceNodeIdentities(bindings);
      let viewers: unknown;
      const report = await own(
        measurePrivateOriginalResourceWindow({
          bank,
          manager: cliManager,
          nodeIdentities,
          processes: native.processes,
          bindings,
          signal,
          current: assert,
          own,
          idle: options.idle,
          async active() {
            await channel.write('start', null);
            const end = parseOriginalResourceCompletion(await channel.wait('active'));
            if (JSON.stringify(end.idleBefore) !== JSON.stringify(start.idleBefore))
              throw new Error('RESOURCE_ORIGINAL_IDLE_BASELINE_REPLACED');
            const idle = originalResourceViewerInterval(
              start.ready,
              end.idleBefore,
              end.idleAfter,
              queueSamples,
              false
            );
            const active = originalResourceViewerInterval(
              start.ready,
              end.activeBefore,
              end.activeAfter,
              queueSamples,
              true
            );
            if (end.frames !== active.frames || end.bytes !== active.bytes)
              throw new Error('RESOURCE_ORIGINAL_ACTIVE_COUNTER_MISMATCH');
            viewers = {
              idle,
              active,
              counterScope:
                'actual viewer observer wall-clock brackets; retained separately from native ps brackets',
            };
            return { frames: active.frames, bytes: active.bytes };
          },
        })
      );
      await own(
        retain({
          kind: 'actual-separate-resource-window',
          report,
          viewers,
          originalDrawnSubjects: start.ready.subjects,
          nonzeroCpu: {
            idle: report.idle.nodeProcesses.cpuMilliseconds > 0,
            active: report.active.nodeProcesses.cpuMilliseconds > 0,
            idleRoles: report.idle.roles.map((r) => ({
              kind: r.kind,
              root: r.root,
              nonzero: r.cpuMilliseconds > 0,
            })),
            activeRoles: report.active.roles.map((r) => ({
              kind: r.kind,
              root: r.root,
              nonzero: r.cpuMilliseconds > 0,
            })),
          },
          latency: 'UNRUN',
          tunnel: 'UNRUN',
          handoff: 'UNRUN',
          additionalSlotsAdmitted: 0,
        })
      );
      await own(release());
      await workerReturned;
    } else {
      let released = false;
      release = async () => {
        if (!released) {
          released = true;
          await releaseOriginalFrameWorker(
            async () => {
              try {
                await channel.write('release', null);
              } catch (value) {
                // Retain the release failure before stopping the worker can cause a later exit failure.
                first ??= { value };
                throw value;
              }
            },
            originalWorker,
            workerReturned!
          );
        }
      };
      const saved = BrowserProductionOpenReceiptSchema.parse(await own(channel.wait('ready')));
      if (saved.instance.mode !== 'persistent')
        throw new Error('FRAME_ORIGINAL_SAVED_RECEIPT_REQUIRED');
      assert();
      const ephemeralRequestId = randomUUID();
      const response = await own(
        fetch(origin + '/api/browser/runtime/open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
          body: JSON.stringify({
            workspaceId: options.input.workspaceId,
            request: { mode: 'ephemeral', requestId: ephemeralRequestId },
          }),
          signal,
        })
      );
      const ephemeral = BrowserProductionOpenReceiptSchema.parse(await own(response.json()));
      if (
        response.status !== 200 ||
        ephemeral.requestId !== ephemeralRequestId ||
        ephemeral.instance.mode !== 'ephemeral'
      )
        throw new Error('FRAME_ORIGINAL_EPHEMERAL_RECEIPT_REQUIRED');
      const bindings = [ephemeral.binding, saved.binding];
      await own(bank.roles(bindings));
      const report = await own(
        measurePrivateOriginalResourceWindow({
          bank,
          manager: cliManager,
          processes: native.processes,
          bindings,
          signal,
          current: assert,
          own,
          idle: options.idle,
          async active() {
            await channel.write('start', null);
            const value = await channel.wait('active');
            const payload = parseOriginalFrameStatistics(value);
            await retain({ kind: 'actual-frame-observer', value });
            return payload;
          },
        })
      );
      await own(retain({ kind: 'actual-role-resource-window', report }));
      await own(release());
      await workerReturned;
    }
    projection.assertCurrent();
    bank.assertCurrent();
  } catch (value) {
    first ??= { value };
  } finally {
    let drainedFailure: { value: unknown } | undefined;
    try {
      await withOriginalFrameDrain(
        async () => {
          if (first) throw first.value;
        },
        async () => {
          try {
            await (release ?? (async () => {}))();
          } catch (value) {
            retirementReport.failure('worker-release', value);
            throw value;
          }
        },
        [
          async () => {
            if (workerReturned) {
              try {
                if (worker && (first || options.signal.aborted))
                  await stopAndJoinOriginalFrameWorker(worker, workerReturned);
                else await workerReturned;
              } catch (value) {
                retirementReport.failure('worker-return', value);
                first ??= { value };
              }
            }
            for (const [stage, close] of [
              ['worker-log-close', raw ? () => raw!.close() : undefined],
              ['frontend-close', frontend ? () => frontend!.close() : undefined],
            ] as const)
              if (close)
                try {
                  await own(close());
                } catch (value) {
                  retirementReport.failure(stage, value);
                  first ??= { value };
                }
            if (stopFrontend) signal.removeEventListener('abort', stopFrontend);
            // Original IPC callback work drains before graceful CLI stop; CLI+both pipes join before birth absence checks.
            if (projection)
              try {
                await own(projection.close());
              } catch (value) {
                retirementReport.failure('projection-close', value);
                first ??= { value };
              }
            if (cli && cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM');
            for (const [stage, original] of [
              ['cli-return', cliReturned],
              ['cli-pipes', cliPipes],
            ] as const)
              if (original)
                try {
                  await original;
                } catch (value) {
                  retirementReport.failure(stage, value);
                  first ??= { value };
                }
            for (const log of cliLogs) {
              try {
                await log.sync();
              } catch (value) {
                retirementReport.failure('cli-log-sync', value);
                first ??= { value };
              }
              try {
                await log.close();
              } catch (value) {
                retirementReport.failure('cli-log-close', value);
                first ??= { value };
              }
            }
            for (const result of await Promise.allSettled(jobs))
              if (result.status === 'rejected') {
                retirementReport.failure('retained-job', result.reason);
                first ??= { value: result.reason };
              }
            if (native && bank)
              for (const birth of bank.originalKnownBirths()) {
                if (birth.pid === native.manager.pid && birth.birth === native.manager.birth)
                  continue;
                let observationReturned = false;
                try {
                  const observed = await native.processes.observe(
                    birth,
                    new AbortController().signal
                  );
                  observationReturned = true;
                  const status = observed.status;
                  retirementReport.observed(birth, status);
                  if (status !== 'dead')
                    throw new Error('FRAME_ORIGINAL_BIRTH_RETIREMENT_UNVERIFIED');
                } catch (value) {
                  retirementReport.observationFailure(birth, value, observationReturned);
                  first ??= { value };
                }
              }
            if (first) throw first.value;
          },
        ]
      );
    } catch (value) {
      // Keep the drain's original first cause, including a release failure concurrent with cleanup.
      drainedFailure = { value };
    }
    try {
      await retain(
        retirementReport.snapshot({
          knownBirths: bank?.originalKnownBirths() ?? [],
          excludedParent: native?.manager ?? null,
          originalChildPids: {
            cli: cli?.pid ?? null,
            frontend: frontend?.original.pid ?? null,
          },
          primary: drainedFailure ?? first,
        })
      );
    } catch (value) {
      first ??= { value };
    }
    if (drainedFailure) first = drainedFailure;
  }
  if (first) throw first.value;
}

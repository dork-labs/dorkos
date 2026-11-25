/** Observe a maintained nested fixture without process discovery or signals. */
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as wait } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  allocatePosixSocketDirectory,
  queryGroupPresence,
} from '@dorkos/test-utils/run-custody/posix';
import { RUNTIME_ENV_PROFILES } from '../../../shared/runtime-environment-catalog.js';
import { pinnedOpenCode } from '../pinned-opencode.js';
import {
  openFixtureObserver,
  openPositiveControl,
} from './fixtures/runner-parent-exit-observer.js';
import type { RunnerExitMode } from './fixtures/runner-parent-exit.setup.js';

const armed = process.env.DORKOS_OPENCODE_PINNED_SERVE_PROOF === '1';
const hostedLinuxX64 =
  process.env.GITHUB_ACTIONS === 'true' &&
  process.env.RUNNER_ENVIRONMENT === 'github-hosted' &&
  process.platform === 'linux' &&
  process.arch === 'x64';
const LOG_CAP = 32768;
async function until<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned fixture deadline')),
          Math.max(0, deadline - Date.now())
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nestedFixture(mode: RunnerExitMode): () => Promise<void> {
  return async () => {
    const deadline = Date.now() + 30_000;
    const silent = mode === 'silent-worker';
    // End self-exit observations at the existing success cutoff, leaving time to report failure.
    const successCutoff = deadline - 1000;
    const observationDeadline = silent ? deadline : successCutoff;
    let root: string | undefined;
    let output: FileHandle | undefined;
    let closed = false;
    let clean = false;
    let capture = true;
    let released = false;
    let joinRunner: (() => Promise<unknown>) | undefined;
    let positive: ReturnType<typeof openPositiveControl> | undefined;
    const errors: unknown[] = [];
    const logs = {
      stdout: { chunks: [] as Buffer[], retained: 0, total: 0, truncated: false },
      stderr: { chunks: [] as Buffer[], retained: 0, total: 0, truncated: false },
    };
    const diagnostics: Record<string, unknown> = { version: 1, mode, phase: 'preparing' };
    try {
      const flags = new Set(['OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE']);
      if (
        RUNTIME_ENV_PROFILES.OpenCode.some(
          (name) => !flags.has(name) && Object.hasOwn(process.env, name)
        )
      )
        throw new Error('Runner fixture refuses ambient OpenCode configuration');
      if (!pinnedOpenCode()) throw new Error('Pinned fixture unavailable');
      // Nested Unix sockets need a short fixture root on macOS.
      const tempParent = process.platform === 'darwin' ? '/tmp' : tmpdir();
      root = await realpath(await mkdtemp(join(tempParent, 'oc-re-')));
      const ownedRoot = root;
      const socket = await allocatePosixSocketDirectory(ownedRoot);
      output = await open(
        join(ownedRoot, 'terminal.json'),
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600
      );
      const initial = await output.stat({ bigint: true });
      await writeFile(
        join(ownedRoot, 'context.json'),
        JSON.stringify({ deadline, mode, socketDirectory: socket.directory }),
        { flag: 'wx', mode: 0o600 }
      );
      const require = createRequire(import.meta.url);
      const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
      const serverRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
      const config = join(serverRoot, 'vitest.opencode-runner-exit.config.ts');
      const env: Record<string, string> = {
        PATH: ['/usr/sbin', '/sbin', dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        LANG: 'C',
        HOME: ownedRoot,
        TMPDIR: ownedRoot,
        TMP: ownedRoot,
        TEMP: ownedRoot,
        DORKOS_OPENCODE_PINNED_SERVE_PROOF: '1',
        DORKOS_TEST_RUNNER_EXIT_CHILD: '1',
        DORKOS_TEST_RUNNER_EXIT_ROOT: ownedRoot,
      };
      for (const name of [
        'DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_DIR',
        'DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_MANIFEST_SHA256',
      ]) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      const inspect = silent ? await openFixtureObserver(env) : undefined;
      if (silent) positive = openPositiveControl(ownedRoot);
      const runner = spawn(
        process.execPath,
        [vitest, 'run', '--config', config, '--maxWorkers=1', '--retry=0'],
        {
          cwd: serverRoot,
          env,
          stdio: ['ignore', 'pipe', 'pipe', output.fd],
          shell: false,
        }
      );
      diagnostics.phase = 'spawned';
      diagnostics.runnerPid = runner.pid;
      for (const name of ['stdout', 'stderr'] as const) {
        runner[name]?.on('data', (data: Buffer) => {
          if (!capture) return;
          const log = logs[name];
          log.total = Math.min(Number.MAX_SAFE_INTEGER, log.total + data.length);
          const remaining = LOG_CAP - log.retained;
          if (remaining > 0) {
            const retained = Buffer.from(data.subarray(0, remaining));
            log.chunks.push(retained);
            log.retained += retained.length;
          }
          if (log.total > LOG_CAP) log.truncated = true;
        });
      }
      const done = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          runner.once('error', reject);
          runner.once('close', (code, signal) => {
            closed = true;
            diagnostics.close = { code, signal };
            resolve({ code, signal });
          });
        }
      );
      void done.catch(() => undefined);
      joinRunner = () => until(done, deadline);
      const exited = new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          runner.once('error', reject);
          runner.once('exit', (code, signal) => resolve({ code, signal }));
        }
      );
      void exited.catch(() => undefined);
      async function json(name: string) {
        const value = await readFile(join(ownedRoot, name));
        if (value.length > 4096) throw new Error('Owned receipt exceeds bound');
        return JSON.parse(value.toString());
      }
      async function waitForJson(name: string, limit: number) {
        while (Date.now() < limit) {
          try {
            return await json(name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          await wait(25);
        }
        throw new Error(`Missing owned fixture receipt: ${name}`);
      }
      async function noOrdinaryCleanup() {
        await expect(lstat(join(ownedRoot, 'normal-teardown-ran'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(lstat(join(ownedRoot, 'worker-fallback-started'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      let verifyWorkerAfterNativeCleanup: (() => Promise<void>) | undefined;
      if (silent) {
        const actor = positive;
        if (!inspect || !actor?.pid || !runner.pid)
          throw new Error('Missing owned fixture subjects');
        const runnerPid = runner.pid;
        const controlPid = actor.pid;
        const ownerProofDeadline = deadline - 6_500;
        const live = await waitForJson('pinned-ready.json', ownerProofDeadline);
        const blocking = await waitForJson('worker-blocking.json', ownerProofDeadline);
        expect(blocking).toEqual({ pid: live.workerPid, stopAt: deadline - 1000 });
        expect(live.mainPid).toBe(runnerPid);
        expect(live.target.kind).toBe('spawned');
        expect(live.target.birth).toMatch(/^\d+:\d+$/);
        const [main, worker, target, control] = await Promise.all([
          inspect(runnerPid),
          inspect(live.workerPid),
          inspect(live.target.pid),
          inspect(controlPid),
        ]);
        const anchor = await inspect(target.parent);
        const guardian = await inspect(anchor.parent);
        const node = await realpath(process.execPath);
        expect(
          new Set([main.pid, worker.pid, target.pid, anchor.pid, guardian.pid, control.pid]).size
        ).toBe(6);
        expect(main).toMatchObject({ parent: process.pid, executable: node });
        expect(worker).toMatchObject({ parent: main.pid, executable: node });
        expect(control).toMatchObject({ parent: process.pid, executable: node });
        expect(target).toMatchObject({
          parent: anchor.pid,
          group: anchor.pid,
          birth: live.target.birth,
          executable: await realpath(pinnedOpenCode()!),
        });
        expect(anchor).toMatchObject({ group: anchor.pid, executable: node });
        expect(guardian).toMatchObject({ parent: main.pid, executable: node });
        expect(guardian.group).not.toBe(anchor.group);
        expect(control.group).not.toBe(anchor.group);
        await until(actor.challenge('before main exit'), ownerProofDeadline);
        await noOrdinaryCleanup();
        diagnostics.live = { main, worker, target, anchor, guardian, control };
        diagnostics.workerBlockingUntil = blocking.stopAt;

        expect(Date.now()).toBeLessThan(ownerProofDeadline);
        const authorized = join(ownedRoot, 'outer-authorized');
        await writeFile(
          authorized + '.part',
          JSON.stringify({ mainPid: main.pid, workerPid: worker.pid, targetPid: target.pid }),
          { flag: 'wx', mode: 0o600 }
        );
        await rename(authorized + '.part', authorized + '.json');
        const exactWorker = { pid: worker.pid, birth: worker.birth, executable: worker.executable };
        const actualExit = await until(exited, deadline);
        diagnostics.exit = actualExit;
        expect(actualExit).toEqual({ code: 23, signal: null });
        diagnostics.afterParentExit = await inspect(worker.pid);
        expect(diagnostics.afterParentExit).toMatchObject(exactWorker);
        verifyWorkerAfterNativeCleanup = async () => {
          diagnostics.afterNativeCleanup = await inspect(worker.pid);
          expect(diagnostics.afterNativeCleanup).toMatchObject(exactWorker);
          expect(queryGroupPresence(anchor.group)).toBe('absent');
          expect(await inspect(control.pid)).toEqual(control);
          await until(actor.challenge('after native cleanup'), deadline);
          await expect(lstat(join(ownedRoot, 'worker-exit.json'))).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await noOrdinaryCleanup();
          const observedAt = Date.now();
          expect(observedAt).toBeLessThan(blocking.stopAt);
          diagnostics.cleanupObservedAt = observedAt;
        };
      } else {
        // The main may exit before its output pipes close. Read the native receipts first.
        diagnostics.phase = 'runner-exit';
        const actualExit = await until(exited, observationDeadline);
        diagnostics.exit = actualExit;
        expect(actualExit).toEqual({ code: 23, signal: null });
      }

      diagnostics.phase = 'runner-receipts';
      await noOrdinaryCleanup();
      const ready = await json('pinned-ready.json');
      expect(ready.ready).toBe(true);
      expect(ready.starts).toBe(1);
      expect(ready.mainPid).toBe(runner.pid);
      expect(Number.isSafeInteger(ready.workerPid)).toBe(true);
      expect(ready.workerPid).toBeGreaterThan(0);
      expect(ready.workerPid).not.toBe(runner.pid);
      expect(ready.workerPid).not.toBe(process.pid);
      expect(ready.workerParentPid).toBe(runner.pid);
      expect(await json('runner-transition.json')).toEqual({
        kind: mode,
        code: 23,
        mainPid: runner.pid,
        workerPid: ready.workerPid,
      });
      expect(ready.target.kind).toBe('spawned');
      expect(ready.target.pid).toBeGreaterThan(0);
      diagnostics.phase = 'native-cleanup-receipt';
      let stat = await output.stat({ bigint: true });
      while (stat.size === 0n && Date.now() < observationDeadline) {
        await wait(25);
        stat = await output.stat({ bigint: true });
      }
      expect(stat.isFile()).toBe(true);
      expect(stat.uid).toBe(initial.uid);
      expect(stat.mode).toBe(initial.mode);
      expect(stat.dev).toBe(initial.dev);
      expect(stat.ino).toBe(initial.ino);
      expect(stat.birthtimeNs).toBe(initial.birthtimeNs);
      expect(stat.nlink).toBe(1n);
      expect(stat.size).toBeGreaterThan(0n);
      expect(stat.size).toBeLessThanOrEqual(512n);
      const buffer = Buffer.alloc(513);
      const got = await output.read(buffer, 0, buffer.length, 0);
      const after = await output.stat({ bigint: true });
      expect(after.size).toBe(stat.size);
      expect(after.mtimeNs).toBe(stat.mtimeNs);
      expect(BigInt(got.bytesRead)).toBe(stat.size);
      const raw = buffer.subarray(0, got.bytesRead).toString();
      expect(raw.endsWith('\n')).toBe(true);
      const receipt = JSON.parse(raw);
      expect(receipt).toEqual({
        version: 1,
        kind: 'cleaned-owned',
        anchorClose: expect.any(Object),
      });
      // The guardian waits for the owned anchor and verifies the group is gone.
      // An abrupt runner exit can reach the cleanup fallback before that wait.
      expect([
        { code: 0, signal: null },
        { code: null, signal: 'SIGKILL' },
      ]).toContainEqual(receipt.anchorClose);
      if (silent) {
        if (!verifyWorkerAfterNativeCleanup) throw new Error('Missing live worker observation');
        await verifyWorkerAfterNativeCleanup();
        await releaseWorker(ownedRoot, 'proof-observed');
        released = true;
        expect(await until(done, deadline)).toEqual({ code: 23, signal: null });
        diagnostics.terminal = receipt;
      }
      diagnostics.phase = 'worker-exit-receipt';
      const worker = await waitForJson('worker-exit.json', observationDeadline);
      expect(worker.version).toBe(1);
      expect(worker.workerPid).toBe(ready.workerPid);
      expect(worker.mainPid).toBe(runner.pid);
      expect(Number.isInteger(worker.code)).toBe(true);
      expect(worker.code).toBeGreaterThanOrEqual(0);
      expect(worker.code).toBeLessThanOrEqual(255);
      if (!silent) {
        diagnostics.phase = 'runner-close';
        expect(await until(done, observationDeadline)).toEqual({ code: 23, signal: null });
      }
      await noOrdinaryCleanup();
      expect(Date.now()).toBeLessThan(successCutoff);
      expect(logs.stdout.truncated || logs.stderr.truncated).toBe(false);
      diagnostics.phase = 'socket-cleanup';
      expect(await socket.remove()).toBe('closed');
      diagnostics.phase = 'verified';
      clean = true;
    } catch (error) {
      errors.push(error);
      if (!silent) {
        diagnostics.failedPhase = diagnostics.phase;
        console.warn(
          '[opencode-custody-self-exit]',
          JSON.stringify({ phase: diagnostics.failedPhase, exit: diagnostics.exit, closed })
        );
      }
      diagnostics.phase = 'failed';
    } finally {
      if (silent && root && !released) {
        try {
          await releaseWorker(root, 'proof-aborted');
          await joinRunner?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (positive) {
        try {
          expect(await until(positive.close(), Date.now() + 1000)).toEqual({
            code: 0,
            signal: null,
          });
        } catch (error) {
          errors.push(error);
          try {
            await until(positive.retire(), Date.now() + 1000);
          } catch (closeError) {
            errors.push(closeError);
          }
        }
      }
      capture = false;
      // This covers context/config resolution, spawn failure and every later throw.
      if (output) {
        try {
          await output.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (root && (!clean || errors.length > 0)) {
        for (const name of ['stdout', 'stderr'] as const) {
          try {
            await writeFile(join(root, `nested.${name}`), Buffer.concat(logs[name].chunks), {
              flag: 'wx',
              mode: 0o600,
            });
          } catch (error) {
            errors.push(error);
          }
        }
        diagnostics.logs = Object.fromEntries(
          Object.entries(logs).map(([name, log]) => [
            name,
            { total: log.total, retained: log.retained, truncated: log.truncated },
          ])
        );
        diagnostics.closed = closed;
        diagnostics.errors = errors.map((error) =>
          error instanceof Error
            ? {
                name: error.name.slice(0, 64),
                message: Buffer.from(error.message).subarray(0, 1024).toString(),
              }
            : { name: 'Unknown' }
        );
        let encoded = JSON.stringify(diagnostics) + '\n';
        if (Buffer.byteLength(encoded) > 8192)
          encoded =
            JSON.stringify({
              version: 1,
              phase: 'failed',
              diagnosticOverflow: true,
              closed,
              logs: diagnostics.logs,
              errorCount: errors.length,
            }) + '\n';
        try {
          await writeFile(join(root, 'nested-diagnostics.json'), encoded, {
            flag: 'wx',
            mode: 0o600,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      // Failure preserves owned diagnostics; no process-control fallback exists.
      if (root && clean && closed && errors.length === 0) {
        try {
          await rm(root, { recursive: true });
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Maintained nested runner fixture failed');
    if (silent) console.info('[opencode-custody-silent-worker]', JSON.stringify(diagnostics));
  };
}

/** Release the exact held fixture only, keeping an incomplete write invisible to its reader. */
async function releaseWorker(root: string, result: 'proof-observed' | 'proof-aborted') {
  const release = join(root, 'worker-release');
  await writeFile(release + '.part', result + '\n', { flag: 'wx', mode: 0o600 });
  await rename(release + '.part', release);
}

it.skipIf(!armed && !hostedLinuxX64)(
  'joins the pinned cohort after its nested runner exits itself',
  nestedFixture('self-exit'),
  30_000
);

it.skipIf(!armed || process.platform !== 'darwin' || process.arch !== 'arm64')(
  'joins the pinned cohort after runner exit while its macOS worker is still blocked',
  nestedFixture('silent-worker'),
  35_000
);

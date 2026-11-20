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
import { allocatePosixSocketDirectory } from '@dorkos/test-utils/run-custody/posix';
import { RUNTIME_ENV_PROFILES } from '../../../shared/runtime-environment-catalog.js';
import { pinnedOpenCode } from '../pinned-opencode.js';

const armed = process.env.DORKOS_OPENCODE_PINNED_SERVE_PROOF === '1';
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

it.skipIf(!armed)(
  'joins the pinned cohort after its nested runner exits itself',
  async () => {
    const deadline = Date.now() + 30000;
    let root: string | undefined;
    let output: FileHandle | undefined;
    let closed = false;
    let clean = false;
    let capture = true;
    const errors: unknown[] = [];
    const logs = {
      stdout: { chunks: [] as Buffer[], retained: 0, total: 0, truncated: false },
      stderr: { chunks: [] as Buffer[], retained: 0, total: 0, truncated: false },
    };
    const diagnostics: Record<string, unknown> = { version: 1, phase: 'preparing' };
    try {
      const flags = new Set(['OPENCODE_DISABLE_MODELS_FETCH', 'OPENCODE_DISABLE_AUTOUPDATE']);
      if (
        RUNTIME_ENV_PROFILES.OpenCode.some(
          (name) => !flags.has(name) && Object.hasOwn(process.env, name)
        )
      )
        throw new Error('Runner fixture refuses ambient OpenCode configuration');
      if (!pinnedOpenCode()) throw new Error('Pinned fixture unavailable');
      root = await realpath(await mkdtemp(join(tmpdir(), 'oc-re-')));
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
        JSON.stringify({ deadline, socketDirectory: socket.directory }),
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
      async function json(name: string) {
        const value = await readFile(join(ownedRoot, name));
        if (value.length > 4096) throw new Error('Owned receipt exceeds bound');
        return JSON.parse(value.toString());
      }
      async function noOrdinaryCleanup() {
        await expect(lstat(join(ownedRoot, 'normal-teardown-ran'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(lstat(join(ownedRoot, 'worker-fallback-started'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(await until(done, deadline)).toEqual({ code: 23, signal: null });
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
        kind: 'self-exit',
        code: 23,
        mainPid: runner.pid,
        workerPid: ready.workerPid,
      });
      expect(ready.target.kind).toBe('spawned');
      expect(ready.target.pid).toBeGreaterThan(0);
      let stat = await output.stat({ bigint: true });
      while (stat.size === 0n && Date.now() < deadline) {
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
      let worker;
      while (Date.now() < deadline) {
        try {
          worker = await json('worker-exit.json');
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await wait(25);
      }
      if (!worker) throw new Error('Missing owned worker exit receipt');
      expect(worker.version).toBe(1);
      expect(worker.workerPid).toBe(ready.workerPid);
      expect(worker.mainPid).toBe(runner.pid);
      expect(Number.isInteger(worker.code)).toBe(true);
      expect(worker.code).toBeGreaterThanOrEqual(0);
      expect(worker.code).toBeLessThanOrEqual(255);
      await noOrdinaryCleanup();
      expect(Date.now()).toBeLessThan(deadline - 1000);
      expect(logs.stdout.truncated || logs.stderr.truncated).toBe(false);
      expect(await socket.remove()).toBe('closed');
      diagnostics.phase = 'verified';
      clean = true;
    } catch (error) {
      errors.push(error);
      diagnostics.phase = 'failed';
    } finally {
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
  },
  30000
);

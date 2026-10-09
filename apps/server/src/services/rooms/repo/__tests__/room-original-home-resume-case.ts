import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Singleton runtime/Db bindings exist only in the original isolated child.
// Its fixed scenario asserts real post -> Trigger -> Runner placement and feed.
export type OriginalHomeResumeCase = 'opencode-copy' | 'opencode-home' | 'claude-copy';

/** Share the actual owned child lifecycle; test registration never supplies a native issuer. */
export function registerOriginalNativeHomeResumeCase(
  caseName: OriginalHomeResumeCase,
  title: string,
  /** Ordinary component DATA check; never sent to the native child/issuer. */
  beforeNativeCase?: () => void | Promise<void>
): void {
  describe('original native Room home/resume (' + caseName + ')', () => {
    let child: ChildProcess | undefined;
    let root: string;
    let failed: boolean;
    let first: unknown;
    let ended: Promise<void>;
    let stdoutEnded: Promise<void>;
    let stderrEnded: Promise<void>;
    let exitCode: number | null;
    let exitSeen: boolean;
    let closed: boolean;
    let ready: Promise<void>;
    let result: Promise<boolean>;
    let closePromise: Promise<void> | undefined;
    const output: Buffer[][] = [[], []];
    const saved = [0, 0];
    const remember = (cause: unknown) => {
      if (!failed) {
        failed = true;
        first = cause;
      }
    };
    beforeEach(async () => {
      failed = false;
      first = undefined;
      exitSeen = false;
      closed = false;
      exitCode = null;
      closePromise = undefined;
      output[0] = [];
      output[1] = [];
      saved[0] = 0;
      saved[1] = 0;
      root = await mkdtemp(path.join(tmpdir(), 'original-room-launch-child-'));
      child = fork(
        fileURLToPath(new URL('./room-original-home-resume-child.ts', import.meta.url)),
        [caseName],
        {
          execPath: process.execPath,
          execArgv: ['--import', import.meta.resolve('tsx')],
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: {
            PATH: process.env.PATH,
            HOME: root,
            TMPDIR: root,
            DORK_HOME: root,
            NODE_ENV: 'development',
            DORKOS_TEST_RUNTIME: 'true',
            DORKOS_BOUNDARY: root,
            DO_NOT_TRACK: '1',
            TELEMETRY_DISABLED: 'true',
            GIT_CONFIG_COUNT: '2',
            GIT_CONFIG_KEY_0: 'maintenance.auto',
            GIT_CONFIG_VALUE_0: 'false',
            GIT_CONFIG_KEY_1: 'gc.auto',
            GIT_CONFIG_VALUE_1: '0',
          },
        }
      );
      const streams = [child.stdout!, child.stderr!];
      [stdoutEnded, stderrEnded] = streams.map(
        (stream, index) =>
          new Promise<void>((resolve) => {
            stream.on('data', (chunk: Buffer) => {
              const room = 65536 - saved[index];
              if (chunk.length > room)
                remember(new Error('Original launch child output exceeded 64 KiB'));
              if (room > 0) {
                const keep = chunk.subarray(0, room);
                output[index].push(keep);
                saved[index] += keep.length;
              }
              // Keep draining after refusal; a full pipe cannot strand the original child.
            });
            stream.once('end', resolve);
            stream.once('error', (cause) => {
              remember(cause);
              resolve();
            });
          })
      );
      ended = new Promise<void>((resolve) => {
        child!.once('exit', (code, signal) => {
          exitSeen = true;
          exitCode = code;
          if (code !== 0 || signal !== null)
            remember(new Error(`Original launch child exit ${code}/${signal}`));
        });
        child!.once('error', remember);
        child!.once('close', () => {
          closed = true;
          resolve();
        });
      });
      ready = new Promise<void>((resolve, reject) => {
        child!.on('message', (message) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'phase' in message &&
            message.phase === 'ready'
          )
            resolve();
        });
        void ended.then(() =>
          reject(failed ? first : new Error('Original launch child closed before setup completed'))
        );
      });
      result = new Promise<boolean>((resolve, reject) => {
        child!.on('message', (message) => {
          if (
            typeof message === 'object' &&
            message !== null &&
            'phase' in message &&
            message.phase === 'result' &&
            'ok' in message
          )
            resolve(message.ok === true);
        });
        void ended.then(() =>
          reject(failed ? first : new Error('Original launch child closed before scenario result'))
        );
      });
      void result.catch(() => {});
      await ready;
    });
    afterEach(async () => {
      await (closePromise ??= (async () => {
        try {
          if (child?.connected)
            child.send('close', (cause) => {
              if (cause) remember(cause);
            });
          else if (child && !closed) child.kill();
        } catch (cause) {
          remember(cause);
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([ended, stdoutEnded, stderrEnded]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Original launch child did not drain within 2 seconds')),
                2000
              );
            }),
          ]);
        } catch (cause) {
          remember(cause);
          // A failed 2-second drain remains failed. Cancel only this owned child,
          // then retain it through real process/pipe closure; signal is not closure.
          try {
            if (child && !closed) child.kill();
          } catch (cause) {
            remember(cause);
          }
          await Promise.all([ended, stdoutEnded, stderrEnded]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (!exitSeen || !closed || exitCode !== 0)
          remember(new Error('Original launch child closure remains unresolved'));
        if (failed) {
          console.error(Buffer.concat(output[0]).toString(), Buffer.concat(output[1]).toString());
          throw first; // Keep root/native files on every unresolved or failed child.
        }
        await rm(root, { recursive: true, force: true });
      })());
    });
    it(title, async () => {
      try {
        await beforeNativeCase?.();
      } catch (cause) {
        remember(cause);
        throw first;
      }
      child!.send('run', (cause) => {
        if (cause) remember(cause);
      });
      expect(await result).toBe(true);
    });
  });
}

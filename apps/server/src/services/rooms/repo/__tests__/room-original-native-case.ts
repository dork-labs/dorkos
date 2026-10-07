import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Singleton runtime/Db bindings exist only in the original isolated child.
// Its fixed scenario asserts real post -> Trigger -> Runner placement and feed.
export type OriginalNativeLaunchCase =
  | 'launch'
  | 'runner-no-binding'
  | 'runner-unstarted-cancel-data'
  | 'runner-started-failed-data'
  | 'runner-delayed-start-data'
  | 'runner-own-tail-data'
  | 'runner-foreign-words-data'
  | 'runner-own-activity-data'
  | 'runner-foreign-approval-data'
  | 'runner-busy-disposition'
  | 'runner-stop-state-pair'
  | 'runner-approval-quick'
  | 'runner-approval-standing'
  | 'runner-approval-failed'
  | 'runner-approval-ended'
  | 'runner-late-answer'
  | 'runner-half-answer'
  | 'runner-clamped-ceiling'
  | 'runner-unclosed-ceiling'
  | 'runner-completion'
  | 'runner-stream-text'
  | 'runner-empty-text'
  | 'runner-content'
  | 'runner-paragraphs'
  | 'runner-token-counts'
  | 'runner-failed'
  | 'runner-quiet'
  | 'runner-no-files'
  | 'runner-framing'
  | 'runner-durable-error'
  | 'runner-durable-log'
  | 'runner-foreign-lock'
  | 'runner-optional-posting'
  | 'runner-false-posting'
  | 'runner-posting-home'
  | 'runner-turn-boundary'
  | 'runner-home-grants-attachments'
  | 'runner-projection-before-provider'
  | 'runner-measured-launch-context'
  | 'runner-accepted-no-files-context'
  | 'runner-bound-launch-context'
  | 'runner-owner-before-refresh'
  | 'runner-missing-runtime'
  | 'runner-no-fallback'
  | 'runner-observer-failure'
  | 'runner-bound-codex'
  | 'runner-first-codex'
  | 'runner-owner-before-provider'
  | 'runner-placeholder-codex'
  | 'runner-bound-halt'
  | 'runner-canonical-halt'
  | 'runner-canonical-owner'
  | 'runner-canonical-level'
  | 'runner-confirmed-stop'
  | 'runner-unconfirmed-stop'
  | 'runner-owner-write-failure'
  | 'runner-desk-guard'
  | 'runner-released-halt'
  | 'runner-new-then-reused'
  | 'runner-first-captured-halt'
  | 'runner-preaccepted-halt'
  | 'runner-remembered-halt'
  | 'runner-boot-stop'
  | 'runner-missing-halt'
  | 'merge-capability'
  | 'merge-config-refusal'
  | 'refresh-story'
  | 'placed-tip-change'
  | 'placed-dirty-counts'
  | 'refresh-baselines'
  | 'retired-id-busy'
  | 'busy-read-unknown'
  | 'second-bound-dispatcher-busy'
  | 'second-bound-runtime-lock'
  | 'app-resume-home'
  | 'app-resume-copy'
  | 'app-resume-label'
  | 'app-resume-credential-revoked'
  | 'app-resume-target-retired'
  | 'app-resume-no-repo'
  | 'app-resume-config-off'
  | 'app-resume-opencode-copy';

/** Share the actual owned child lifecycle; test registration never supplies a native issuer. */
export function registerOriginalNativeLaunchCase(
  caseName: OriginalNativeLaunchCase,
  title: string,
  /** Ordinary component DATA check; never sent to the native child/issuer. */
  beforeNativeCase?: () => void | Promise<void>
): void {
  describe('original native Room post worktree launch (' + caseName + ')', () => {
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
        fileURLToPath(new URL('./room-original-native-launch-child.ts', import.meta.url)),
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
      let phaseLine = '';
      let phaseReports = 0;
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
              if (index === 0) {
                try {
                  phaseLine += chunk.toString();
                  let newline: number;
                  while ((newline = phaseLine.indexOf('\n')) !== -1) {
                    const line = phaseLine.slice(0, newline);
                    phaseLine = phaseLine.slice(newline + 1);
                    const match =
                      /^ORIGINAL_NATIVE_SETUP_PHASE (module-ready|fixture-start|fixture-ready|setup-start|setup-ready) ([0-9]+)$/.exec(
                        line
                      );
                    if (match && phaseReports < 5) {
                      const elapsedMs = Number(match[2]);
                      if (Number.isSafeInteger(elapsedMs)) {
                        phaseReports++;
                        console.info('[original-native-setup-cost]', {
                          pid: child?.pid,
                          phase: match[1],
                          elapsedMs,
                        });
                      }
                    }
                  }
                  if (phaseLine.length > 128) phaseLine = '';
                } catch (cause) {
                  remember(cause);
                }
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

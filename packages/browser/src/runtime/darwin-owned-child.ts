import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { ProcessIdentity } from '../configuration.js';
import { sameProcess } from '../lifecycle/process-journal.js';
import { createDarwinProcessObserver, darwinBirth } from './darwin-process-observer.js';

const returnBrand = Symbol('Darwin original child return');
export interface DarwinOwnedChildReturn {
  readonly [returnBrand]: true;
}
export interface DarwinOwnedChildReceipt {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly firstCause: string | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}
export interface DarwinOwnedChild {
  /** Private supervisor IPC only; exposing this original is not a release grant. */
  readonly child: ChildProcess;
  identity(): Promise<ProcessIdentity>;
  completion(): Promise<DarwinOwnedChildReceipt>;
  returned(): Promise<DarwinOwnedChildReturn | null>;
  custody(): Readonly<{ pending: boolean; firstCause: string | null }>;
}
type OwnedState = { child: ChildProcess | null; pending: boolean; firstCause: string | null };
// These maps are module-private capabilities. Neither IPC JSON nor caller booleans
// can supply an original-child return, including after a supervisor/manager loss.
const ownership = new WeakMap<DarwinOwnedChild, OwnedState>();
const returns = new WeakMap<DarwinOwnedChildReturn, OwnedState>();
const retained = new Set<OwnedState>();

/** Check an actual local capability, never a structural receipt or reported PID. */
export function acceptsDarwinOwnedChildReturn(child: DarwinOwnedChild, returned: unknown): boolean {
  return (
    !!returned &&
    typeof returned === 'object' &&
    ownership.has(child) &&
    returns.get(returned as DarwinOwnedChildReturn) === ownership.get(child)
  );
}

/** Construct in the separate supervisor, using its genuine pinned native receiver. */
export function createDarwinOwnedChildLauncher(
  options: Readonly<{
    artifact: Readonly<{ path: string; sha256: string }>;
    manager: ProcessIdentity;
  }>
) {
  const observer = createDarwinProcessObserver(options.artifact);
  const manager = Object.freeze({ ...options.manager });
  return Object.freeze({
    async launch(
      command: Readonly<{
        executable: string;
        argv: readonly string[];
        cwd: string;
        env: Readonly<Record<string, string>>;
        ipc?: boolean;
      }>
    ): Promise<DarwinOwnedChild> {
      if (process.platform !== 'darwin' || process.pid === manager.pid)
        throw new Error('SUPERVISOR_PROCESS_REQUIRED');
      const initial = await observer.inspect([process.pid, manager.pid]);
      const supervisor = initial.processes.find(
        (fact) => fact.kind === 'present' && fact.identity.pid === process.pid
      );
      const observedManager = initial.processes.find(
        (fact) => fact.kind === 'present' && fact.identity.pid === manager.pid
      );
      if (
        !supervisor ||
        supervisor.kind !== 'present' ||
        supervisor.zombie ||
        !observedManager ||
        observedManager.kind !== 'present' ||
        observedManager.zombie ||
        !sameProcess(darwinBirth(observedManager.identity), manager)
      )
        throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
      const boot = `${initial.bootSeconds}:${initial.bootMicroseconds}`;
      const state: OwnedState = { child: null, pending: true, firstCause: null };
      retained.add(state); // Ownership exists before attempting the real acquisition.
      const fail = (cause: string) => {
        state.firstCause ??= cause;
      };
      let child: ChildProcess;
      try {
        child = spawn(command.executable, [...command.argv], {
          cwd: command.cwd,
          env: { ...command.env },
          shell: false,
          detached: false,
          stdio: command.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
        });
        state.child = child;
      } catch (error) {
        fail('CHILD_ACQUISITION_UNCERTAIN');
        throw error;
      }
      let exitObserved = false,
        closeObserved = false;
      let exitCode: number | null = null,
        signal: NodeJS.Signals | null = null;
      const terminal = new Promise<void>((resolve) => {
        child.on('error', () => fail('CHILD_ERROR'));
        child.once('exit', (code, killedBy) => {
          exitObserved = true;
          exitCode = code;
          signal = killedBy;
          if (killedBy) fail('CHILD_SIGNALED');
          else if (code !== 0) fail('CHILD_EXIT_FAILED');
        });
        child.once('close', (code, killedBy) => {
          closeObserved = true;
          if (!exitObserved || code !== exitCode || killedBy !== signal)
            fail('CHILD_TERMINAL_UNCERTAIN');
          resolve();
        });
      });
      const drain = (original: Readable | null) => {
        let eof = false,
          closed = false,
          overflow = false;
        const chunks: Uint8Array[] = [];
        let retainedBytes = 0;
        const completion = new Promise<Uint8Array>((resolve) => {
          if (!original) {
            fail('CHILD_PIPE_UNAVAILABLE');
            resolve(new Uint8Array());
            return;
          }
          // Install all original listeners before entering flowing mode. Overflow
          // still drains the real pipe; there is no destroy/kill replacement.
          original.once('end', () => {
            eof = true;
          });
          original.on('error', () => fail('CHILD_PIPE_ERROR'));
          original.once('close', () => {
            closed = true;
            if (!eof) fail('CHILD_PIPE_EOF_UNAVAILABLE');
            try {
              resolve(Buffer.concat(chunks));
            } catch {
              fail('CHILD_PIPE_RETENTION_UNAVAILABLE');
              resolve(new Uint8Array());
            }
          });
          original.on('data', (value: Buffer) => {
            if (overflow) return;
            if (value.byteLength > 256 * 1024 - retainedBytes) {
              overflow = true;
              fail('CHILD_PIPE_OVERFLOW');
              return;
            }
            try {
              const copy = Uint8Array.from(value);
              retainedBytes += copy.byteLength;
              chunks.push(copy);
            } catch {
              overflow = true;
              fail('CHILD_PIPE_RETENTION_UNAVAILABLE');
            }
          });
        });
        return { completion, complete: () => eof && closed };
      };
      const stdout = drain(child.stdout),
        stderr = drain(child.stderr);
      const identity = (async () => {
        if (!child.pid) throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
        const batch = await observer.inspect([process.pid, child.pid]);
        const parent = batch.processes.find(
          (fact) => fact.kind === 'present' && fact.identity.pid === process.pid
        );
        const fact = batch.processes.find(
          (fact) => fact.kind === 'present' && fact.identity.pid === child.pid
        );
        if (
          `${batch.bootSeconds}:${batch.bootMicroseconds}` !== boot ||
          !parent ||
          parent.kind !== 'present' ||
          parent.zombie ||
          !sameProcess(darwinBirth(parent.identity), darwinBirth(supervisor.identity)) ||
          !fact ||
          fact.kind !== 'present' ||
          fact.zombie ||
          fact.parentPid !== process.pid
        )
          throw new Error('PROCESS_OBSERVATION_UNAVAILABLE');
        return Object.freeze(darwinBirth(fact.identity));
      })();
      void identity.catch(() => fail('CHILD_BIRTH_UNAVAILABLE'));
      let token: DarwinOwnedChildReturn | null = null;
      const completion = (async () => {
        const [out, err] = await Promise.all([stdout.completion, stderr.completion, terminal]);
        let birth: ProcessIdentity | null = null;
        try {
          birth = await identity;
        } catch {
          fail('CHILD_BIRTH_UNAVAILABLE');
        }
        if (!exitObserved || !closeObserved || !stdout.complete() || !stderr.complete())
          fail('CHILD_RETURN_UNCERTAIN');
        if (birth) {
          try {
            const batch = await observer.inspect([birth.pid]);
            if (
              `${batch.bootSeconds}:${batch.bootMicroseconds}` !== boot ||
              batch.processes[0]?.kind !== 'absent'
            )
              fail('CHILD_NATIVE_RETURN_UNAVAILABLE');
          } catch {
            fail('CHILD_NATIVE_RETURN_UNAVAILABLE');
          }
        }
        if (state.firstCause === null && birth) {
          token = Object.freeze({ [returnBrand]: true as const });
          returns.set(token, state);
          state.pending = false;
          retained.delete(state);
        }
        return Object.freeze({
          exitCode,
          signal,
          firstCause: state.firstCause,
          stdout: out,
          stderr: err,
        });
      })();
      const handle: DarwinOwnedChild = Object.freeze({
        child,
        identity: () => identity,
        completion: () => completion,
        returned: async () => {
          await completion;
          return token;
        },
        custody: () => Object.freeze({ pending: state.pending, firstCause: state.firstCause }),
      });
      ownership.set(handle, state);
      return handle;
    },
  });
}

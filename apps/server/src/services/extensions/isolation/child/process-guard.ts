/**
 * ProcessGuard: an isolated extension may signal only itself (DOR-2686).
 *
 * Node's permission model does not gate signals, and the extension shares
 * this realm's `process`. Unlocked, `process.kill(process.ppid, 'SIGKILL')`
 * would stop DorkOS outright, `process.kill(process.ppid, 'SIGUSR1')` would
 * open DorkOS's V8 inspector (with DorkOS's full authority) to any local
 * process, and `process.kill(0, …)` would signal DorkOS's whole process group.
 * `os.setPriority` on another process id is ungated too.
 *
 * So, installed by the bootstrap before any extension code runs:
 *
 * - `process.kill` and the binding-backed `process._kill` behind it accept
 *   only the child's own process id; anything else (another id, `0`, a
 *   negative group id, a non-number) throws `ERR_EXTENSION_SIGNAL_DENIED`;
 * - `os.setPriority` accepts only no id, `0` or the child's own id.
 *
 * Both are locked (not writable, not configurable), and decisions use only
 * values captured at install. `process.abort()` stays: it ends only the child.
 *
 * @module services/extensions/isolation/child/process-guard
 */
import os from 'node:os';
import { apply, codedError, defineProperty } from './intrinsics.js';

/** Error code a refused signal carries. */
export const SIGNAL_DENIED_CODE = 'ERR_EXTENSION_SIGNAL_DENIED';

/** The message a refused signal carries. */
export const SIGNAL_REFUSAL = 'Isolated extensions can only signal themselves.';

let installed = false;

/**
 * Lock a property to a value for good.
 *
 * @param target - The object.
 * @param key - The property.
 * @param value - The replacement.
 */
function lock(target: object, key: PropertyKey, value: unknown): void {
  defineProperty(target, key, { value, writable: false, configurable: false, enumerable: true });
}

/** Install the guard. Idempotent. Must run before any extension code. */
export function installProcessGuard(): void {
  if (installed) return;
  installed = true;
  const self = process.pid;
  const refuse = (): never => {
    throw codedError(SIGNAL_DENIED_CODE, SIGNAL_REFUSAL);
  };
  // `process.kill` looks `process._kill` up at call time, so locking the raw
  // one to self-only also keeps the public one honest; both are locked.
  const rawKill = (process as unknown as { _kill?: (...a: unknown[]) => unknown })._kill;
  if (typeof rawKill === 'function') {
    lock(process, '_kill', function guardedRawKill(this: unknown, ...args: unknown[]) {
      if (args[0] !== self) refuse();
      return apply(rawKill, this, args);
    });
  }
  const kill = process.kill;
  lock(process, 'kill', function guardedKill(this: unknown, ...args: unknown[]) {
    if (args[0] !== self) refuse();
    return apply(kill, this, args);
  });
  const setPriority = os.setPriority;
  lock(os, 'setPriority', function guardedSetPriority(this: unknown, ...args: unknown[]) {
    // One argument is (priority) for this process; two are (pid, priority).
    if (args.length >= 2 && args[0] !== 0 && args[0] !== self) refuse();
    return apply(setPriority, this, args);
  });
}

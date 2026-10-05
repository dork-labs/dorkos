/**
 * A recording stand-in for `child_process.spawn`, so no test ever starts a real
 * caffeinate, systemd-inhibit or PowerShell.
 *
 * @module keep-awake/__tests__/fake-spawn
 */
import { EventEmitter } from 'node:events';
import type { ChildLike, HolderSpawnOptions, SpawnLike } from '../holders/types.js';

/** One fake holder process. */
export class FakeChild extends EventEmitter implements ChildLike {
  readonly pid: number;
  /** Every signal sent to it, in order. */
  readonly signals: NodeJS.Signals[] = [];
  /** Whether it has exited. */
  exited = false;
  /** When false, SIGTERM is ignored (only SIGKILL ends it). */
  exitsOnTerm = true;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exited) return false;
    if (signal === 'SIGKILL' || this.exitsOnTerm) this.exit(null, signal);
    return true;
  }

  /** End the process as the OS would. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  /** Fail the spawn as Node does for a missing program. */
  failToSpawn(code = 'ENOENT'): void {
    const err = Object.assign(new Error(`spawn ${code}`), { code });
    this.exited = true;
    this.emit('error', err);
  }
}

/** One recorded spawn. */
export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: HolderSpawnOptions;
  child: FakeChild;
}

/** A fake spawner plus everything it was asked to do, in one ordered log. */
export interface FakeSpawner {
  spawn: SpawnLike;
  calls: SpawnCall[];
  /** Ordered `spawn:<n>` and `kill:<n>:<signal>` entries across all children. */
  log: string[];
  /** The most recent child. */
  last(): FakeChild;
  /** Children that have not exited. */
  alive(): FakeChild[];
}

/**
 * Build a fake spawner.
 *
 * @param onSpawn - Optional hook run on each new child (e.g. to fail it).
 */
export function fakeSpawner(onSpawn?: (child: FakeChild, index: number) => void): FakeSpawner {
  const calls: SpawnCall[] = [];
  const log: string[] = [];
  const spawn: SpawnLike = (command, args, options) => {
    const index = calls.length;
    const child = new FakeChild(10_000 + index);
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals) => {
      log.push(`kill:${index}:${signal ?? 'SIGTERM'}`);
      return kill(signal);
    };
    calls.push({ command, args, options, child });
    log.push(`spawn:${index}`);
    onSpawn?.(child, index);
    return child;
  };
  return {
    spawn,
    calls,
    log,
    last: () => calls[calls.length - 1]!.child,
    alive: () => calls.map((c) => c.child).filter((c) => !c.exited),
  };
}

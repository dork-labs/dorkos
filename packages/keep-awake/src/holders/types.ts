/**
 * The shapes every OS adapter shares: what a holder is, how it is spawned, and
 * the vocabulary for why one cannot run.
 *
 * A holder is one long-lived OS process whose existence IS the "don't
 * idle-sleep" assertion. Each adapter only says which program to run with which
 * arguments; starting, renewing and stopping it is one piece of code in
 * `keep-awake.ts`, so the three platforms cannot drift apart on the parts that
 * have to be right everywhere (never a shell, always tied to the owner's pid,
 * always killed by the handle that spawned it).
 *
 * @module keep-awake/holders/types
 */

/** Why keep-awake cannot hold the computer awake here. */
export type UnsupportedReason =
  /** `/.dockerenv`, a container cgroup, or `$container` is set. */
  | 'container'
  /** The OS tool (caffeinate, systemd-inhibit, powershell) was not found. */
  | 'tool-missing'
  /** The tool ran and refused, or kept dying (polkit over SSH, for one). */
  | 'denied'
  /** An operating system with no adapter. */
  | 'platform';

/** Which OS mechanism holds the assertion. `none` when nothing can. */
export type Mechanism = 'caffeinate' | 'systemd-inhibit' | 'windows-execution-state' | 'none';

/**
 * The slice of a Node `ChildProcess` keep-awake uses, so tests can hand in a
 * fake without building a real one.
 */
export interface ChildLike {
  /** The OS process id, when the spawn got that far. */
  readonly pid?: number | undefined;
  /** Send a signal to the process. Returns false when it could not be sent. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Fires once when the process ends, with its code or the signal that ended it. */
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  /** Fires when the process could not be spawned (ENOENT) or could not be signalled. */
  once(event: 'error', listener: (err: Error) => void): this;
}

/** Spawn options keep-awake always passes. Never a shell; never detached. */
export interface HolderSpawnOptions {
  /** The holder writes nothing anyone reads. */
  stdio: 'ignore';
  /** A detached holder could outlive its owner's process group. */
  detached: false;
  /** No console window flashes on Windows. */
  windowsHide: true;
}

/** A `child_process.spawn` look-alike: program, argument vector, options. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: HolderSpawnOptions
) => ChildLike;

/** The program one platform runs to hold the assertion. */
export interface HolderCommand {
  /** Which mechanism this is, for status. */
  mechanism: Exclude<Mechanism, 'none'>;
  /** The program, absolute where the OS guarantees its location. */
  command: string;
  /** The argument vector, passed as-is with no shell in between. */
  args: string[];
  /**
   * Whether the holder ends itself after a timeout and must be renewed before
   * then. Only caffeinate does: its `-t` bounds an orphan, so it is renewed.
   */
  renews: boolean;
}

/** Minimal logger keep-awake writes to. */
export interface KeepAwakeLogger {
  /** Routine news: a holder started or stopped. */
  info(msg: string): void;
  /** Something did not work and status now says why. */
  warn(msg: string): void;
}

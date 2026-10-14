/**
 * One reference-counted "don't idle-sleep" assertion.
 *
 * Callers open a {@link Hold} for each piece of work and release it when the
 * work ends. The first open hold starts one holder process; the last release
 * starts a short linger, after which the holder is stopped. Back-to-back work
 * (a burst of replies, a chain of runs) therefore never flaps the assertion.
 *
 * The rules this module keeps, because it sits in the path of every agent
 * turn:
 *
 * - **It never throws** out of `hold`, `release` or `setEnabled`. A failure
 *   becomes a status (`supported: false` plus a reason) and one log line.
 * - **The count is always honest**, even while disabled or unsupported, so
 *   turning the setting back on mid-turn takes effect at once and status can
 *   say what is running.
 * - **A holder can never outlive its owner.** Every adapter watches the owner's
 *   pid, holders are killed through the handle that spawned them (SIGTERM, then
 *   SIGKILL after two seconds), and nothing is ever spawned through a shell.
 * - **No restart storms.** A holder that dies unexpectedly is restarted once;
 *   a second unexpected death within a minute, or a refusal as it starts, is a
 *   `denied` failure. A denial is not permanent: while a hold is wanted it is
 *   tried again on a backoff ({@link RETRY_BACKOFF_MS}), and turning the setting
 *   off and on tries again at once. Only what the environment rules out (a
 *   container, a missing tool, an operating system with no adapter) stays
 *   unsupported for the life of the process.
 *
 * @module keep-awake/keep-awake
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { detectEnvironment, holderCommandFor, type EnvironmentOptions } from './environment.js';
import type {
  ChildLike,
  HolderCommand,
  KeepAwakeLogger,
  Mechanism,
  SpawnLike,
  UnsupportedReason,
} from './holders/types.js';

/** A snapshot of keep-awake, for status displays. */
export interface KeepAwakeStatus {
  /** Whether this computer can be held awake right now. */
  supported: boolean;
  /** Why not, when `supported` is false. `denied` is temporary: it is retried. */
  reason?: UnsupportedReason;
  /** The mechanism in use, or that was tried. */
  mechanism: Mechanism;
  /** Holds currently open (counted even while disabled or unsupported). */
  holds: number;
  /** Whether the OS assertion is actually in force right now. */
  asserted: boolean;
  /** Open hold reasons, in acquisition order. Duplicates allowed. */
  reasons: string[];
}

/** One open hold. `release()` is idempotent; a second call is a no-op. */
export interface Hold {
  /** What the hold was opened for. */
  readonly reason: string;
  /** End this hold. Safe to call more than once and from more than one `finally`. */
  release(): void;
}

/** The keep-awake handle {@link createKeepAwake} returns. */
export interface KeepAwake {
  /** Open a hold. The first open hold starts the OS assertion (when enabled). */
  hold(reason: string): Hold;
  /** Turn the OS assertion on or off without losing the count. */
  setEnabled(enabled: boolean): void;
  /** The current state. */
  status(): KeepAwakeStatus;
  /**
   * Called after every status change (hold count, asserted, supported).
   * Returns the unsubscribe function.
   */
  onChange(listener: (status: KeepAwakeStatus) => void): () => void;
  /** Release the assertion and stop the holder process. Idempotent. */
  dispose(): Promise<void>;
}

/** Options for {@link createKeepAwake}. Every field has a sensible default. */
export interface KeepAwakeOptions extends EnvironmentOptions {
  /** The process whose death must end the assertion. Defaults to `process.pid`. */
  watchPid?: number;
  /** Delay between the last release and dropping the assertion. Default three minutes. */
  lingerMs?: number;
  /** caffeinate only: one holder's lifetime (`-t`). Default 300 s. */
  holderTtlSec?: number;
  /** caffeinate only: how often a holder is replaced. Default 240 000 ms. */
  renewEveryMs?: number;
  /** Whether the assertion may be taken at all. Default true. */
  enabled?: boolean;
  /** Spawns the holder. Defaults to `child_process.spawn`. */
  spawn?: SpawnLike;
  /** Where routine news and the one-per-reason warning go. Defaults to silence. */
  logger?: KeepAwakeLogger;
}

/** A holder that exits non-zero this soon after starting was refused, not crashed. */
const EARLY_FAILURE_MS = 1_000;
/** Two unexpected exits closer together than this mean "give up". */
const RESTART_WINDOW_MS = 60_000;
/** How long a holder gets to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * How long the assertion outlives the last hold. Three minutes, not seconds: an
 * agent's turns often come a minute or two apart (a reply, then the next one
 * after a tool or a person answers), and a computer that may idle-sleep in
 * every such gap stops the very work this exists to keep going.
 */
const DEFAULT_LINGER_MS = 3 * 60_000;
/**
 * The waits before trying a denied holder again, one per consecutive denial;
 * the last repeats. A refusal is often passing (a policy prompt, a busy power
 * daemon), so it is retried while a hold is wanted rather than believed forever.
 */
const RETRY_BACKOFF_MS: readonly number[] = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000];
const DEFAULT_TTL_SEC = 300;
const DEFAULT_RENEW_MS = 240_000;

const SILENT_LOGGER: KeepAwakeLogger = { info: () => {}, warn: () => {} };

/** The wording of the one warning each failure reason logs. */
const FAILURE_MESSAGES: Record<UnsupportedReason, string> = {
  container: 'running in a container; the host decides when it sleeps',
  'tool-missing': 'the sleep control tool is not installed',
  denied: 'the system refused the request to stay awake',
  platform: 'no sleep control for this operating system',
};

/** One spawned holder process and what is known about it. */
interface HolderRecord {
  child: ChildLike;
  command: HolderCommand;
  startedAt: number;
  /** Set when keep-awake itself is stopping it, so its exit is not a failure. */
  retiring: boolean;
  ended: boolean;
  /** Resolves once the process has ended (or could not start). */
  endedPromise: Promise<void>;
  resolveEnded: () => void;
}

function unref(handle: unknown): void {
  (handle as { unref?: () => void } | null)?.unref?.();
}

/**
 * Create a keep-awake handle for this process.
 *
 * Construction spawns nothing; the first {@link KeepAwake.hold} does.
 *
 * @param options - Tuning and injection seams; see {@link KeepAwakeOptions}.
 */
export function createKeepAwake(options: KeepAwakeOptions = {}): KeepAwake {
  const watchPid = options.watchPid ?? process.pid;
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS;
  const ttlSec = options.holderTtlSec ?? DEFAULT_TTL_SEC;
  const renewEveryMs = options.renewEveryMs ?? DEFAULT_RENEW_MS;
  const spawn: SpawnLike = options.spawn ?? (nodeSpawn as unknown as SpawnLike);
  const logger = options.logger ?? SILENT_LOGGER;
  const environment = detectEnvironment(options);

  const holds = new Map<symbol, string>();
  const listeners = new Set<(status: KeepAwakeStatus) => void>();
  const warned = new Set<UnsupportedReason>();
  let enabled = options.enabled ?? true;
  let supported = environment.mechanism !== 'none';
  let reason: UnsupportedReason | undefined = environment.reason;
  let current: HolderRecord | null = null;
  let lingerTimer: ReturnType<typeof setTimeout> | null = null;
  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive denials; picks the next wait from {@link RETRY_BACKOFF_MS}. */
  let denials = 0;
  /** The pending retry after a denial, while one is scheduled. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** The backoff ran out while nothing was wanted: the next hold tries at once. */
  let retryDue = false;
  let lastUnexpectedExitAt: number | null = null;
  let disposed = false;
  let lastEmittedKey = '';

  const status = (): KeepAwakeStatus => ({
    supported,
    ...(reason !== undefined ? { reason } : {}),
    mechanism: environment.mechanism,
    holds: holds.size,
    asserted: current !== null,
    reasons: [...holds.values()],
  });

  /** Tell listeners, once per real change; a throwing listener is logged, never propagated. */
  const notify = (): void => {
    const snapshot = status();
    const key = `${snapshot.holds}|${snapshot.asserted}|${snapshot.supported}|${snapshot.reason ?? ''}|${snapshot.reasons.join('\u0000')}`;
    if (key === lastEmittedKey) return;
    lastEmittedKey = key;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn(`[KeepAwake] a status listener threw: ${String(err)}`);
      }
    }
  };

  const clearRenew = (): void => {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = null;
  };

  const clearLinger = (): void => {
    if (lingerTimer) clearTimeout(lingerTimer);
    lingerTimer = null;
  };

  const clearRetry = (): void => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    retryDue = false;
  };

  /** Forget a denial: the next attempt finds out afresh. Environment failures are kept. */
  const clearDenial = (): void => {
    clearRetry();
    denials = 0;
    if (reason !== 'denied') return;
    supported = true;
    reason = undefined;
  };

  /**
   * Record that holding is not possible here, warning once per reason. A
   * `denied` is temporary and schedules the next try; anything else is what the
   * environment rules out and stays.
   */
  const markUnsupported = (why: UnsupportedReason, detail?: string): void => {
    supported = false;
    reason = why;
    if (why === 'denied') scheduleRetry();
    if (!warned.has(why)) {
      warned.add(why);
      logger.warn(
        `[KeepAwake] cannot keep this computer awake: ${FAILURE_MESSAGES[why]}` +
          (detail ? ` (${detail})` : '')
      );
    }
  };

  /** Stop one holder: SIGTERM now, SIGKILL if it has not exited after the grace period. */
  const retire = (record: HolderRecord): Promise<void> => {
    record.retiring = true;
    if (record === current) {
      current = null;
      clearRenew();
    }
    if (!record.ended) {
      try {
        record.child.kill('SIGTERM');
      } catch {
        // Already gone; the exit handler settles it.
      }
      const killTimer = setTimeout(() => {
        if (record.ended) return;
        try {
          record.child.kill('SIGKILL');
        } catch {
          // Nothing more can be done from here.
        }
        // A process that ignores even SIGKILL is not worth waiting on forever.
        record.ended = true;
        record.resolveEnded();
      }, KILL_GRACE_MS);
      unref(killTimer);
    }
    return record.endedPromise;
  };

  /** Try a denied holder again after the next backoff step. */
  function scheduleRetry(): void {
    clearRetry();
    const wait = RETRY_BACKOFF_MS[Math.min(denials, RETRY_BACKOFF_MS.length - 1)]!;
    denials += 1;
    retryTimer = setTimeout(onRetryDue, wait);
    unref(retryTimer);
  }

  /** The backoff ran out: try now when a hold is wanted, else on the next hold. */
  function onRetryDue(): void {
    retryTimer = null;
    try {
      if (disposed || reason !== 'denied') return;
      if (!enabled || holds.size === 0) {
        retryDue = true;
        return;
      }
      retryNow();
    } catch (err) {
      logger.warn(`[KeepAwake] could not try again: ${String(err)}`);
    }
  }

  /** Clear the denial (keeping its count) and start a holder. */
  function retryNow(): void {
    retryDue = false;
    supported = true;
    reason = undefined;
    logger.info('[KeepAwake] trying again to keep this computer awake');
    startHolder();
    notify();
  }

  const shouldHold = (): boolean =>
    !disposed && enabled && supported && (holds.size > 0 || lingerTimer !== null);

  const scheduleRenew = (record: HolderRecord): void => {
    clearRenew();
    if (!record.command.renews) return;
    renewTimer = setTimeout(renew, renewEveryMs);
    unref(renewTimer);
  };

  /** Spawn a holder and make it current. Never throws. */
  const startHolder = (): void => {
    if (environment.mechanism === 'none') return;
    const command = holderCommandFor(environment.mechanism, watchPid, ttlSec);
    let child: ChildLike;
    try {
      child = spawn(command.command, command.args, {
        stdio: 'ignore',
        detached: false,
        windowsHide: true,
      });
    } catch (err) {
      markUnsupported(
        (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'tool-missing' : 'denied',
        String(err)
      );
      return;
    }
    let resolveEnded = (): void => {};
    const endedPromise = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const record: HolderRecord = {
      child,
      command,
      startedAt: Date.now(),
      retiring: false,
      ended: false,
      endedPromise,
      resolveEnded,
    };
    current = record;
    child.once('error', (err) => onHolderEnd(record, err, null));
    child.once('exit', (code) => onHolderEnd(record, null, code));
    scheduleRenew(record);
    logger.info(`[KeepAwake] holding this computer awake (${command.mechanism})`);
  };

  /** Replace the current caffeinate holder before its `-t` runs out: new one first, then the old. */
  function renew(): void {
    renewTimer = null;
    try {
      const previous = current;
      if (!previous || !shouldHold()) return;
      // A holder that lived to be renewed worked: a later denial backs off from
      // the first step again.
      denials = 0;
      startHolder();
      void retire(previous);
      notify();
    } catch (err) {
      logger.warn(`[KeepAwake] renewal failed: ${String(err)}`);
    }
  }

  /** One holder ended. Decide whether that was expected, a refusal, or a crash. */
  function onHolderEnd(record: HolderRecord, err: Error | null, code: number | null): void {
    try {
      if (record.ended) return;
      record.ended = true;
      record.resolveEnded();
      if (record.retiring || record !== current) return;
      current = null;
      clearRenew();
      const now = Date.now();
      if (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        markUnsupported(errno === 'ENOENT' ? 'tool-missing' : 'denied', err.message);
      } else if (now - record.startedAt < EARLY_FAILURE_MS && code !== 0) {
        markUnsupported('denied', `exit code ${String(code)}`);
      } else if (
        code === 0 &&
        record.command.renews &&
        now - record.startedAt < (ttlSec * 1000) / 2
      ) {
        // caffeinate exits 0 at once when the pid it watches is already gone.
        // That is the owner ending, not the `-t` running out, and respawning
        // would only repeat it in a tight loop. Stop; status says nothing is held.
        logger.warn('[KeepAwake] the process being watched has ended; not holding');
      } else if (code === 0 && record.command.renews) {
        // caffeinate's own `-t` ran out before renewal fired (the timer was
        // late, typically because the computer slept anyway). Not a failure.
        if (shouldHold()) startHolder();
      } else if (lastUnexpectedExitAt !== null && now - lastUnexpectedExitAt < RESTART_WINDOW_MS) {
        markUnsupported('denied', 'the holder kept exiting');
      } else {
        lastUnexpectedExitAt = now;
        logger.warn('[KeepAwake] the sleep holder exited unexpectedly; restarting it once');
        if (shouldHold()) startHolder();
      }
      notify();
    } catch (caught) {
      logger.warn(`[KeepAwake] could not handle the holder exiting: ${String(caught)}`);
    }
  }

  const onLingerEnd = (): void => {
    lingerTimer = null;
    try {
      if (holds.size === 0 && current) {
        void retire(current);
        // A holder that ran until it was no longer needed worked: a later
        // denial starts the backoff from the beginning again.
        denials = 0;
      }
      notify();
    } catch (err) {
      logger.warn(`[KeepAwake] could not release: ${String(err)}`);
    }
  };

  const hold = (holdReason: string): Hold => {
    if (disposed) return { reason: holdReason, release: () => {} };
    const token = Symbol(holdReason);
    let released = false;
    try {
      holds.set(token, holdReason);
      clearLinger();
      if (enabled && supported && !current) startHolder();
      else if (enabled && retryDue && !current) retryNow();
      notify();
    } catch (err) {
      logger.warn(`[KeepAwake] could not open a hold: ${String(err)}`);
    }
    return {
      reason: holdReason,
      release: () => {
        if (released) return;
        released = true;
        try {
          if (!holds.delete(token)) return;
          if (holds.size === 0 && current && !disposed) {
            clearLinger();
            lingerTimer = setTimeout(onLingerEnd, lingerMs);
            unref(lingerTimer);
          }
          notify();
        } catch (err) {
          logger.warn(`[KeepAwake] could not release a hold: ${String(err)}`);
        }
      },
    };
  };

  const setEnabled = (next: boolean): void => {
    try {
      if (disposed || next === enabled) return;
      enabled = next;
      // Switching the setting off and on again is how a person asks for another
      // try, so it re-arms a denied holder at once, with the backoff reset.
      clearDenial();
      if (!next) {
        clearLinger();
        if (current) void retire(current);
      } else if (holds.size > 0 && supported && !current) {
        startHolder();
      }
      notify();
    } catch (err) {
      logger.warn(`[KeepAwake] could not change the setting: ${String(err)}`);
    }
  };

  const onChange = (listener: (snapshot: KeepAwakeStatus) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    clearLinger();
    clearRenew();
    clearRetry();
    const holder = current;
    if (holder) await retire(holder);
    notify();
    listeners.clear();
  };

  return { hold, setEnabled, status, onChange, dispose };
}

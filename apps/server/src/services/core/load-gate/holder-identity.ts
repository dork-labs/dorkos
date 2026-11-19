/**
 * Who owns a load-gate ticket or slot, and whether that owner is still running
 * (DOR-4209).
 *
 * A pid alone is not an identity: once a process exits, the system hands its
 * number to a new one, and a new process holding a dead job's number must not
 * inherit that job's place or slot. So every owner is recorded as its pid AND
 * the time it started, and an owner counts as live only while a process with
 * that pid exists and started at that time.
 *
 * Start times come from `ps -o lstart=`, which macOS and Linux both have (macOS
 * has no `/proc`). Only the start time is asked for, never a command line. `ps`
 * runs in UTC and the C locale, and its answer is read field by field as UTC, so
 * neither this process's time zone nor its locale moves the result. Where `ps`
 * cannot answer (Windows, or a failure), the check falls back to "a process with
 * that pid exists".
 *
 * `ps` is a synchronous call on the server's event loop, so each pid's answer is
 * kept for {@link START_TIME_CACHE_MS}: every check within one poll shares one
 * call per pid.
 *
 * @module services/core/load-gate/holder-identity
 */
import { execFileSync } from 'node:child_process';

/** A process that owns a ticket or a slot. */
export interface Holder {
  /** Its process id. */
  pid: number;
  /** When it started, in whole seconds since the epoch. */
  startedAt: number;
}

/** The operating-system facts the gate needs about other processes. */
export interface HolderProbe {
  /**
   * Whether a process with this pid exists.
   *
   * @param pid - The process to ask about.
   */
  isAlive(pid: number): boolean;
  /**
   * When the process with this pid started, in whole seconds since the epoch,
   * or `null` when that cannot be read.
   *
   * @param pid - The process to ask about.
   */
  startedAt(pid: number): number | null;
}

/**
 * How far two start times for the same process may differ. `ps` prints whole
 * seconds and the fallback for this process rounds its own, so one reading can
 * sit a second either side of another.
 */
const START_TIME_TOLERANCE_SECONDS = 2;

/**
 * How long one pid's start time is reused: just under the gate's 5-second poll,
 * so a poll costs at most one `ps` per pid, and a pid that dies and is reused is
 * read afresh by the next poll.
 */
export const START_TIME_CACHE_MS = 4_000;

/** How long one `ps` call may take before it counts as unanswered. */
const PS_TIMEOUT_MS = 2_000;

/**
 * The environment `ps` runs with: a fixed path, the C locale (macOS prints
 * `lstart` per locale), and UTC, so the printed time is UTC whatever zone this
 * server runs in.
 */
const PS_ENV = { PATH: '/bin:/usr/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' };

const MS_PER_SECOND = 1_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `Wed Nov 18 10:23:45 2026`, as `ps -o lstart=` prints it in the C locale. */
const LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/**
 * Read a `ps -o lstart=` time that `ps` printed in UTC.
 *
 * Read field by field rather than by `Date.parse`, which would read the text in
 * this process's own time zone.
 *
 * @param raw - What `ps` printed.
 * @returns Whole seconds since the epoch, or `null` when it is not that format.
 */
export function parseUtcLstart(raw: string): number | null {
  const match = LSTART.exec(raw.trim().replace(/\s+/g, ' '));
  if (!match) return null;
  const [, month, day, hours, minutes, seconds, year] = match;
  const monthIndex = MONTHS.indexOf(month!);
  if (monthIndex === -1) return null;
  const ms = Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds)
  );
  return ms / MS_PER_SECOND;
}

/**
 * Ask `ps` when a process started.
 *
 * @param pid - The process to ask about.
 * @returns Whole seconds since the epoch, or `null` when `ps` gave no answer.
 */
function psStartedAt(pid: number): number | null {
  try {
    const raw = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
      env: PS_ENV,
    });
    return parseUtcLstart(raw);
  } catch {
    return null;
  }
}

/** What a probe is built from, each replaceable in tests. */
export interface HolderProbeOptions {
  /** Reads one pid's start time; defaults to `ps`. Its answers are cached. */
  lookupStartedAt?: (pid: number) => number | null;
  /** Whether a pid exists; defaults to signal 0. */
  isAlive?: (pid: number) => boolean;
  /** The clock the cache ages by. */
  now?: () => number;
}

/** Whether a process with this pid exists, by sending it signal 0. */
function signalZero(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else. It is there; the
    // start-time check decides whether it is the owner.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A probe that keeps each pid's start time for {@link START_TIME_CACHE_MS}.
 *
 * @param options - The lookups and clock to use.
 */
export function createHolderProbe(options: HolderProbeOptions = {}): HolderProbe {
  const lookup = options.lookupStartedAt ?? psStartedAt;
  const now = options.now ?? Date.now;
  const cache = new Map<number, { at: number; startedAt: number | null }>();
  return {
    isAlive: options.isAlive ?? signalZero,
    startedAt(pid) {
      const at = now();
      const kept = cache.get(pid);
      if (kept && at - kept.at < START_TIME_CACHE_MS) return kept.startedAt;
      const startedAt = lookup(pid);
      // Old entries go as they are read again; the map holds one entry per pid seen.
      cache.set(pid, { at, startedAt });
      return startedAt;
    },
  };
}

/** The real operating system, with one shared cache for the whole server. */
export const systemHolderProbe: HolderProbe = createHolderProbe();

/**
 * This process as a holder: its pid and the start time `probe` reports for it,
 * or, when the probe cannot say, one worked out from how long it has run.
 *
 * @param probe - Where start times are read.
 */
export function selfHolder(probe: HolderProbe): Holder {
  const fromProbe = probe.startedAt(process.pid);
  const fromUptime = Math.round((Date.now() - process.uptime() * MS_PER_SECOND) / MS_PER_SECOND);
  return { pid: process.pid, startedAt: fromProbe ?? fromUptime };
}

/**
 * Whether a recorded holder is still the process running under its pid.
 *
 * @param holder - The recorded owner.
 * @param probe - Where process facts are read.
 * @param self - This process as a holder, so its own records never cost a `ps` call.
 */
export function holderIsLive(holder: Holder, probe: HolderProbe, self: Holder): boolean {
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return false;
  let started: number | null;
  if (holder.pid === self.pid) {
    started = self.startedAt;
  } else {
    if (!probe.isAlive(holder.pid)) return false;
    started = probe.startedAt(holder.pid);
  }
  // Alive, but its start time cannot be read: alive is all that is known.
  if (started === null) return true;
  return Math.abs(started - holder.startedAt) <= START_TIME_TOLERANCE_SECONDS;
}

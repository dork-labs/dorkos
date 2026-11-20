/**
 * The machine-wide load gate (DOR-4209): a heavy shell job waits here, in one
 * first-come line shared by every agent and every DorkOS process on the machine,
 * until the machine is quiet enough and a slot is free.
 *
 * The gate only ever makes a job wait. It decides nothing about whether a job
 * may run: a job that has waited `hardCapMinutes` runs anyway, and a job a
 * person lets through runs now. When the shared folder cannot be used (a full
 * disk, a broken folder), jobs wait in this server's own line instead
 * ({@link LocalLine}): one at a time, the load limit and the hard cap still
 * applied, so a failure never lets every waiting job through at once. When even
 * that fails (the settings cannot be read), the job runs. Each kind of failure
 * is logged once, naming no command. Jobs that ran through either fallback
 * report the outcome `gate-error`.
 *
 * What a waiting job is told about the line is counts only: its place, how many
 * are ahead, the load and the limit. It never learns which agents are ahead or
 * what they are running. Which agent and chat a job is for is kept here, in this
 * server's memory, for the person's own list ({@link LoadGate.waitingJobs}); the
 * shared folder never holds it.
 *
 * @module services/core/load-gate/load-gate
 */
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import { logger } from '../../../lib/logger.js';
import { classifyCommand } from './heavy-classifier.js';
import { JOB_LABEL } from './job-label.js';
import { LocalLine, type LocalPlace } from './local-line.js';
import { systemLoadSource, type LoadSource } from './load-source.js';
import {
  DEFAULT_LEASE_MS,
  TicketQueue,
  type AcquireLimits,
  type AcquireResult,
  type Ticket,
  type TicketPriority,
} from './ticket-queue.js';
import type { HolderProbe } from './holder-identity.js';

const MS_PER_MINUTE = 60_000;
/** How often a waiting job checks again, and a running job refreshes its slot. */
const DEFAULT_POLL_MS = 5_000;
/** How often a waiting job's caller hears how the wait is going. */
const DEFAULT_NOTICE_EVERY_MS = 60_000;
/** A record lasts this many polls without a heartbeat, and never less than the default lease. */
const LEASE_POLLS = 3;
/**
 * How long past the hard cap a running job's slot refreshes itself. By then it
 * has outlived every wait the gate would ever impose, so a slot nobody released
 * stops being kept fresh and the lease frees it. A job that really runs longer
 * keeps its slot by calling {@link HeldSlot.heartbeat}.
 */
const AUTO_BEAT_MARGIN_MS = DEFAULT_LEASE_MS;

/** How a waiting job is doing, as the job's own caller sees it. Counts only. */
export interface WaitStatus {
  /** Its place in line, counting from 1. */
  position: number;
  /** How many waiting jobs are ahead of it. */
  aheadCount: number;
  /** The five-minute load average now. */
  load: number;
  /** The load at or above which jobs wait. */
  maxLoad: number;
  /** How long it has waited so far. */
  waitedMs: number;
  /** Whether it has waited past `maxWaitMinutes`, when a person should hear about it. */
  pastMaxWait: boolean;
}

/**
 * Why a job is running: its turn came (or the gate is off), a person let it
 * through, it reached the hard cap, or the shared queue failed and it ran
 * through a fallback.
 */
export type WaitOutcome = 'ran' | 'let-through' | 'hard-cap' | 'gate-error';

/** A job that may run now. Call `release` when it finishes, however it finishes. */
export interface HeldSlot {
  /** How long it waited. */
  waitedMs: number;
  /** Why it is running. */
  outcome: WaitOutcome;
  /**
   * Refresh the slot's heartbeat now. The slot refreshes itself every poll until
   * a while past the hard cap; a job still running after that calls this.
   *
   * @returns `false` once the slot is released or was taken back from this job.
   */
  heartbeat: () => boolean;
  /** Give the slot back. Safe to call more than once; never throws. */
  release: () => void;
}

/** Who a job is for, kept in this server's memory only. */
export interface JobOwner {
  /** For the person's own list of waiting jobs only. */
  agentName?: string;
  /** For the person's own list of waiting jobs only. */
  chatId?: string;
  /** For the person's own list of waiting jobs only. */
  chatTitle?: string;
}

/** What a caller says about the heavy job it wants to run. */
export interface WaitRequest extends JobOwner {
  /** The program label from the classifier, such as `pnpm`. Never command text. */
  job: string;
  /** Defaults to `normal`. */
  priority?: TicketPriority;
}

/** A waiting job as the person sees it: the shared ticket, and who it is for when this server knows. */
export type WaitingJob = Ticket & JobOwner;

/** How one wait is run. */
export interface WaitOptions {
  /** Stops the wait: the ticket leaves the line and the wait rejects with an `AbortError`. */
  signal?: AbortSignal;
  /** Hears how the wait is going: once when it starts waiting, then every minute or so. */
  onWait?: (status: WaitStatus) => void | Promise<void>;
}

/** Everything the gate reads, each replaceable in tests. */
export interface LoadGateOptions {
  /** The current `runtimes.loadGate` settings, read again on every check. */
  config: () => LoadGateSettings;
  /** The shared queue folder; defaults to `/tmp/dorkos-load-gate-<uid>`. */
  dir?: string;
  /** How busy the machine is. */
  loadSource?: LoadSource;
  /** The wall clock. */
  now?: () => number;
  /** A monotonic clock the lease is timed on. */
  monoNow?: () => number;
  /** How often a waiting job checks again. */
  pollMs?: number;
  /** How often `onWait` is called while a job waits. */
  noticeEveryMs?: number;
  /** How the gate pauses between checks. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Process facts, for telling live owners from gone ones. */
  probe?: HolderProbe;
  /** Where the gate writes its few log lines. None carries command text. */
  log?: (line: string) => void;
}

/** The machine-wide load gate. */
export interface LoadGate {
  /**
   * Wait until a heavy job may run.
   *
   * @param request - The job's program label and who it is for.
   * @param options - Cancellation and progress.
   */
  waitForSlot(request: WaitRequest, options?: WaitOptions): Promise<HeldSlot>;
  /**
   * Classify a command and wait only if it is heavy.
   *
   * @param command - The shell command line.
   * @param request - Who it is for; the job label comes from the classifier.
   * @param options - Cancellation and progress.
   * @returns The held slot, or `null` when the command is light or the gate is off.
   */
  gateIfHeavy(
    command: string,
    request: JobOwner & { priority?: TicketPriority },
    options?: WaitOptions
  ): Promise<HeldSlot | null>;
  /**
   * Every waiting job, with who it is for where this server queued it. For the
   * person's own list only: never hand it to an agent.
   */
  waitingJobs(): WaitingJob[];
}

/** One line a job can wait in: the shared one, or this server's own. */
interface Line {
  /** Start the job now if it may, returning its slot. */
  attempt(settings: LoadGateSettings, load: number, waitedMs: number): HeldSlot | null;
  /** Start it regardless: the hard cap. */
  force(settings: LoadGateSettings, waitedMs: number): HeldSlot;
  /** Its place, counting from 1, or 0 when it has none this instant. */
  position(): number;
  /** Leave without starting. Never throws. */
  leave(): void;
}

/** The error a stopped wait rejects with. */
function abortError(): DOMException {
  return new DOMException('The wait for a heavy-job slot was stopped.', 'AbortError');
}

const isAbort = (error: unknown): boolean => (error as Error | undefined)?.name === 'AbortError';

/** A short, fixed name for what went wrong: an error code or class, never a message. */
function errorKind(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  return error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'unknown';
}

/** How a log line names a job: its program, or nothing when the label is not one. */
const jobPhrase = (job: string): string => (JOB_LABEL.test(job) ? `A ${job} job` : 'A heavy job');

/** The wait after which a job runs anyway. The notice always comes first. */
const hardCapMs = (settings: LoadGateSettings): number =>
  Math.max(settings.hardCapMinutes, settings.maxWaitMinutes) * MS_PER_MINUTE;

/** Wait `ms`, or reject at once with an `AbortError` when `signal` fires. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A slot that holds nothing in the shared folder; `release` runs `onRelease` once. */
function plainSlot(outcome: WaitOutcome, waitedMs: number, onRelease = (): void => {}): HeldSlot {
  let released = false;
  return {
    waitedMs,
    outcome,
    heartbeat: () => !released,
    release: () => {
      if (released) return;
      released = true;
      onRelease();
    },
  };
}

/**
 * Create the load gate. Nothing touches the disk until the first heavy job asks.
 *
 * @param options - The settings getter, and anything a test replaces.
 */
export function createLoadGate(options: LoadGateOptions): LoadGate {
  const loadSource = options.loadSource ?? systemLoadSource;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const noticeEveryMs = options.noticeEveryMs ?? DEFAULT_NOTICE_EVERY_MS;
  const sleep = options.sleep ?? abortableSleep;
  const log = options.log ?? ((line: string) => logger.warn(line));
  const leaseMs = Math.max(DEFAULT_LEASE_MS, LEASE_POLLS * pollMs);
  const owners = new Map<string, JobOwner>();
  const local = new LocalLine();
  const failuresLogged = new Set<string>();
  let queue: TicketQueue | undefined;

  const openQueue = (): TicketQueue =>
    (queue ??= new TicketQueue({
      ...(options.dir === undefined ? {} : { dir: options.dir }),
      ...(options.probe === undefined ? {} : { probe: options.probe }),
      ...(options.monoNow === undefined ? {} : { monoNow: options.monoNow }),
      now,
      leaseMs,
      log,
    }));

  /** Log a failure once per kind until the shared queue works again. */
  const noteFailure = (consequence: string, error: unknown): void => {
    const kind = errorKind(error);
    if (failuresLogged.has(`${consequence}:${kind}`)) return;
    failuresLogged.add(`${consequence}:${kind}`);
    log(`[LoadGate] ${consequence} (${kind})`);
  };

  /** Take a ticket out of line, swallowing any failure so it never hides the reason it left. */
  const leaveQuietly = (ticket: Ticket): void => {
    owners.delete(ticket.id);
    try {
      openQueue().release(ticket);
    } catch {
      // The folder failing too; other readers let it go once it is quiet.
    }
  };

  const heldSlot = (
    ticket: Ticket,
    outcome: WaitOutcome,
    waitedMs: number,
    settings: LoadGateSettings
  ): HeldSlot => {
    const held = openQueue();
    owners.delete(ticket.id);
    const beatUntil = now() + hardCapMs(settings) + AUTO_BEAT_MARGIN_MS;
    let released = false;
    let taken = false;
    const beat = (): boolean => {
      if (released || taken) return false;
      if (held.beat(ticket)) return true;
      taken = true;
      log(`[LoadGate] ${jobPhrase(ticket.job)} lost its slot while it ran`);
      return false;
    };
    const timer = setInterval(() => {
      if (now() <= beatUntil) {
        if (!beat()) clearInterval(timer);
        return;
      }
      // Past the bound: stop keeping it fresh, and stop vouching for it here.
      clearInterval(timer);
      held.disown(ticket);
    }, pollMs);
    // A job's own process decides when it ends; this timer never keeps it alive.
    timer.unref?.();
    return {
      waitedMs,
      outcome,
      heartbeat: beat,
      release: () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          held.release(ticket);
        } catch (error) {
          log(
            `[LoadGate] ${jobPhrase(ticket.job)} finished, but its slot was not given back (${errorKind(error)})`
          );
        }
      },
    };
  };

  const report = (onWait: WaitOptions['onWait'], status: WaitStatus): void => {
    const failed = (): void => log('[LoadGate] A wait progress handler failed');
    try {
      const result = onWait?.(status);
      if (result instanceof Promise) result.catch(failed);
    } catch {
      failed();
    }
  };

  /** One attempt to start, putting a ticket that went missing back in line first. */
  const acquireOnce = (ticket: Ticket, limits: AcquireLimits): AcquireResult => {
    const live = openQueue();
    live.beat(ticket);
    const first = live.tryAcquire(ticket, limits);
    if (first !== 'lost') return first;
    // Its file went (a lease missed while this process was busy, or a temp cleaner):
    // back in line at its own number, so it keeps its place and its start time.
    live.rejoin(ticket);
    return live.tryAcquire(ticket, limits);
  };

  const sharedLine = (ticket: Ticket): Line => ({
    attempt: (settings, load, waitedMs) => {
      const result = acquireOnce(ticket, {
        slots: settings.slots,
        load,
        maxLoad: settings.maxLoad,
      });
      if (result === 'slot') return heldSlot(ticket, 'ran', waitedMs, settings);
      if (result === 'let-through') return heldSlot(ticket, 'let-through', waitedMs, settings);
      return null;
    },
    force: (settings, waitedMs) => {
      openQueue().forceAcquire(ticket);
      return heldSlot(ticket, 'hard-cap', waitedMs, settings);
    },
    position: () => openQueue().position(ticket),
    leave: () => leaveQuietly(ticket),
  });

  const localLine = (place: LocalPlace): Line => ({
    attempt: (settings, load, waitedMs) =>
      local.tryStart(place, load < settings.maxLoad)
        ? plainSlot('gate-error', waitedMs, () => local.finish())
        : null,
    force: (_settings, waitedMs) => {
      local.forceStart(place);
      return plainSlot('hard-cap', waitedMs, () => local.finish());
    },
    position: () => local.position(place),
    leave: () => local.leave(place),
  });

  /** Check until the job may run. Throws on abort, and on any failure of the line. */
  async function waitTurn(
    line: Line,
    job: string,
    startedAt: number,
    opts: WaitOptions
  ): Promise<HeldSlot> {
    let nextNotice = startedAt;
    for (;;) {
      if (opts.signal?.aborted) throw abortError();
      const settings = options.config();
      const waitedMs = now() - startedAt;
      if (!settings.enabled) {
        line.leave();
        return plainSlot('ran', waitedMs);
      }
      const load = loadSource.fiveMinute();
      const started = line.attempt(settings, load, waitedMs);
      if (started !== null) return started;
      if (waitedMs >= hardCapMs(settings)) {
        const forced = line.force(settings, waitedMs);
        log(
          `[LoadGate] ${jobPhrase(job)} ran after waiting ${Math.round(waitedMs / MS_PER_MINUTE)} min, the hard cap`
        );
        return forced;
      }
      const position = now() >= nextNotice ? line.position() : 0;
      // Not in line this instant (it rejoins on the next check): no place to report.
      if (position > 0) {
        report(opts.onWait, {
          position,
          aheadCount: position - 1,
          load,
          maxLoad: settings.maxLoad,
          waitedMs,
          pastMaxWait: waitedMs >= settings.maxWaitMinutes * MS_PER_MINUTE,
        });
        nextNotice = now() + noticeEveryMs;
      }
      await sleep(pollMs, opts.signal);
    }
  }

  /** Wait in this server's own line, after the shared one failed. Runs the job if this fails too. */
  async function waitHere(job: string, startedAt: number, opts: WaitOptions): Promise<HeldSlot> {
    const place = local.join();
    try {
      return await waitTurn(localLine(place), job, startedAt, opts);
    } catch (error) {
      if (isAbort(error)) throw error;
      noteFailure('The load gate could not wait; heavy jobs run without waiting', error);
      return plainSlot('gate-error', now() - startedAt);
    } finally {
      local.leave(place);
    }
  }

  async function waitForSlot(request: WaitRequest, opts: WaitOptions = {}): Promise<HeldSlot> {
    if (opts.signal?.aborted) throw abortError();
    const startedAt = now();
    let ticket: Ticket | undefined;
    try {
      if (!options.config().enabled) return plainSlot('ran', 0);
      ticket = openQueue().enqueue({
        job: request.job,
        ...(request.priority === undefined ? {} : { priority: request.priority }),
      });
      // The shared queue works again: a later failure is news again.
      failuresLogged.clear();
      owners.set(ticket.id, {
        ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        ...(request.chatId === undefined ? {} : { chatId: request.chatId }),
        ...(request.chatTitle === undefined ? {} : { chatTitle: request.chatTitle }),
      });
      return await waitTurn(sharedLine(ticket), request.job, startedAt, opts);
    } catch (error) {
      if (ticket !== undefined) leaveQuietly(ticket);
      if (isAbort(error)) throw error;
      noteFailure(
        "The shared load-gate queue could not be used; heavy jobs wait in this server's own line, one at a time",
        error
      );
      return waitHere(request.job, startedAt, opts);
    }
  }

  return {
    waitForSlot,
    async gateIfHeavy(command, request, opts) {
      let settings: LoadGateSettings | null;
      try {
        settings = options.config();
      } catch {
        // Unreadable settings: classify with the built-in list; the wait itself fails open.
        settings = null;
      }
      if (settings?.enabled === false) return null;
      const classification = classifyCommand(command, settings?.heavyCommands);
      if (!classification.heavy || classification.reason === undefined) return null;
      return waitForSlot({ ...request, job: classification.reason }, opts);
    },
    waitingJobs() {
      try {
        return openQueue()
          .list()
          .map((ticket) => ({ ...ticket, ...owners.get(ticket.id) }));
      } catch {
        return [];
      }
    },
  };
}

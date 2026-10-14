/**
 * The DorkOS half of keep-awake (spec `keep-awake`, DOR-2718): when to hold the
 * computer awake, what the setting says, and what the app is told.
 *
 * `@dorkos/keep-awake` owns the OS mechanics and knows nothing about DorkOS.
 * This service opens one package hold per unit of work and keeps a small record
 * beside each so status can say what the work is:
 *
 * - **turn** — every agent turn, opened by the registry wrapper
 *   (`hold-during-turn.ts`) whoever started it, including a turn the agent
 *   starts on its own when a helper reports back. A turn sent with `roomTurn` is
 *   a room reply; every other turn is a chat. A turn that ends while the agent
 *   still holds background work stays held until that work is done: the reply
 *   is not the end of the work. A working helper holds for as long as the
 *   runtime says it works (the runtime caps that); anything else (a background
 *   shell, a timer) holds for at most {@link BACKGROUND_ONLY_CEILING_MS}.
 * - **task** — a task run, opened by the scheduler around the whole run, so
 *   placement and provisioning are covered before any turn starts.
 *
 * **Every unit of work counts once.** A turn whose session belongs to a running
 * task is that task, not also a chat. The run learns its session id the moment
 * its dispatch path picks one ({@link TaskAwakeHold.attachSession}); until then
 * the label can lag for an instant, but the assertion is already held.
 *
 * Beside the work, the service owns two holds of its own (DOR-2920): `manual`,
 * open while a timed session runs or the mode is `always`, and `display`, a
 * screen-level companion open while anything else is held and the person asked
 * for the screen too. The rules for both, and for the power rules that pause
 * everything on battery, are pure functions in `keep-awake-policy.ts`.
 *
 * **The service is a singleton constructed before boot finishes**, counting
 * only, so turns on runtimes registered early are counted. {@link start} creates
 * the holder once the config exists; holds already open carry over.
 *
 * **Nothing here can break a turn.** Every entry point a turn passes through is
 * contained and falls back to a no-op hold.
 *
 * @module services/core/keep-awake/keep-awake-service
 */
import { outsideAuditScope } from '../../audit/audit-context.js';
import {
  createKeepAwake,
  readPower,
  type Hold,
  type KeepAwake,
  type PowerReading,
} from '@dorkos/keep-awake';
import type { KeepAwakeBlocked, KeepAwakeStatus } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';
import {
  activeSessionUntil,
  DEFAULT_KEEP_AWAKE_SETTINGS,
  hasPowerRule,
  holdsForWork,
  holdsWithoutWork,
  powerBlock,
  readKeepAwakeSettings,
  type KeepAwakeSettings,
} from './keep-awake-policy.js';

/** The hold a turn keeps open while its stream runs. */
export interface TurnAwakeHold {
  /** The turn produced an event; resets its idle clock. */
  touch(): void;
  /** The turn ended. Idempotent. */
  release(): void;
}

/** The hold a task run keeps open from start to finish. */
export interface TaskAwakeHold {
  /** The session this run's turn runs under, once its dispatch path picks one. */
  attachSession(sessionId: string): void;
  /** The run ended. Idempotent. */
  release(): void;
}

/** What the scheduler needs from keep-awake: one hold per run. */
export interface TaskAwakeHolds {
  /** Open the hold for one run. Never throws. */
  holdTask(runId: string): TaskAwakeHold;
}

/** A turn, as the registry wrapper describes it. */
export interface TurnDescriptor {
  /** The session the turn runs under. */
  sessionId: string;
  /** Whether it is a room reply (`opts.roomTurn` was set). */
  room: boolean;
  /**
   * The agent started this turn on its own, so nothing says whether it is a
   * room reply. It takes the label of the session's turn still held for its
   * background work, which is the work it is reporting on.
   */
  selfStarted?: boolean;
  /**
   * Whether the runtime says a helper (a background subagent) is still working
   * in this session. Asked only by the idle ceiling.
   */
  isHelperWorking?: () => boolean;
  /**
   * Whether the agent still holds background work that may continue after the
   * turn ends (`AgentRuntime.holdsBackgroundWork`). Asked when the turn ends and
   * on every sweep after; absent reads as "no".
   */
  holdsBackgroundWork?: () => boolean;
}

/** What {@link KeepAwakeService.start} needs from the server. */
export interface KeepAwakeStartDeps {
  /** Reads the current `keepAwake` section. */
  readSettings: () => Partial<KeepAwakeSettings>;
  /** Subscribes to settings writes; returns the unsubscribe. */
  onSettingsChange: (listener: (sections: readonly string[]) => void) => () => void;
  /** Pushes status to the app (`keep_awake_status` on the global stream). */
  broadcast: (status: KeepAwakeStatus) => void;
  /** Builds the package handle. A test seam; production uses the real one. */
  createKeepAwake?: typeof createKeepAwake;
  /** Reads the power source. A test seam; production uses the package's. */
  readPower?: () => Promise<PowerReading | null>;
}

/** A turn idle this long, with no helper working, is released by the sweep. */
export const TURN_IDLE_CEILING_MS = 2 * 60 * 60 * 1000;
/**
 * How long a turn is held after it ends for background work that is not a
 * working helper: a server left in a background shell, a wake-up timer. Such
 * work can run for hours without the agent needing the computer, so it keeps
 * the computer up only long enough to cover a short job.
 */
export const BACKGROUND_ONLY_CEILING_MS = 20 * 60 * 1000;
/**
 * How often the sweep runs: the idle ceiling, and the check that lets go of a
 * turn whose background work has finished. A minute late is well inside the
 * package's linger, so the computer never sleeps early because of it.
 */
const SWEEP_EVERY_MS = 60_000;
/** At most one status broadcast per this many milliseconds. */
const BROADCAST_COALESCE_MS = 500;
/** The longest `setTimeout` accepts; a later timer end is re-armed when it fires. */
const MAX_TIMER_MS = 2_147_483_647;

interface TurnRecord {
  kind: 'turn';
  sessionId: string;
  room: boolean;
  lastActivityAt: number;
  isHelperWorking?: () => boolean;
  holdsBackgroundWork?: () => boolean;
  /**
   * The turn's stream has ended but its background work has not. Kept held
   * until the sweep sees the work done; `lastActivityAt` is the turn's end.
   */
  background: boolean;
  hold: Hold | null;
  released: boolean;
  /**
   * Released by the idle ceiling rather than by the turn ending. A turn that
   * produces an event after that (a long approval wait that was finally
   * answered) is still running, so it is held again.
   */
  swept: boolean;
}

interface TaskRecord {
  kind: 'task';
  runId: string;
  sessionId: string | null;
  hold: Hold | null;
  released: boolean;
}

type WorkRecord = TurnRecord | TaskRecord;

const NO_OP_TURN: TurnAwakeHold = { touch: () => {}, release: () => {} };
const NO_OP_TASK: TaskAwakeHold = { attachSession: () => {}, release: () => {} };

/** Ask a runtime probe; a missing probe, or one that throws, reads as "no". */
function probe(question: (() => boolean) | undefined): boolean {
  try {
    return question?.() === true;
  } catch {
    return false;
  }
}

/** The package hold reason for a record. */
function holdReason(record: WorkRecord): string {
  return record.kind === 'task' ? 'task' : record.room ? 'room' : 'chat';
}

/**
 * Keeps the computer awake while agents work. One instance per process:
 * {@link keepAwakeService}.
 */
export class KeepAwakeService {
  private readonly records = new Set<WorkRecord>();
  private keepAwake: KeepAwake | null = null;
  private settings: KeepAwakeSettings = { ...DEFAULT_KEEP_AWAKE_SETTINGS };
  /** What the package was last told: hold when work or a session wants it. */
  private enabled = true;
  /** The service's own hold for a timed session or mode `always`. */
  private manualHold: Hold | null = null;
  /** The screen-level companion, open while anything else is held. */
  private displayHold: Hold | null = null;
  /** Fires when a timed session ends. */
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last power reading, while a power rule is set. */
  private power: PowerReading | null = null;
  private blocked: KeepAwakeBlocked | null = null;
  private powerReadInFlight = false;
  /** Whether anything was wanted at the last reconcile, to read power on the turn to wanted. */
  private wasWanted = false;
  private deps: KeepAwakeStartDeps | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private broadcastPending = false;

  /**
   * Create the holder and start reporting. Holds opened before this carry over.
   * Safe to call once; a second call is ignored.
   *
   * @param deps - Settings, the broadcast, and an optional package factory.
   */
  start(deps: KeepAwakeStartDeps): void {
    if (this.keepAwake) return;
    this.deps = deps;
    this.settings = readKeepAwakeSettings(deps.readSettings);
    this.enabled = this.wantsEnabled(Date.now());
    const factory = deps.createKeepAwake ?? createKeepAwake;
    this.keepAwake = factory({
      watchPid: process.pid,
      enabled: this.enabled,
      logger: { info: (msg) => logger.debug(msg), warn: (msg) => logger.warn(msg) },
    });
    // The service's own holds first, so a screen-level start is not swapped up
    // to a moment after the work holds open at system level.
    this.reconcile();
    for (const record of this.records) record.hold = this.keepAwake.hold(holdReason(record));
    this.unsubscribeStatus = this.keepAwake.onChange(() => this.scheduleBroadcast());
    this.unsubscribeSettings = deps.onSettingsChange((sections) => {
      if (!sections.includes('keepAwake')) return;
      this.settings = readKeepAwakeSettings(deps.readSettings);
      if (!hasPowerRule(this.settings)) this.power = null;
      this.reconcile();
      void this.refreshPower();
      this.scheduleBroadcast();
    });
    this.sweepTimer = setInterval(
      outsideAuditScope(() => {
        this.sweepIdleTurns();
        void this.refreshPower();
      }),
      SWEEP_EVERY_MS
    );
    this.sweepTimer.unref?.();
    const initial = this.keepAwake.status();
    if (!initial.supported && initial.reason) {
      logger.info(
        `[KeepAwake] keeping this computer awake is not available here (${initial.reason})`
      );
    }
  }

  /** Stop the holder and every timer. Idempotent; holds stay counted but inert. */
  async stop(): Promise<void> {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.broadcastTimer = null;
    this.broadcastPending = false;
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    this.manualHold = null;
    this.displayHold = null;
    this.power = null;
    this.blocked = null;
    this.wasWanted = false;
    const keepAwake = this.keepAwake;
    this.keepAwake = null;
    this.deps = null;
    for (const record of this.records) record.hold = null;
    await keepAwake?.dispose();
  }

  /**
   * Open the hold for one agent turn. Never throws.
   *
   * @param turn - Which session, whether it is a room reply, and the runtime's
   *   helper probe for the idle ceiling.
   */
  holdTurn(turn: TurnDescriptor): TurnAwakeHold {
    try {
      const record: TurnRecord = {
        kind: 'turn',
        sessionId: turn.sessionId,
        room: turn.room || (turn.selfStarted === true && this.backgroundIsRoom(turn.sessionId)),
        lastActivityAt: Date.now(),
        ...(turn.isHelperWorking ? { isHelperWorking: turn.isHelperWorking } : {}),
        ...(turn.holdsBackgroundWork ? { holdsBackgroundWork: turn.holdsBackgroundWork } : {}),
        background: false,
        hold: null,
        released: false,
        swept: false,
      };
      this.open(record);
      return {
        touch: () => {
          record.lastActivityAt = Date.now();
          if (!record.swept) return;
          record.swept = false;
          record.released = false;
          this.open(record);
        },
        release: () => {
          record.swept = false;
          if (record.released || record.background) return;
          if (probe(record.holdsBackgroundWork)) {
            // The reply ended, the work did not: keep holding until the sweep
            // sees the background work finish. One such hold per session: a
            // newer one replaces the older, which stands for the same work.
            for (const other of [...this.records]) {
              if (
                other.kind === 'turn' &&
                other.background &&
                other.sessionId === record.sessionId
              ) {
                this.close(other);
              }
            }
            record.background = true;
            record.lastActivityAt = Date.now();
            return;
          }
          this.close(record);
        },
      };
    } catch (err) {
      logger.warn('[KeepAwake] could not count a turn', { err: String(err) });
      return NO_OP_TURN;
    }
  }

  /**
   * Open the hold for one task run. Never throws.
   *
   * @param runId - The run's id.
   */
  holdTask(runId: string): TaskAwakeHold {
    try {
      const record: TaskRecord = {
        kind: 'task',
        runId,
        sessionId: null,
        hold: null,
        released: false,
      };
      this.open(record);
      return {
        attachSession: (sessionId) => {
          if (record.released || record.sessionId === sessionId) return;
          record.sessionId = sessionId;
          this.scheduleBroadcast();
        },
        release: () => this.close(record),
      };
    } catch (err) {
      logger.warn('[KeepAwake] could not count a task run', { err: String(err) });
      return NO_OP_TASK;
    }
  }

  /**
   * Whether Codex should turn on its own `prevent_idle_sleep` as a second
   * layer: work would be held right now (the mode, or a timed session, and no
   * power rule pausing it) and this computer can be held awake.
   */
  preventsIdleSleep(): boolean {
    return this.keepAwake !== null && this.enabled && this.keepAwake.status().supported;
  }

  /**
   * Bring the service's own holds, the package's on/off, and the session timer
   * in line with the settings, the clock and the last power reading. Called
   * after every change to any of them. Never throws.
   */
  private reconcile(): void {
    const keepAwake = this.keepAwake;
    if (!keepAwake) return;
    try {
      const now = Date.now();
      const manual = holdsWithoutWork(this.settings, now);
      const wanted = this.isWanted(now);
      this.blocked = hasPowerRule(this.settings) ? powerBlock(this.settings, this.power) : null;
      const enabled = this.wantsEnabled(now);
      if (enabled !== this.enabled) {
        this.enabled = enabled;
        keepAwake.setEnabled(enabled);
      }
      // The companion opens before the hold it accompanies, so the holder
      // starts at screen level instead of being swapped up a moment later.
      const display = this.settings.keepDisplayAwake && (manual || this.records.size > 0);
      if (display && !this.displayHold) {
        this.displayHold = keepAwake.hold('display', { display: true });
      }
      if (manual && !this.manualHold) this.manualHold = keepAwake.hold('manual');
      if (!manual && this.manualHold) {
        this.manualHold.release();
        this.manualHold = null;
      }
      if (!display && this.displayHold) {
        this.displayHold.release();
        this.displayHold = null;
      }
      this.armSessionTimer(now);
      if (wanted && !this.wasWanted) void this.refreshPower();
      this.wasWanted = wanted;
    } catch (err) {
      logger.warn('[KeepAwake] could not apply the settings', { err: String(err) });
    }
  }

  /**
   * Whether anything wants the computer held right now: a timer or mode
   * `always`, or open work the mode (or a timer) allows. A power rule may still
   * be pausing it; this is the wish, not the outcome.
   *
   * @param now - The current time in milliseconds.
   */
  private isWanted(now: number): boolean {
    return (
      holdsWithoutWork(this.settings, now) ||
      (holdsForWork(this.settings, now) && this.records.size > 0)
    );
  }

  /**
   * Whether the package may hold at all: a timed session or the mode allows it
   * and no power rule is pausing it.
   *
   * @param now - The current time in milliseconds.
   */
  private wantsEnabled(now: number): boolean {
    return holdsForWork(this.settings, now) && this.blocked === null;
  }

  /** Re-arm the timer that ends the running timed session, if any. */
  private armSessionTimer(now: number): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer);
    this.sessionTimer = null;
    const until = activeSessionUntil(this.settings, now);
    if (!until) return;
    const wait = Math.min(Math.max(Date.parse(until) - now, 0) + 1, MAX_TIMER_MS);
    this.sessionTimer = setTimeout(() => {
      this.sessionTimer = null;
      this.reconcile();
      this.scheduleBroadcast();
    }, wait);
    this.sessionTimer.unref?.();
  }

  /**
   * Read the power source while a power rule is set and something is wanted,
   * then apply what it says. One read at a time; never throws.
   */
  async refreshPower(): Promise<void> {
    if (!this.keepAwake || this.powerReadInFlight || !hasPowerRule(this.settings)) return;
    if (!this.isWanted(Date.now())) return;
    this.powerReadInFlight = true;
    try {
      const reading = await (this.deps?.readPower ?? readPower)();
      if (!this.keepAwake || !hasPowerRule(this.settings)) return;
      this.power = reading;
      const before = this.blocked;
      this.reconcile();
      if (this.blocked !== before) {
        logger.info(
          this.blocked
            ? `[KeepAwake] letting this computer sleep: ${this.blocked === 'on-battery' ? 'it is on battery' : 'the battery is low'}`
            : '[KeepAwake] power is back within the rules; keeping this computer awake again'
        );
        this.scheduleBroadcast();
      }
    } catch (err) {
      logger.warn('[KeepAwake] could not read the power source', { err: String(err) });
    } finally {
      this.powerReadInFlight = false;
    }
  }

  /** The status the app reads. */
  status(): KeepAwakeStatus {
    const packageStatus = this.keepAwake?.status();
    const taskSessions = new Set<string>();
    let tasks = 0;
    for (const record of this.records) {
      if (record.kind !== 'task') continue;
      tasks += 1;
      if (record.sessionId) taskSessions.add(record.sessionId);
    }
    // A turn held only for its background work (one per session) does not
    // count beside a live turn on the same session: the turn the agent starts
    // when its helper reports back is that same work, not a second piece of it.
    const liveSessions = new Set<string>();
    for (const record of this.records) {
      if (record.kind === 'turn' && !record.background) liveSessions.add(record.sessionId);
    }
    let chats = 0;
    let rooms = 0;
    for (const record of this.records) {
      if (record.kind !== 'turn' || taskSessions.has(record.sessionId)) continue;
      if (record.background && liveSessions.has(record.sessionId)) continue;
      if (record.room) rooms += 1;
      else chats += 1;
    }
    const now = Date.now();
    const until = activeSessionUntil(this.settings, now);
    return {
      enabled: this.settings.mode !== 'off',
      mode: this.settings.mode,
      manual: until ? { until } : null,
      level: packageStatus?.level ?? null,
      blocked: this.isWanted(now) ? this.blocked : null,
      supported: packageStatus?.supported ?? true,
      reason: packageStatus?.reason ?? null,
      asserted: packageStatus?.asserted ?? false,
      working: { chats, rooms, tasks, waking: false },
      wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
    };
  }

  /**
   * Let go of turns whose work is over or presumed lost:
   *
   * - A turn held for background work after it ended is released once the
   *   runtime says that work is done, or {@link BACKGROUND_ONLY_CEILING_MS}
   *   after the turn ended while no helper is working (only a shell or a timer
   *   is left). A working helper keeps it held; the runtime caps how long a
   *   helper counts as working.
   * - Every live turn that has produced nothing for {@link TURN_IDLE_CEILING_MS}
   *   while no helper works in its session is released. This bounds the one
   *   leak the wrapper cannot see: a consumer that abandons a stream without
   *   ending it. That release is a bug report, not a feature, so it is logged
   *   as a warning. A released turn that turns out to be alive (it produces
   *   another event) is held again, and its eventual end releases it once.
   *
   * @param now - The current time; a test seam.
   */
  sweepIdleTurns(now: number = Date.now()): void {
    for (const record of [...this.records]) {
      if (record.kind !== 'turn') continue;
      if (record.background) {
        const done = !probe(record.holdsBackgroundWork);
        const onlyIdleWork =
          !probe(record.isHelperWorking) &&
          now - record.lastActivityAt >= BACKGROUND_ONLY_CEILING_MS;
        if (done || onlyIdleWork) this.close(record);
        continue;
      }
      if (now - record.lastActivityAt < TURN_IDLE_CEILING_MS) continue;
      if (probe(record.isHelperWorking)) continue;
      logger.warn('[KeepAwake] released a turn that produced nothing for two hours', {
        sessionId: record.sessionId,
      });
      this.close(record);
      record.swept = true;
    }
  }

  /** Whether the session's turn held for background work is a room reply. */
  private backgroundIsRoom(sessionId: string): boolean {
    for (const record of this.records) {
      if (record.kind === 'turn' && record.background && record.sessionId === sessionId) {
        return record.room;
      }
    }
    return false;
  }

  private open(record: WorkRecord): void {
    this.records.add(record);
    if (!this.keepAwake) {
      this.scheduleBroadcast();
      return;
    }
    this.reconcile();
    record.hold = this.keepAwake.hold(holdReason(record));
  }

  private close(record: WorkRecord): void {
    if (record.released) return;
    record.released = true;
    this.records.delete(record);
    try {
      if (record.hold) record.hold.release();
      else this.scheduleBroadcast();
    } catch (err) {
      logger.warn('[KeepAwake] could not release a hold', { err: String(err) });
    }
    this.reconcile();
  }

  /**
   * Push status now, then at most once per {@link BROADCAST_COALESCE_MS}: the
   * first change goes out at once, later ones inside the window fold into one
   * trailing broadcast carrying the latest state.
   */
  private scheduleBroadcast(): void {
    if (!this.deps) return;
    if (this.broadcastTimer) {
      this.broadcastPending = true;
      return;
    }
    this.sendBroadcast();
    this.broadcastTimer = setTimeout(() => this.onBroadcastWindowEnd(), BROADCAST_COALESCE_MS);
    this.broadcastTimer.unref?.();
  }

  private onBroadcastWindowEnd(): void {
    this.broadcastTimer = null;
    if (!this.broadcastPending) return;
    this.broadcastPending = false;
    this.scheduleBroadcast();
  }

  private sendBroadcast(): void {
    try {
      this.deps?.broadcast(this.status());
    } catch (err) {
      logger.warn('[KeepAwake] could not broadcast status', { err: String(err) });
    }
  }
}

/** The process-wide keep-awake service. */
export const keepAwakeService = new KeepAwakeService();

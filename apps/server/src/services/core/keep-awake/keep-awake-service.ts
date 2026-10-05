/**
 * The DorkOS half of keep-awake (spec `keep-awake`, DOR-2718): when to hold the
 * computer awake, what the setting says, and what the app is told.
 *
 * `@dorkos/keep-awake` owns the OS mechanics and knows nothing about DorkOS.
 * This service opens one package hold per unit of work and keeps a small record
 * beside each so status can say what the work is:
 *
 * - **turn** — every agent turn, opened by the registry wrapper
 *   (`hold-during-turn.ts`) whoever started it. A turn sent with `roomTurn` is a
 *   room reply; every other turn is a chat.
 * - **task** — a task run, opened by the scheduler around the whole run, so
 *   placement and provisioning are covered before any turn starts.
 *
 * **Every unit of work counts once.** A turn whose session belongs to a running
 * task is that task, not also a chat. The run learns its session id the moment
 * its dispatch path picks one ({@link TaskAwakeHold.attachSession}); until then
 * the label can lag for an instant, but the assertion is already held.
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
import { createKeepAwake, type Hold, type KeepAwake } from '@dorkos/keep-awake';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { logger } from '../../../lib/logger.js';

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
   * Whether the runtime says a helper (a background subagent) is still working
   * in this session. Asked only by the idle ceiling.
   */
  isHelperWorking?: () => boolean;
}

/** The `keepAwake` config section, as far as this service reads it. */
interface KeepAwakeSettings {
  whileAgentsWork: boolean;
}

/** What {@link KeepAwakeService.start} needs from the server. */
export interface KeepAwakeStartDeps {
  /** Reads the current `keepAwake` section. */
  readSettings: () => KeepAwakeSettings;
  /** Subscribes to settings writes; returns the unsubscribe. */
  onSettingsChange: (listener: (sections: readonly string[]) => void) => () => void;
  /** Pushes status to the app (`keep_awake_status` on the global stream). */
  broadcast: (status: KeepAwakeStatus) => void;
  /** Builds the package handle. A test seam; production uses the real one. */
  createKeepAwake?: typeof createKeepAwake;
}

/** A turn idle this long, with no helper working, is released by the sweep. */
export const TURN_IDLE_CEILING_MS = 2 * 60 * 60 * 1000;
/** How often the idle ceiling is checked. */
const SWEEP_EVERY_MS = 60_000;
/** At most one status broadcast per this many milliseconds. */
const BROADCAST_COALESCE_MS = 500;

interface TurnRecord {
  kind: 'turn';
  sessionId: string;
  room: boolean;
  lastActivityAt: number;
  isHelperWorking?: () => boolean;
  hold: Hold | null;
  released: boolean;
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
  private enabled = true;
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
    this.enabled = this.readEnabled();
    const factory = deps.createKeepAwake ?? createKeepAwake;
    this.keepAwake = factory({
      watchPid: process.pid,
      enabled: this.enabled,
      logger: { info: (msg) => logger.debug(msg), warn: (msg) => logger.warn(msg) },
    });
    for (const record of this.records) record.hold = this.keepAwake.hold(holdReason(record));
    this.unsubscribeStatus = this.keepAwake.onChange(() => this.scheduleBroadcast());
    this.unsubscribeSettings = deps.onSettingsChange((sections) => {
      if (!sections.includes('keepAwake')) return;
      const next = this.readEnabled();
      if (next === this.enabled) return;
      this.enabled = next;
      this.keepAwake?.setEnabled(next);
      this.scheduleBroadcast();
    });
    this.sweepTimer = setInterval(() => this.sweepIdleTurns(), SWEEP_EVERY_MS);
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
        room: turn.room,
        lastActivityAt: Date.now(),
        ...(turn.isHelperWorking ? { isHelperWorking: turn.isHelperWorking } : {}),
        hold: null,
        released: false,
      };
      this.open(record);
      return {
        touch: () => {
          record.lastActivityAt = Date.now();
        },
        release: () => this.close(record),
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
   * layer: the setting is on and this computer can be held awake.
   */
  preventsIdleSleep(): boolean {
    return this.keepAwake !== null && this.enabled && this.keepAwake.status().supported;
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
    let chats = 0;
    let rooms = 0;
    for (const record of this.records) {
      if (record.kind !== 'turn' || taskSessions.has(record.sessionId)) continue;
      if (record.room) rooms += 1;
      else chats += 1;
    }
    return {
      enabled: this.enabled,
      supported: packageStatus?.supported ?? true,
      reason: packageStatus?.reason ?? null,
      asserted: packageStatus?.asserted ?? false,
      working: { chats, rooms, tasks, waking: false },
      wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
    };
  }

  /**
   * Release every turn that has produced nothing for {@link TURN_IDLE_CEILING_MS}
   * while no helper works in its session. This bounds the one leak the wrapper
   * cannot see: a consumer that abandons a stream without ending it. A release
   * here is a bug report, not a feature, so it is logged as a warning.
   *
   * @param now - The current time; a test seam.
   */
  sweepIdleTurns(now: number = Date.now()): void {
    for (const record of [...this.records]) {
      if (record.kind !== 'turn') continue;
      if (now - record.lastActivityAt < TURN_IDLE_CEILING_MS) continue;
      let helperWorking: boolean;
      try {
        helperWorking = record.isHelperWorking?.() === true;
      } catch {
        helperWorking = false;
      }
      if (helperWorking) continue;
      logger.warn('[KeepAwake] released a turn that produced nothing for two hours', {
        sessionId: record.sessionId,
      });
      this.close(record);
    }
  }

  private readEnabled(): boolean {
    try {
      return this.deps?.readSettings().whileAgentsWork !== false;
    } catch {
      return true;
    }
  }

  private open(record: WorkRecord): void {
    this.records.add(record);
    if (this.keepAwake) record.hold = this.keepAwake.hold(holdReason(record));
    else this.scheduleBroadcast();
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

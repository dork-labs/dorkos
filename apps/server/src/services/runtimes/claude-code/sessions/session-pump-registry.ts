/**
 * Every warm claude-code process in this server, the ceiling on how many there
 * may be, and how long an unused one lives (spec `persistent-session-runtime`
 * §4.3-4.4, tasks 3.2 and 3.4).
 *
 * A {@link SessionPump} owns one session's process; this owns the set of them.
 * It is the thing that answers `getSessionWarmth` for a session it has never
 * heard of (`cold`, because there is no process), the thing that reaps one
 * without touching its record, and the thing shutdown reaches to make sure no
 * subprocess outlives DorkOS.
 *
 * ## Two bounds, and neither is session eviction
 *
 * `SESSIONS.MAX_SESSIONS` (50) counts session RECORDS and `SESSIONS.TIMEOUT_MS`
 * (30 min) retires them. Neither is what happens here. This bounds PROCESSES,
 * two ways at once:
 *
 * - **Time.** A session that has been WARM for `SESSIONS.WARM_IDLE_MS` with no
 *   turn opened is reaped. Invisible to the person: the record, the transcript
 *   and the conversation are untouched, and the next message resumes.
 * - **Count.** At `SESSIONS.MAX_WARM_SESSIONS` a new launch reclaims the least
 *   recently used WARM process rather than being refused, because warmth is a
 *   cache and LRU is what a cache does. A host where nothing is reclaimable —
 *   every process mid-turn or parked on a person — is still refused, which is
 *   the honest answer when the ceiling is genuinely all in use.
 *
 * Both ceilings are read at acquire time (see {@link AcquirePumpOptions}) so a
 * config change takes effect on the next launch rather than on a restart.
 *
 * ## The idle timer arms on the state change, not on the window close
 *
 * A pump reaches WARM three ways: an explicit `warm()` that never runs a turn, a
 * turn window closing, and a crash recovery that lands warm. `onStateChange` is
 * the one seam that sees all three, and it is the seam the pump's own contract
 * names for this ("arm the idle timer on the way into `warm`, disarm it on the
 * way into `running`"). Arming on the windower's `onWindowClose` instead would
 * cover only the middle case, and a session warmed but never dispatched to would
 * hold its subprocess for as long as the server ran — so windowing does not arm
 * anything, and this is the single authoritative arming point.
 *
 * Per-pump timers rather than a sweep on the health-check interval, for the same
 * reason: there is nothing to sweep FOR. The timer is armed and disarmed by the
 * two transitions that already happen, so it costs one `setTimeout` per idle
 * session and answers at the moment the session actually went idle instead of up
 * to five minutes later. No new interval is added either way.
 *
 * ## A reap and a dispatch cannot interleave
 *
 * Both decide on the pump's state synchronously and move it synchronously — the
 * reaper through `SessionPump.reap`, the dispatch through its `warm → running`
 * transition — so whichever runs first wins outright and the other is refused by
 * the state machine. There is no window between the two in which a turn is half
 * open on a process being closed. The loser's remedy is the one the registry
 * already documents: a reaped pump is spent, and the next `acquire` builds a
 * fresh one, with the message still queued because a queue row retires on output
 * evidence and never on a dispatch resolving.
 *
 * ## Why shutdown reaches this from a module-level set
 *
 * A registry that owns processes puts itself in {@link shutdownSessionPumps}'
 * reach the moment it creates its first pump, rather than waiting to be
 * registered by a composition root. The failure mode of the alternative is a
 * host that forgot the wiring leaving CLI subprocesses running after DorkOS
 * exits, which is the worst way this could fail and the one nobody would notice
 * until their laptop fan told them. It is the same reasoning `message-dispatcher`
 * gives for wiring its projector hooks on import.
 *
 * @module services/runtimes/claude-code/sessions/session-pump-registry
 */
import type { SessionWarmth } from '@dorkos/shared/agent-runtime';
import {
  PumpRefusedError,
  SessionPump,
  type PumpState,
  type SessionPumpOptions,
} from './session-pump.js';
import { WarmSlotBook } from './warm-slot-book.js';
import { logger } from '../../../../lib/logger.js';

/** Registries holding at least one pump, so shutdown can reach every process. */
const liveRegistries = new Set<SessionPumpRegistry>();

/** What one `acquire` needs beyond the pump's own options. */
export interface AcquirePumpOptions extends Omit<SessionPumpOptions, 'sessionId' | 'reserveSlot'> {
  /**
   * Ceiling on simultaneous processes, read at acquire time so a config change
   * takes effect on the next launch rather than on a restart. Task 3.8 supplies
   * `SESSIONS.MAX_WARM_SESSIONS`.
   */
  maxWarmSessions: number;
  /**
   * How long this session may sit WARM with no turn open before its process is
   * given back, read at acquire time for the same reason. Task 3.8 supplies
   * `SESSIONS.WARM_IDLE_MS`.
   */
  warmIdleMs: number;
}

/** A pump plus the two per-session bounds its acquire was held to. */
interface PumpEntry {
  pump: SessionPump;
  maxWarmSessions: number;
  warmIdleMs: number;
  /** The armed idle timer, or undefined when this session is not sitting warm. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

/**
 * The warm processes this server is holding, keyed by session.
 *
 * A pump enters on {@link acquire} and leaves when it is reaped, evicted, or
 * torn down — a spent pump is dropped rather than reused, so the next dispatch
 * builds a fresh one with fresh capabilities and a fresh input stream. A crashed
 * pump deliberately STAYS: its recovery is a relaunch of the same pump
 * (`CRASHED → RESUMING`), which is where the resume path lives.
 */
export class SessionPumpRegistry {
  private readonly entries = new Map<string, PumpEntry>();
  private readonly slots = new WarmSlotBook();

  /**
   * The pump for `sessionId`, creating one (COLD, unlaunched) if there is none.
   *
   * Creating a pump costs nothing and boots nothing; the ceiling is enforced
   * when a process is actually about to be booted, because that is what the
   * ceiling counts.
   *
   * @param sessionId - Session the pump belongs to
   * @param opts - The launcher, the two bounds, and the pump's seams
   */
  acquire(sessionId: string, opts: AcquirePumpOptions): SessionPump {
    const existing = this.entries.get(sessionId);
    if (existing) return existing.pump;
    const { maxWarmSessions, warmIdleMs, ...pumpOpts } = opts;
    const pump = new SessionPump({
      ...pumpOpts,
      sessionId,
      reserveSlot: () => this.reserveSlot(sessionId, maxWarmSessions),
      onStateChange: (change) => {
        // The registry's own bookkeeping runs FIRST, so a throw from the
        // caller's observer cannot cost this session its idle timer. The pump
        // catches and logs whatever either of us throws.
        this.noteStateChange(sessionId, change.to);
        pumpOpts.onStateChange?.(change);
      },
    });
    this.entries.set(sessionId, { pump, maxWarmSessions, warmIdleMs });
    liveRegistries.add(this);
    return pump;
  }

  /** The pump for `sessionId`, or undefined when this server holds none. */
  peek(sessionId: string): SessionPump | undefined {
    return this.entries.get(sessionId)?.pump;
  }

  /**
   * How warm `sessionId` is. `'cold'` for a session this registry has never
   * heard of, which is the honest answer: there is no process.
   *
   * @param sessionId - Session to report on
   */
  warmth(sessionId: string): SessionWarmth {
    return this.entries.get(sessionId)?.pump.warmth ?? 'cold';
  }

  /** How many processes exist or are booting right now — what the ceiling counts. */
  liveCount(): number {
    let live = 0;
    for (const entry of this.entries.values()) if (entry.pump.holdsProcess) live += 1;
    return live;
  }

  /** How many sessions this registry is tracking, warm or not. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Close `sessionId`'s process without touching its session record or its
   * transcript. Idempotent, and a no-op for a session that is not warm — a
   * timer or a sweep asking at the wrong moment is a normal outcome, not an
   * error.
   *
   * @param sessionId - Session whose process should be given back
   * @returns True when the process was closed, false when the pump declined
   *   (not warm, or parked on a person) or there was nothing to close
   */
  async reap(sessionId: string): Promise<boolean> {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    if (!(await entry.pump.reap())) return false;
    this.drop(sessionId);
    return true;
  }

  /**
   * Drop a session for good: close its process unconditionally, then forget it.
   * This is the eviction edge — the caller drops the session RECORD afterwards,
   * so no subprocess outlives the record it belongs to.
   *
   * @param sessionId - Session going away
   */
  async evict(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    await entry.pump.teardown();
    this.drop(sessionId);
  }

  /**
   * Close every process this registry holds. Used by shutdown; a failure on one
   * session never stops the others, because the point is that nothing is left
   * running.
   */
  async teardownAll(): Promise<void> {
    const entries = [...this.entries.values()];
    // Through `drop`, and BEFORE the teardowns, for two reasons: it is the one
    // place a pump leaves this registry, so no exit can forget to take its idle
    // timer with it; and a pump torn down while its entry was still here would
    // report the state change into an entry about to be discarded anyway.
    for (const entry of entries) this.drop(entry.pump.sessionId);
    const results = await Promise.allSettled(entries.map((entry) => entry.pump.teardown()));
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('[SessionPumpRegistry] a pump failed to tear down', {
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason as string),
        });
      }
    }
  }

  /**
   * Forget a spent pump, and stop shutdown looking here once none are left.
   *
   * The single exit: everything a pump leaves behind — its idle timer, its slot
   * reservation, its place in the recency order — is given back here, so no
   * caller has to remember to.
   */
  private drop(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry) this.disarmIdle(entry);
    this.entries.delete(sessionId);
    // Releases the reservation too, so a launch that died between claiming a
    // slot and reaching WARMING cannot shrink the ceiling for good.
    this.slots.forget(sessionId);
    if (this.entries.size === 0) liveRegistries.delete(this);
  }

  /**
   * The pump moved. Everything the ceiling and the idle timer need to know
   * happens here, because every one of them is a transition.
   *
   * @param sessionId - Whose pump moved
   * @param to - The state it moved into
   */
  private noteStateChange(sessionId: string, to: PumpState): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    // The launch this session reserved a slot for has settled one way or the
    // other: either it holds a process now (and `liveCount` sees it) or it never
    // will. Either way the reservation has done its job.
    this.slots.release(sessionId);
    this.slots.touch(sessionId);
    if (to === 'warm') {
      this.armIdle(entry);
      return;
    }
    this.disarmIdle(entry);
  }

  /**
   * Start (or restart) this session's idle countdown. Restarting rather than
   * leaving an armed timer alone matters on the WARM → WARM-again path a turn
   * makes: the window that just closed is the activity the next five minutes are
   * measured from.
   */
  private armIdle(entry: PumpEntry): void {
    this.disarmIdle(entry);
    const timer = setTimeout(() => {
      void this.onIdle(entry.pump.sessionId);
    }, entry.warmIdleMs);
    timer.unref?.();
    entry.idleTimer = timer;
  }

  /** Cancel this session's idle countdown, if one is armed. */
  private disarmIdle(entry: PumpEntry): void {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  /**
   * The idle window elapsed with no turn opened: give the process back.
   *
   * A reap can decline — a session parked on a person is never idle-reaped, and
   * `INTERACTION_TIMEOUT_MS` (10 min) is deliberately longer than the idle window
   * (5 min), so somebody who walks away from an approval card WILL be sitting
   * here when this fires. The decline is answered by arming another full window
   * rather than by retrying immediately: the process is not wasted while a person
   * is expected back at it, and one more window is a bounded wait, not a spin.
   *
   * @param sessionId - The session whose window elapsed
   */
  private async onIdle(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    entry.idleTimer = undefined;
    if (await this.reap(sessionId)) return;
    // Still on the books and still warm: the reap was declined, so ask again a
    // window from now. Any other state has its own arming rule and gets it from
    // `noteStateChange`.
    if (this.entries.get(sessionId) === entry && entry.pump.state === 'warm') {
      this.armIdle(entry);
    }
  }

  /**
   * Claim a slot for a process about to be booted, reclaiming the least recently
   * used warm one when the ceiling is full.
   *
   * @param sessionId - The session asking, for the refusal's message
   * @param maxWarmSessions - The ceiling this launch is held to
   * @throws PumpRefusedError When the ceiling is full and nothing can be
   *   reclaimed, or when the asking session left while the reclaim ran
   */
  private async reserveSlot(sessionId: string, maxWarmSessions: number): Promise<void> {
    if (this.slots.grant(sessionId, this.liveCount(), maxWarmSessions)) return;
    const reclaimed = await this.reclaimWarmSlot(sessionId);
    // The reclaim awaited a process closing, and the asking session can have
    // LEFT inside that window — evicted, or torn down by shutdown. This is the
    // one grant that is not synchronous with a pump the registry still holds,
    // and so the one that can book a slot `drop` will never give back: the
    // reservation would outlive every pump and shrink the ceiling by one for
    // the life of the server. Every other exit is safe because `drop` forgets.
    if (!this.entries.has(sessionId)) {
      throw new PumpRefusedError(
        'process-gone',
        `session ${sessionId} left the registry while it waited for a warm slot`
      );
    }
    if (reclaimed && this.slots.grant(sessionId, this.liveCount(), maxWarmSessions)) return;
    throw new PumpRefusedError(
      'warm-ceiling',
      `cannot warm session ${sessionId}: ${maxWarmSessions} warm sessions already, and no slot could be reclaimed`
    );
  }

  /**
   * Reap the least recently used WARM process to make room for one more.
   *
   * Only WARM pumps are candidates. A RUNNING one is mid-turn and reclaiming it
   * would kill a turn somebody is watching; a WARMING one is the launch this may
   * itself be racing. Candidates are tried least-recent first and the first one
   * that actually goes wins — a pump can decline (parked on a person), and the
   * right answer to that is the next-least-recent, not a refusal.
   *
   * @param asking - The session wanting the slot, which never reclaims itself
   * @returns True when a process was closed, false when none could be
   */
  private async reclaimWarmSlot(asking: string): Promise<boolean> {
    const candidates: string[] = [];
    for (const [sessionId, entry] of this.entries) {
      if (sessionId !== asking && entry.pump.state === 'warm') candidates.push(sessionId);
    }
    for (const sessionId of this.slots.leastRecentFirst(candidates)) {
      if (await this.reap(sessionId)) {
        logger.debug('[SessionPumpRegistry] reclaimed a warm slot', { reaped: sessionId, asking });
        return true;
      }
    }
    return false;
  }
}

/**
 * Close every warm claude-code process in this server.
 *
 * Wired into `shutdownServices()` so no CLI subprocess outlives DorkOS, and a
 * no-op when nothing was ever warmed — which is every server today, since the
 * pump is not on the turn path until task 3.8.
 */
export async function shutdownSessionPumps(): Promise<void> {
  if (liveRegistries.size === 0) return;
  const registries = [...liveRegistries];
  liveRegistries.clear();
  await Promise.allSettled(registries.map((registry) => registry.teardownAll()));
  logger.info('[SessionPumpRegistry] warm sessions closed', { registries: registries.length });
}

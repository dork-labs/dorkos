/**
 * Every warm claude-code process in this server, and the ceiling on how many
 * there may be (spec `persistent-session-runtime` §4.4, task 3.2).
 *
 * A {@link SessionPump} owns one session's process; this owns the set of them.
 * It is the thing that answers `getSessionWarmth` for a session it has never
 * heard of (`cold`, because there is no process), the thing that reaps one
 * without touching its record, and the thing shutdown reaches to make sure no
 * subprocess outlives DorkOS.
 *
 * ## The ceiling
 *
 * `MAX_SESSIONS` (50) counts session RECORDS. This counts PROCESSES, and the
 * two are deliberately different numbers: fifty concurrent CLI subprocesses plus
 * their MCP children on a laptop is not a shape to ship. The caller supplies the
 * ceiling at acquire time — the same place task 3.8 reads the per-session opt-in
 * from config — and today a launch that would exceed it is REFUSED. Task 3.4
 * makes it reclaim instead, by installing {@link SessionPumpRegistryOptions.reclaimWarmSlot}
 * to reap the least recently used warm pump first. Warmth is a cache, so LRU is
 * exactly right for it; refusing is only correct while nothing can reclaim.
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
import { PumpRefusedError, SessionPump, type SessionPumpOptions } from './session-pump.js';
import { logger } from '../../../../lib/logger.js';

/** Registries holding at least one pump, so shutdown can reach every process. */
const liveRegistries = new Set<SessionPumpRegistry>();

/** How a registry is built. */
export interface SessionPumpRegistryOptions {
  /**
   * Make room when the warm ceiling is full, and report whether it worked.
   * Task 3.4 installs the LRU reaper here; with none installed, a launch over
   * the ceiling is refused.
   */
  reclaimWarmSlot?: () => Promise<boolean>;
}

/** What one `acquire` needs beyond the pump's own options. */
export interface AcquirePumpOptions extends Omit<SessionPumpOptions, 'sessionId' | 'reserveSlot'> {
  /**
   * Ceiling on simultaneous processes, read at acquire time so a config change
   * takes effect on the next launch rather than on a restart. Task 3.4 supplies
   * `SESSIONS.MAX_WARM_SESSIONS`.
   */
  maxWarmSessions: number;
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
  private readonly pumps = new Map<string, SessionPump>();
  private readonly opts: SessionPumpRegistryOptions;

  /**
   * Build an empty registry.
   *
   * @param opts - Optional reclaim strategy for a full ceiling
   */
  constructor(opts: SessionPumpRegistryOptions = {}) {
    this.opts = opts;
  }

  /**
   * The pump for `sessionId`, creating one (COLD, unlaunched) if there is none.
   *
   * Creating a pump costs nothing and boots nothing; the ceiling is enforced
   * when a process is actually about to be booted, because that is what the
   * ceiling counts.
   *
   * @param sessionId - Session the pump belongs to
   * @param opts - The launcher, the ceiling, and the pump's seams
   */
  acquire(sessionId: string, opts: AcquirePumpOptions): SessionPump {
    const existing = this.pumps.get(sessionId);
    if (existing) return existing;
    const { maxWarmSessions, ...pumpOpts } = opts;
    const pump = new SessionPump({
      ...pumpOpts,
      sessionId,
      reserveSlot: () => this.reserveSlot(sessionId, maxWarmSessions),
    });
    this.pumps.set(sessionId, pump);
    liveRegistries.add(this);
    return pump;
  }

  /** The pump for `sessionId`, or undefined when this server holds none. */
  peek(sessionId: string): SessionPump | undefined {
    return this.pumps.get(sessionId);
  }

  /**
   * How warm `sessionId` is. `'cold'` for a session this registry has never
   * heard of, which is the honest answer: there is no process.
   *
   * @param sessionId - Session to report on
   */
  warmth(sessionId: string): SessionWarmth {
    return this.pumps.get(sessionId)?.warmth ?? 'cold';
  }

  /** How many processes exist or are booting right now — what the ceiling counts. */
  liveCount(): number {
    let live = 0;
    for (const pump of this.pumps.values()) if (pump.holdsProcess) live += 1;
    return live;
  }

  /** How many sessions this registry is tracking, warm or not. */
  get size(): number {
    return this.pumps.size;
  }

  /**
   * Close `sessionId`'s process without touching its session record or its
   * transcript. Idempotent, and a no-op for a session that is not warm — a
   * timer or a sweep asking at the wrong moment is a normal outcome, not an
   * error.
   *
   * @param sessionId - Session whose process should be given back
   */
  async reap(sessionId: string): Promise<void> {
    const pump = this.pumps.get(sessionId);
    if (!pump) return;
    if (await pump.reap()) this.drop(sessionId);
  }

  /**
   * Drop a session for good: close its process unconditionally, then forget it.
   * This is the eviction edge — the caller drops the session RECORD afterwards.
   *
   * @param sessionId - Session going away
   */
  async evict(sessionId: string): Promise<void> {
    const pump = this.pumps.get(sessionId);
    if (!pump) return;
    await pump.teardown();
    this.drop(sessionId);
  }

  /**
   * Close every process this registry holds. Used by shutdown; a failure on one
   * session never stops the others, because the point is that nothing is left
   * running.
   */
  async teardownAll(): Promise<void> {
    const pumps = [...this.pumps.values()];
    this.pumps.clear();
    liveRegistries.delete(this);
    const results = await Promise.allSettled(pumps.map((pump) => pump.teardown()));
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

  /** Forget a spent pump, and stop shutdown looking here once none are left. */
  private drop(sessionId: string): void {
    this.pumps.delete(sessionId);
    if (this.pumps.size === 0) liveRegistries.delete(this);
  }

  /**
   * Claim a slot for a process about to be booted, reclaiming one if something
   * knows how.
   *
   * @param sessionId - The session asking, for the refusal's message
   * @param maxWarmSessions - The ceiling this launch is held to
   */
  private async reserveSlot(sessionId: string, maxWarmSessions: number): Promise<void> {
    if (this.liveCount() < maxWarmSessions) return;
    const reclaimed = (await this.opts.reclaimWarmSlot?.()) ?? false;
    if (reclaimed && this.liveCount() < maxWarmSessions) return;
    throw new PumpRefusedError(
      'warm-ceiling',
      `cannot warm session ${sessionId}: ${maxWarmSessions} warm sessions already, and no slot could be reclaimed`
    );
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

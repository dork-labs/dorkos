/**
 * Whether one warm process is doing anything, and the two clocks that bound the
 * answer (spec `warm-process-lifecycle` D1).
 *
 * Split out of `session-pump.ts` because it is a separate question from the
 * process state machine: the pump owns a subprocess's life, this owns "is that
 * subprocess busy, and for how much longer may it say so". The pump keeps the
 * public surface — {@link SessionPump.quietness} delegates here — so nothing
 * outside these two files knows this exists.
 *
 * ## Why one predicate, and why it is the pump that answers it
 *
 * Four consumers used to decide for themselves whether a warm process could be
 * taken back, and they disagreed. `reap` asked one question — are any
 * `local_agent` subagents live — so a Monitor, a task type nobody has
 * catalogued and a settled-but-undelivered notification were all reaped out
 * from under the agent. Record eviction asked nothing at all and tore the
 * process down unconditionally (DOR-2064, DOR-2065). One predicate means one
 * answer, and a consumer added later inherits it rather than inventing a fifth.
 *
 * ## Two clocks, because two holds could otherwise last forever
 *
 * - **The busy spell** ({@link SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS}, 4 h)
 *   bounds "this process is working". Reset only by
 *   {@link SESSIONS.BACKGROUND_QUIET_RESET_MS} of CONTINUOUS quiet, so a level
 *   frame dropping one helper and naming the next — which arrive inside one
 *   output burst — is a single spell rather than a fresh four hours each time.
 * - **The owed-delivery clock** ({@link OWED_DELIVERY_TIMEOUT_MS}, 30 s) bounds
 *   "a helper finished and its report has not been handed over". On the resume
 *   path that debt is bounded by a deferred stdin close; a warm process never
 *   performs that close, so it needs its own deadline here.
 *
 * Lives beside `turn-liveness.ts` and `stdin-hold.ts` rather than beside the
 * pump, because those are the other two modules answering the same family of
 * question — is this still alive, and may we close it — and this one wraps
 * `TurnLiveness` outright.
 *
 * @module services/runtimes/claude-code/messaging/process-quiet
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../../../../lib/logger.js';
import { SESSIONS } from '../../../../config/constants.js';
import type { LiveTaskCounts, LivenessChange, TurnLiveness } from './turn-liveness.js';
import {
  OWED_DELIVERY_TIMEOUT_MS,
  type Quietness,
  type QuietnessBlocker,
} from '../sessions/session-pump-contract.js';

/** What the tracker needs from the pump that owns it. */
export interface ProcessQuietOptions {
  /** The session this process belongs to, for the log lines. */
  sessionId: string;
  /**
   * The process's CURRENT liveness tracker.
   *
   * A getter rather than a value: the pump replaces the tracker on every
   * launch, because the level signal is per-process and is not replayed at
   * startup. A captured reference would answer for the process that went away.
   */
  liveness: () => TurnLiveness;
  /** True while a dispatched turn is open on this process. */
  isTurnOpen: () => boolean;
  /** True while the session is parked on a person. */
  hasPendingInteraction: () => boolean;
  /**
   * A hold this tracker owned has been released — today only the
   * owed-delivery clock expiring. Throws are logged and swallowed.
   */
  onGateChange: () => void;
  /** Override the owed-delivery wait. Tests only. */
  owedDeliveryTimeoutMs?: number;
}

/**
 * The quiet predicate for one warm process, and the state its two clocks need.
 *
 * One instance per pump, reset ({@link reset}) on every launch and disposed
 * ({@link dispose}) when the process goes away.
 */
export class ProcessQuiet {
  /**
   * When this process last produced ANY frame, as epoch ms, or 0 before it has
   * produced one. What the idle reaper measures against, so a process talking
   * to itself between turns is not read as unused.
   */
  private lastFrame = 0;
  /** When the current busy spell began, or undefined while this process is quiet. */
  private busySince: number | undefined;
  /** When the current run of continuous quiet began, or undefined while busy. */
  private quietSince: number | undefined;
  /**
   * True between a frame that proves a segment is running and the `result` that
   * ends it. The owed-delivery clock arms only when nothing is running to
   * deliver into.
   */
  private segmentRunning = false;
  /** The armed owed-delivery clock, or undefined when nothing is owed. */
  private owedTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * When {@link expireOwedDelivery} last gave up, or undefined when it has not.
   *
   * Kept only to measure the next delivery's lateness: the thirty seconds are a
   * guarantee rather than a measurement, and a real session logging "a delivery
   * arrived after its clock expired" is how the number gets checked against
   * reality instead of being assumed.
   */
  private owedExpiredAt: number | undefined;

  /**
   * Build a tracker for one process.
   *
   * @param opts - What this needs from the pump that owns it
   */
  constructor(private readonly opts: ProcessQuietOptions) {}

  /** When this process last produced any frame, as epoch ms. */
  get lastFrameAt(): number {
    return this.lastFrame;
  }

  /**
   * Note that a frame arrived, without interpreting it.
   *
   * Separate from {@link observe} because the pump calls this OUTSIDE the guard
   * that catches a downstream observer's throw: the idle reaper's answer must
   * not depend on whether somebody else's callback failed.
   *
   * @param now - When the frame arrived, as epoch ms
   */
  stampFrame(now: number): void {
    this.lastFrame = now;
  }

  /**
   * Feed one frame through the liveness tracker and fold it into both clocks.
   *
   * @param message - The frame the process just produced
   * @returns What the liveness tracker made of it, for the pump to pass on
   */
  observe(message: SDKMessage): LivenessChange {
    const owedBefore = this.opts.liveness().owedCount();
    const change = this.opts.liveness().observe(message);
    this.noteOwedDelivery(message, change, owedBefore);
    // Every frame is also a chance to notice the busy spell has ended, so the
    // sixty seconds of quiet do not wait on a consumer happening to ask.
    this.noteBusySpell(this.blockingReason(this.opts.liveness().liveTaskCounts()) === undefined);
    return change;
  }

  /**
   * Why this process may not be relaunched, reaped or evicted right now — or
   * that it may.
   *
   * Calling this is not free of effect on purpose: it is also where the busy
   * spell is re-evaluated, because "quiet for a continuous minute" can only be
   * noticed by something that looks.
   */
  quietness(): Quietness {
    const counts = this.opts.liveness().liveTaskCounts();
    const because = this.blockingReason(counts);
    this.noteBusySpell(because === undefined);
    if (because === undefined) {
      return { quiet: true, shells: counts.shells, lastFrameAt: this.lastFrame };
    }
    return {
      quiet: false,
      because,
      holding: { agents: counts.agents, other: counts.other },
      // `??` rather than `!`: `noteBusySpell` has just set it for any state
      // this can be reached in, and falling back to now is honest anyway.
      busySince: this.busySince ?? Date.now(),
      shells: counts.shells,
    };
  }

  /**
   * Is this process holding background work that record eviction must not throw
   * away?
   *
   * A narrower question than {@link quietness}: a turn in flight or a person
   * being waited on are already exempt from eviction by their own rules, so the
   * two reasons here are the ones eviction was blind to. Bounded by the
   * four-hour ceiling, which is what stops a helper that will never finish from
   * making a session record immortal.
   */
  isHoldingBackgroundWork(): boolean {
    const quietness = this.quietness();
    if (quietness.quiet) return false;
    if (this.isPastCeiling(Date.now())) return false;
    return quietness.because === 'background-work' || quietness.because === 'delivery-owed';
  }

  /**
   * Has the current busy spell run past the four-hour ceiling?
   *
   * @param now - Server epoch ms
   */
  isPastCeiling(now: number): boolean {
    return (
      this.busySince !== undefined &&
      now - this.busySince >= SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS
    );
  }

  /**
   * Forget everything: a new process starts quiet, with no spell, no debt and
   * no clock, because everything remembered here describes the one that went
   * away.
   *
   * @param now - When the new process launched, as epoch ms
   */
  reset(now: number): void {
    this.dispose();
    this.busySince = undefined;
    this.quietSince = undefined;
    this.segmentRunning = false;
    this.owedExpiredAt = undefined;
    this.lastFrame = now;
  }

  /** Stop the owed-delivery clock, because the process it belonged to is going. */
  dispose(): void {
    if (this.owedTimer !== undefined) clearTimeout(this.owedTimer);
    this.owedTimer = undefined;
  }

  /**
   * The first reason this process is not quiet, or undefined when it is.
   *
   * Ordered most specific first, so the reason a consumer logs is the one a
   * person would name: a turn being open explains everything else about the
   * process, and "waiting on a person" is only interesting once nothing runs.
   */
  private blockingReason(counts: LiveTaskCounts): QuietnessBlocker | undefined {
    if (this.opts.isTurnOpen()) return 'turn-open';
    // Shells are deliberately absent: the CLI kills them shortly after stdin
    // ends and always has, so holding a whole process open for one would be a
    // new promise this spec explicitly declines to make (Non-Goals).
    if (counts.agents + counts.other > 0) return 'background-work';
    if (this.opts.liveness().owedCount() > 0) return 'delivery-owed';
    if (this.opts.hasPendingInteraction()) return 'waiting-on-person';
    return undefined;
  }

  /**
   * Fold one observation into the busy spell the ceiling is measured from.
   *
   * The elapsed quiet run is judged BEFORE this observation is folded in, so
   * the reset does not depend on somebody having asked during the quiet minute:
   * a process that goes quiet, is asked about by nobody for an hour and then
   * starts a fresh helper begins a fresh spell, which is the rule as written
   * and is not what a purely lazy check would have given it.
   */
  private noteBusySpell(quiet: boolean): void {
    const now = Date.now();
    if (
      this.quietSince !== undefined &&
      now - this.quietSince >= SESSIONS.BACKGROUND_QUIET_RESET_MS
    ) {
      this.busySince = undefined;
    }
    if (!quiet) {
      this.quietSince = undefined;
      this.busySince ??= now;
      return;
    }
    this.quietSince ??= now;
  }

  /**
   * Drive the owed-delivery clock from one observed frame.
   *
   * It arms at the two moments a debt can be left with nothing running to pay
   * it — a `result` observed while something is owed, and a settle that lands
   * while no segment is running — and a segment starting cancels it, because
   * that segment's own `system/init` clears the debt properly.
   *
   * @param message - The frame just observed
   * @param change - What the liveness tracker made of it
   * @param owedBefore - How many deliveries were owed before it was observed
   */
  private noteOwedDelivery(message: SDKMessage, change: LivenessChange, owedBefore: number): void {
    if (change.segmentRunning) {
      this.segmentRunning = true;
      this.noteLateDelivery();
      this.dispose();
      return;
    }
    if (message.type === 'result') {
      this.segmentRunning = false;
      if (this.opts.liveness().owedCount() > 0) this.armOwedClock();
      return;
    }
    // A notification that lands between turns: the count goes 0 -> non-zero
    // with nothing running, so no `result` is coming to arm the clock at.
    if (owedBefore === 0 && this.opts.liveness().owedCount() > 0 && !this.segmentRunning) {
      this.armOwedClock();
    }
  }

  /** Start the owed-delivery countdown, unless one is already running. */
  private armOwedClock(): void {
    // An armed clock is not re-armed by further settles: the bound is on the
    // debt, not on each notification, so a stream of settles cannot walk the
    // deadline forward indefinitely.
    if (this.owedTimer !== undefined) return;
    const timer = setTimeout(() => {
      this.expireOwedDelivery();
    }, this.owedTimeout);
    timer.unref?.();
    this.owedTimer = timer;
  }

  /** The configured owed-delivery wait, or the module default. */
  private get owedTimeout(): number {
    return this.opts.owedDeliveryTimeoutMs ?? OWED_DELIVERY_TIMEOUT_MS;
  }

  /**
   * The owed delivery never came. Clear the debt, say so, and release whatever
   * was waiting behind it.
   */
  private expireOwedDelivery(): void {
    this.owedTimer = undefined;
    const abandoned = this.opts.liveness().expireOwed();
    if (abandoned.length === 0) return;
    this.owedExpiredAt = Date.now();
    logger.info('[SessionPump] an owed delivery never arrived; releasing the queue', {
      sessionId: this.opts.sessionId,
      tasks: abandoned,
      waitedMs: this.owedTimeout,
    });
    try {
      this.opts.onGateChange();
    } catch (err) {
      logger.warn('[SessionPump] a dispatch-gate observer threw', {
        sessionId: this.opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * A delivery segment started after its clock had already expired. Logged once
   * with how late it was, so the thirty seconds can be checked against real
   * sessions rather than assumed.
   */
  private noteLateDelivery(): void {
    if (this.owedExpiredAt === undefined) return;
    logger.info('[SessionPump] a delivery arrived after its clock expired', {
      sessionId: this.opts.sessionId,
      lateByMs: Date.now() - this.owedExpiredAt,
    });
    this.owedExpiredAt = undefined;
  }
}

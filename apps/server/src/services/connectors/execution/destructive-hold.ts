/**
 * The cancel window before an agent's irreversible action in a connected app
 * (spec `trusted-by-default-flip` §5.6, DOR-2739).
 *
 * On a Trusted install, an agent in a chat that never asks does not raise an
 * approval card for `connectors.execute_destructive`. The call waits here
 * instead, for {@link DESTRUCTIVE_HOLD_MS}, inside the tool call. Everyone is
 * told before the wait starts (a notification row with Cancel in every open
 * window, and a phone push that opens it), and anyone except the agent that
 * asked may cancel it. Stopping the chat cancels it too. If nobody does, it
 * runs with exactly the input and authority it was held with.
 *
 * **Never run unannounced.** A hold starts only once its waiting row was
 * written. If the notification store could not write it, there is no hold and
 * the call keeps the approval card.
 *
 * **A hold, not an undo.** The services DorkOS reaches have no undo it can
 * call, and a sent email cannot be unsent, so the only honest window is before
 * the action runs. Every word here says Cancel.
 *
 * **In memory, and the Activity log is the durable half** (`hold-activity.ts`).
 * A hold is a live tool call; when the process ends, the call ends with it.
 * The moment a wait ends with nobody cancelling, and before the action is
 * sent, the hold writes `connector.destructive_released`. So at boot,
 * {@link DestructiveHoldService.dropOpenHolds} can tell a hold that never ran
 * ("DorkOS restarted before it ran") from one that may have ("Check Gmail").
 *
 * Which calls are held, rather than carded, is decided in
 * `destructive-hold-window.ts`.
 *
 * @module services/connectors/execution/destructive-hold
 */
import { ulid } from 'ulidx';
import { DESTRUCTIVE_HOLD_MS } from '@dorkos/shared/connector-hold-schemas';
import type { WebPushPayload } from '@dorkos/shared/notification-schemas';
import type { ActivityService } from '../../activity/activity-service.js';
import type {
  HeldActionEnding,
  HeldActionOutcome,
} from '../../notifications/connector-hold-notifications.js';
import type { NotificationPayload } from '../../notifications/notification-registry.js';
import { notify } from '../../notifications/notification-service.js';
import { pushNow } from '../../notifications/escalation-service.js';
import { logger } from '../../../lib/logger.js';
import {
  cancellerName,
  HOLD_EVENT_TYPES,
  openHoldsFrom,
  writeHoldLine,
  type HeldActionDescription,
  type HoldCanceller,
  type HoldRecord,
  type HoldRequester,
  type HoldStep,
} from './hold-activity.js';

export { DESTRUCTIVE_HOLD_MS, HOLD_EVENT_TYPES };
export type { HeldActionDescription, HoldCanceller, HoldRequester };

/** How far back the boot step looks for a hold an earlier process left open. */
const DROP_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a released hold waits for its outcome before DorkOS records that it
 * could not confirm one. The send itself is bounded well inside this; the
 * timer exists so a call that never reports back cannot leave the hold open.
 */
export const RELEASED_REPORT_MS = 15 * 60_000;

/** How a hold's wait ended. Only `elapsed` lets the action run. */
export type HoldEnd =
  { outcome: 'elapsed' } | { outcome: 'cancelled'; by: string } | { outcome: 'stopped' };

/** What a cancel did. */
export type CancelHoldResult =
  { ok: true } | { ok: false; code: 'HOLD_NOT_FOUND' | 'HOLD_REQUESTER' };

/** Whether a hold whose wait ended may run, and who cancelled it when not. */
export type ReleaseResult = { ok: true } | { ok: false; cancelledBy?: string };

/** How many swept holds are remembered for a late outcome. */
const SWEPT_MEMORY = 1000;

/** A hold that started: its id, and how its wait ended. */
export interface StartedHold {
  holdId: string;
  ended: Promise<HoldEnd>;
}

/** What the service writes to and reaches, injectable for tests. */
export interface DestructiveHoldDeps {
  /** The Activity log, the durable half of every hold. */
  activity?: Pick<ActivityService, 'tryEmit' | 'listByEventTypes'>;
  /** Raise a notification. Defaults to the pipeline's `notify`. */
  notify?: typeof notify;
  /** Push to every subscribed browser now. Defaults to `pushNow`. */
  push?: (payload: WebPushPayload) => void;
  /** The wait, in milliseconds. Defaults to {@link DESTRUCTIVE_HOLD_MS}. */
  holdMs?: number;
  /** Clock. */
  now?: () => Date;
}

/** A hold still inside its window. */
interface WaitingHold extends HoldRecord {
  settle: (end: HoldEnd) => void;
}

/** A released hold, waiting for its outcome. */
interface ReleasedHold extends HoldRecord {
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Where a held action's alert opens: the Inbox, on that hold's row, where
 * Cancel is. `?inbox=<id>` works on every route.
 *
 * @param holdId - The hold.
 * @returns The in-app link.
 */
export function heldActionLink(holdId: string): string {
  return `/?inbox=${encodeURIComponent(holdId)}`;
}

/** Holds, cancels and the record of how each ended. One per server. */
export class DestructiveHoldService {
  private readonly waiting = new Map<string, WaitingHold>();
  /** Holds whose wait ended with nobody cancelling, before they are released. */
  private readonly due = new Map<string, HoldRecord>();
  private readonly released = new Map<string, ReleasedHold>();
  /** Holds cancelled during the end-of-wait re-check, and who cancelled them. */
  private readonly cancelledWhileDue = new Map<string, string>();
  /** Released holds the timer closed with no outcome, in case one arrives late. */
  private readonly swept = new Map<string, HoldRecord>();
  private readonly holdMs: number;
  private readonly now: () => Date;
  private readonly raise: typeof notify;
  private readonly push: (payload: WebPushPayload) => void;

  /**
   * Build the service.
   *
   * @param deps - The Activity log, the notification seams, the wait and the clock.
   */
  constructor(private readonly deps: DestructiveHoldDeps = {}) {
    this.holdMs = deps.holdMs ?? DESTRUCTIVE_HOLD_MS;
    this.now = deps.now ?? (() => new Date());
    this.raise = deps.notify ?? notify;
    this.push = deps.push ?? pushNow;
  }

  /**
   * Start a hold: tell everyone, record it, and wait out the window.
   *
   * The durable `held` line is written first, then the waiting row everyone
   * sees. If either cannot be saved, nothing waits and nothing is pushed, and
   * this resolves `undefined`, so the caller keeps the approval card: a hold
   * with no record, or one nobody was told about, must not run.
   *
   * The `ended` promise settles exactly once: `elapsed` when the window ended
   * with nobody cancelling, `cancelled` when somebody did, `stopped` when the
   * call's signal aborted (the turn was interrupted or the chat stopped).
   *
   * @param request - Who asked, for what, and the call's abort signal.
   *   `holdMs` overrides the window for this one hold; only the test-mode demo
   *   seam (`routes/test-control-held-action.ts`) passes it.
   * @returns The started hold, or `undefined` when nobody could be told.
   */
  async start(request: {
    requester: HoldRequester;
    action: HeldActionDescription;
    signal?: AbortSignal;
    holdMs?: number;
  }): Promise<StartedHold | undefined> {
    const holdId = ulid();
    const holdMs = request.holdMs ?? this.holdMs;
    const record: HoldRecord = { holdId, requester: request.requester, action: request.action };
    if (!(await this.write(record, 'held', { holdMs }))) {
      logger.warn('[Connections] Could not record a held action; asking with a card instead', {
        holdId,
      });
      return undefined;
    }
    const told = await this.raise('connector.destructive_pending', this.subject(record));
    if (!told.notification && !told.deduped) {
      logger.warn('[Connections] Could not announce a held action; asking with a card instead', {
        holdId,
      });
      // Close the record just written, so a restart does not report on it.
      void this.write(record, 'cancelled', { reason: 'unannounced' });
      return undefined;
    }
    let settle!: (end: HoldEnd) => void;
    const ended = new Promise<HoldEnd>((resolve) => {
      settle = resolve;
    });
    const clock: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => this.end(holdId, { outcome: 'stopped' });
    this.waiting.set(holdId, {
      ...record,
      settle: (end) => {
        if (clock.timer !== undefined) clearTimeout(clock.timer);
        request.signal?.removeEventListener('abort', onAbort);
        settle(end);
      },
    });
    this.pushWaiting(record);
    if (request.signal?.aborted) {
      onAbort();
      return { holdId, ended };
    }
    request.signal?.addEventListener('abort', onAbort, { once: true });
    clock.timer = setTimeout(() => this.end(holdId, { outcome: 'elapsed' }), holdMs);
    return { holdId, ended };
  }

  /**
   * Cancel a hold that has not been let run. Anyone may, except the agent
   * that asked for it: its own cancel is refused, whether it names itself by
   * agent or by chat. A cancel wins until {@link release} hands back the
   * approval, including while the end-of-wait re-check runs.
   *
   * @param holdId - The hold.
   * @param canceller - Who is cancelling.
   * @returns Whether it was cancelled, and why not when it was not.
   */
  cancel(holdId: string, canceller: HoldCanceller): CancelHoldResult {
    const hold = this.waiting.get(holdId) ?? this.due.get(holdId);
    if (!hold) return { ok: false, code: 'HOLD_NOT_FOUND' };
    const sameAgent =
      canceller.kind === 'agent' && canceller.agentPath === hold.requester.agentPath;
    const sameChat =
      canceller.kind !== 'person' && canceller.sessionId === hold.requester.sessionId;
    if (sameAgent || sameChat) {
      return { ok: false, code: 'HOLD_REQUESTER' };
    }
    const by = cancellerName(canceller);
    if (this.waiting.has(holdId)) {
      this.end(holdId, { outcome: 'cancelled', by }, canceller);
    } else {
      this.due.delete(holdId);
      this.cancelledWhileDue.set(holdId, by);
      this.close(hold, 'cancelled', by, canceller);
    }
    return { ok: true };
  }

  /**
   * Let a hold whose wait ended run. Saves the durable `released` line BEFORE
   * answering, so a restart from here on reads as "may have run", never as
   * "did not run". If the line cannot be saved, the hold ends unexecuted
   * instead. A cancel that lands before this answers wins.
   *
   * @param holdId - The hold whose wait ended.
   * @returns `ok` when it may run; otherwise who cancelled it, when somebody did.
   */
  async release(holdId: string): Promise<ReleaseResult> {
    const hold = this.due.get(holdId);
    if (!hold) return this.notReleased(holdId);
    const saved = await this.write(hold, 'released');
    if (!this.due.has(holdId)) return this.notReleased(holdId);
    this.due.delete(holdId);
    if (!saved) {
      this.close(hold, 'changed');
      return { ok: false };
    }
    const timer = setTimeout(
      () => this.recordOutcome(holdId, 'outcome_unknown', true),
      RELEASED_REPORT_MS
    );
    timer.unref?.();
    this.released.set(holdId, { ...hold, timer });
    return { ok: true };
  }

  /** Why a hold that is not due may not run: cancelled meanwhile, or already ended. */
  private notReleased(holdId: string): ReleaseResult {
    const by = this.cancelledWhileDue.get(holdId);
    this.cancelledWhileDue.delete(holdId);
    return by === undefined ? { ok: false } : { ok: false, cancelledBy: by };
  }

  /**
   * End a hold whose wait ended but which no longer qualifies to run without
   * asking (the install moved to Careful, the agent was switched off, or the
   * turn changed). Nothing is sent.
   *
   * @param holdId - The hold whose wait ended.
   * @returns Who cancelled it, when a cancel already ended it first.
   */
  refuse(holdId: string): string | undefined {
    const hold = this.due.get(holdId);
    if (!hold) {
      const result = this.notReleased(holdId);
      return result.ok ? undefined : result.cancelledBy;
    }
    this.due.delete(holdId);
    this.close(hold, 'changed');
    return undefined;
  }

  /**
   * Record how a held action that ran came out, and replace its waiting row.
   * Called once, by the execution capability, after the broker answered; or
   * by the release timer when nothing answered, which says only that it may
   * have run. A real outcome arriving after that timer is still recorded.
   *
   * @param holdId - The hold whose action ran.
   * @param outcome - What the service reported, or `not_sent` when DorkOS
   *   refused it before sending (its access changed during the wait).
   * @param swept - Set by the release timer: no outcome arrived in time.
   */
  recordOutcome(holdId: string, outcome: HeldActionOutcome, swept = false): void {
    const live = this.released.get(holdId);
    const hold: HoldRecord | undefined = live ?? this.swept.get(holdId);
    if (!hold) return;
    const late = live === undefined;
    if (live) clearTimeout(live.timer);
    this.released.delete(holdId);
    this.swept.delete(holdId);
    if (swept) {
      this.swept.set(holdId, { holdId, requester: hold.requester, action: hold.action });
      if (this.swept.size > SWEPT_MEMORY) this.swept.delete(this.swept.keys().next().value!);
    }
    void this.write(hold, 'executed', { outcome, ...(late ? { lateReport: true } : {}) });
    void this.raise('connector.destructive_executed', { ...this.subject(hold), outcome });
  }

  /**
   * Close every hold an earlier process started and never ended. One whose
   * wait had not ended never ran; one already released may have, and the
   * person is told to check the app. Run once at boot.
   *
   * @returns How many were closed.
   */
  async dropOpenHolds(): Promise<number> {
    const activity = this.deps.activity;
    if (!activity) return 0;
    const since = new Date(this.now().getTime() - DROP_LOOKBACK_MS).toISOString();
    const events = await activity.listByEventTypes(Object.values(HOLD_EVENT_TYPES), since);
    const open = openHoldsFrom(
      events,
      (holdId) => this.waiting.has(holdId) || this.due.has(holdId) || this.released.has(holdId)
    );
    for (const { hold, released } of open) {
      await this.write(hold, 'dropped', released ? { mayHaveRun: true } : {});
      void this.raise('connector.destructive_pending', {
        ...this.subject(hold),
        ended: { reason: released ? 'interrupted' : 'restarted' },
      });
    }
    return open.length;
  }

  /** End a waiting hold once, and say how. */
  private end(holdId: string, end: HoldEnd, canceller?: HoldCanceller): void {
    const hold = this.waiting.get(holdId);
    if (!hold) return;
    this.waiting.delete(holdId);
    const record: HoldRecord = { holdId, requester: hold.requester, action: hold.action };
    if (end.outcome === 'elapsed') {
      this.due.set(holdId, record);
    } else {
      this.close(
        record,
        end.outcome === 'stopped' ? 'stopped' : 'cancelled',
        end.outcome === 'cancelled' ? end.by : undefined,
        canceller
      );
    }
    hold.settle(end);
  }

  /** Record a hold that ended without running, and say so everywhere. */
  private close(
    hold: HoldRecord,
    reason: Exclude<HeldActionEnding, 'restarted' | 'interrupted'>,
    by?: string,
    canceller?: HoldCanceller
  ): void {
    void this.write(hold, 'cancelled', { reason }, canceller);
    void this.raise('connector.destructive_pending', {
      ...this.subject(hold),
      ended: { reason, ...(by ? { by } : {}) },
    });
  }

  /** The phone push: everyone is told, and it opens the row with Cancel. */
  private pushWaiting(hold: HoldRecord): void {
    try {
      this.push({
        title: `${hold.requester.name} will run “${hold.action.actionName}” in ${hold.action.serviceName}`,
        body: 'Runs in 60 seconds unless someone cancels.',
        deepLink: heldActionLink(hold.holdId),
        notificationId: `connector-hold:${hold.holdId}`,
        tier: 'notable',
      });
    } catch (err) {
      logger.warn('[Connections] Could not push a held action', { err });
    }
  }

  /** The fields every notification about this hold carries. */
  private subject(hold: HoldRecord): NotificationPayload<'connector.destructive_pending'> {
    return {
      holdId: hold.holdId,
      ...(hold.requester.agentId ? { agentId: hold.requester.agentId } : {}),
      agentName: hold.requester.name,
      sessionId: hold.requester.sessionId,
      actionName: hold.action.actionName,
      serviceName: hold.action.serviceName,
    };
  }

  /** Write one line of a hold's record. */
  private write(
    hold: HoldRecord,
    step: HoldStep,
    extra?: Record<string, unknown>,
    canceller?: HoldCanceller
  ): Promise<boolean> {
    return writeHoldLine(this.deps.activity, hold, step, extra, canceller);
  }
}

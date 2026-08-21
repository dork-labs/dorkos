/**
 * The escalation ladder — what happens when nobody answers (spec
 * `notification-system`; ADR 260819-234829).
 *
 * A blocked agent used to be able to wait up to four hours with no signal
 * outside the app. This is the piece that ends that: when a Blocking condition
 * starts standing, a timer is armed; if nobody has acknowledged it by the time
 * the timer fires, the news leaves the machine — to every browser that
 * subscribed to push, and to whatever chat integration the operator opened.
 *
 * ## Ack-based, never presence-based
 *
 * Nothing here asks whether a window is focused. Presence across a web tab, an
 * Electron window and a phone is unreliable, and a focused-but-unattended screen
 * is exactly the case that made "they're clearly here" wrong. A timer is
 * cancelled only by an ACT, and there are two of them:
 *
 * 1. **The condition resolved.** The Ask was answered, the schedule approved or
 *    rejected, the error cleared. `NotificationService.resolveStanding` disarms
 *    for all three kinds in one place.
 * 2. **A delivery was marked seen or acted on** — a chat button pressed, a push
 *    tapped. Checked against the ledger at fire time, but **dormant**: nothing
 *    in production writes those marks yet, so it always answers "no" today. It
 *    is the seam a channel-side ack hook lands on (see
 *    `NotificationStore.wasAcknowledged`), not a path anything currently takes.
 *
 * The ADR also names "the notification was read". That turns out to be the same
 * act as (1) rather than a third one: a standing kind stores NO row while it
 * stands (ADR 260819-234828), so the only row a person can mark read is the
 * history row a resolution already wrote — and by then the timer is gone. A
 * separate hook on the read path would be a line that could never run.
 *
 * ## One knob
 *
 * `notifications.escalation.phoneAfterMinutes`, read LIVE — on every arm and
 * again at fire time — rather than cached at boot. Turning it to `never` while
 * something is already armed silences that timer too, which is what a person
 * pressing "Never" means.
 *
 * **A new NUMBER applies to the next thing that starts waiting, not to a timer
 * already running.** Only `never` reaches back, because only `never` is asked
 * again at fire time; a timer armed for two minutes still fires at two minutes
 * even if the knob moves to fifteen a moment later. The asymmetry is deliberate:
 * "stop bothering me" has to take effect immediately, while re-arming every live
 * timer on a settings write would let a person push an escalation away
 * indefinitely without meaning to.
 *
 * ## One key
 *
 * A timer is filed under `notificationEntry(kind).dedupeKey(payload)` — the
 * registry's own builder, and deliberately not a second one written here. That
 * one string is the timer's key, the ledger's `subject_key`, and what a
 * resolution passes to {@link cancelEscalationByKey}, so the three cannot drift
 * into naming one condition two different ways. A key built twice is the one
 * place "a ping nothing can cancel" could live.
 *
 * ## Why the registry's `relay` policy is not consulted
 *
 * All three standing kinds declare `relay: 'never'`. That policy is about the
 * one HISTORY row they write when they resolve — "your ask expired" does not
 * belong on Telegram. Escalation is the opposite case and a separately decided
 * one: the ADR says Blocking conditions reach the phone after the delay, so this
 * sends under its own `'always'` policy. The consent gates the channel owns —
 * the binding's "Agent can start conversations" switch and the hourly budget —
 * are untouched and still decide whether it may.
 *
 * ## Restarts
 *
 * Timers are in memory. On boot {@link EscalationService.rearmFromStandingState}
 * re-arms from the conditions that are still standing, and the ledger is what
 * makes that idempotent: a subject that already has an escalation delivery
 * recorded is not escalated again. The bound the ADR accepts is a server that
 * restarts INSIDE the delay window and had not yet written a ledger row — that
 * subject's clock restarts, so the phone ping can land later than it would have,
 * and in the narrow case where the row was written but the process died before
 * the send completed, a person can see one duplicate.
 *
 * @module services/notifications/escalation-service
 */
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import type { NotificationChannel } from '@dorkos/shared/notification-schemas';
import { logger } from '../../lib/logger.js';
import {
  notificationEntry,
  type NotificationPayload,
  type StandingNotificationKind,
} from './notification-registry.js';
import type { NotificationStore } from './notification-store.js';
import type { WebPushChannel } from './channels/web-push.js';
import {
  deliverOverRelay,
  type RelayChannelDeps,
  type RelayDeliveryOutcome,
} from './channels/relay.js';

/** The relay `from` principal an escalation publishes under. */
const ESCALATION_PRINCIPAL = 'relay.system.notifications.escalation';

/**
 * How long an escalation may live in the relay pipeline.
 *
 * A terminal leaf, the same shape the task-completion notifier uses: nothing
 * downstream takes a turn off it, so a minimal budget is correct.
 */
const PUBLISH_BUDGET = { maxHops: 2, callBudgetRemaining: 1 } as const;

/** How long the publish stays valid for, from the moment it is handed over. */
const PUBLISH_TTL_MS = 30_000;

/**
 * How far back a boot may reach when catching up on conditions that were already
 * standing.
 *
 * Four hours, which is the Ask park ceiling — the longest a blocked agent can
 * still be waiting for an answer at all. Beyond that a standing condition is not
 * news, it is a backlog: a schedule parked last week is in the Inbox and has
 * been on every screen since, and buzzing a phone about it on every server
 * restart is precisely the noise the tiering exists to prevent.
 */
const BOOT_CATCH_UP_WINDOW_MS = 4 * 60 * 60 * 1000;

/** What a still-standing condition looked like when boot found it. */
export interface StandingCondition<K extends StandingNotificationKind = StandingNotificationKind> {
  kind: K;
  payload: NotificationPayload<K>;
  /** When it started standing. Epoch ms. */
  since: number;
}

/** What the escalation service needs wired at boot. */
export interface EscalationServiceDeps {
  /** The ledger, which is both the record and the idempotency check. */
  store: NotificationStore;
  /** The push leg. */
  push: WebPushChannel;
  /**
   * The relay seams, read at send time rather than held — the same boot-order
   * reasoning `NotificationServiceDeps.relay` gives.
   */
  relay?: () => RelayChannelDeps | undefined;
  /** The one knob, read live so a change takes effect without a restart. */
  readDelay: () => EscalationDelay;
  /**
   * Take one off an agent's hourly allowance.
   *
   * Present because an escalation IS an interruption, and the ceiling bounds how
   * often an agent may interrupt somebody however good its reason. Omitted in
   * tests that are not about the budget.
   */
  reserveNote?: (agentId: string) => boolean;
  /** Clock, injectable so a test can age a condition without waiting. */
  now?: () => number;
}

/** The escalation ladder. */
export class EscalationService {
  /** Live timers by subject key. Single digits in practice. */
  private readonly armed = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly now: () => number;

  constructor(private readonly deps: EscalationServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Start the clock on a blocking condition that just began standing.
   *
   * Idempotent: arming a subject that is already armed leaves the first timer
   * alone rather than restarting it, so a seam that fires twice for one
   * condition cannot push the escalation further away.
   *
   * @param kind - Which standing kind.
   * @param payload - That kind's payload, which is also what the push will say.
   */
  arm<K extends StandingNotificationKind>(kind: K, payload: NotificationPayload<K>): void {
    this.armIn(kind, payload, this.delayMs());
  }

  /**
   * Stop the clock, because somebody dealt with it.
   *
   * Takes the subject KEY rather than a typed subject, and that is the whole
   * design: the key is the raising kind's registry `dedupeKey`, built by exactly
   * one function, so arm and cancel cannot drift into naming the same condition
   * two different ways. A second builder here would be the one place that bug
   * could live.
   *
   * Safe to call for a subject that was never armed — most cancels are, since a
   * condition answered inside the delay is the normal case and one answered
   * after the escalation fired has no timer left.
   *
   * @param subjectKey - `notificationEntry(kind).dedupeKey(payload)`.
   */
  cancelByKey(subjectKey: string): void {
    const timer = this.armed.get(subjectKey);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.armed.delete(subjectKey);
  }

  /** Every subject currently waiting on a timer. @internal Exported for tests. */
  armedSubjects(): string[] {
    return [...this.armed.keys()];
  }

  /** Drop every timer. Called when the service is torn down. */
  stop(): void {
    for (const timer of this.armed.values()) clearTimeout(timer);
    this.armed.clear();
  }

  /**
   * Catch up on conditions that were already standing when this process started.
   *
   * Three answers per condition, and the middle one is the point: something that
   * became due while the server was down escalates now (once — the ledger sees to
   * that), something not yet due gets the REMAINDER of its delay rather than a
   * fresh one, and something older than {@link BOOT_CATCH_UP_WINDOW_MS} is left
   * alone because it is a backlog rather than news.
   *
   * @param conditions - What is still standing, from the stores that own it.
   */
  rearmFromStandingState(conditions: readonly StandingCondition[]): void {
    const delayMs = this.delayMs();
    if (delayMs === null) return;

    const at = this.now();
    for (const condition of conditions) {
      const age = at - condition.since;
      if (age > BOOT_CATCH_UP_WINDOW_MS) continue;
      if (age >= delayMs) {
        void this.fire(condition.kind, condition.payload);
        continue;
      }
      this.armIn(condition.kind, condition.payload, delayMs - age);
    }
  }

  /** Arm a subject for a specific number of milliseconds, or not at all. */
  private armIn<K extends StandingNotificationKind>(
    kind: K,
    payload: NotificationPayload<K>,
    delayMs: number | null
  ): void {
    if (delayMs === null) return;

    const key = notificationEntry(kind).dedupeKey(payload);
    if (this.armed.has(key)) return;

    const timer = setTimeout(() => {
      this.armed.delete(key);
      void this.fire(kind, payload);
    }, delayMs);
    // Node keeps the process alive for a pending timer; an escalation must never
    // be the reason a CLI cockpit refuses to exit.
    timer.unref?.();
    this.armed.set(key, timer);
  }

  /**
   * Reach out of the app about one condition nobody has answered.
   *
   * Never throws: an escalation is the last thing standing between a blocked
   * agent and a person, and a chat network being down must not stop the push leg
   * (or the other way round).
   */
  private async fire<K extends StandingNotificationKind>(
    kind: K,
    payload: NotificationPayload<K>
  ): Promise<void> {
    try {
      // The knob is asked again here, not only at arm time: a person who set it
      // to `never` a minute ago meant it about the ping that has not happened
      // yet, not only about ones not yet armed.
      if (this.delayMs() === null) return;

      const entry = notificationEntry(kind);
      const subjectKey = entry.dedupeKey(payload);

      if (this.deps.store.hasEscalated(subjectKey)) return;
      if (this.deps.store.wasAcknowledged(subjectKey)) return;

      const title = entry.title(payload);
      const body = entry.body?.(payload);
      const location = entry.locate(payload);

      // Both legs are started before either is awaited, and neither can fail the
      // other: a rate-limited chat leg still leaves the push leg to reach a
      // phone, which is the whole point of having two.
      const pushLeg = this.deps.push.sendToAll({
        title,
        ...(body ? { body } : {}),
        deepLink: escalationDeepLink(kind, payload),
        notificationId: subjectKey,
        tier: 'blocking',
      });
      const relayLeg = this.sendOverRelay(location.agentId, body ? `${title}\n${body}` : title);

      const [push, relay] = await Promise.all([pushLeg, relayLeg]);

      if (push.delivered > 0) {
        this.recordEscalation(subjectKey, 'web_push', {
          delivered: push.delivered,
          ...(push.pruned > 0 ? { pruned: push.pruned } : {}),
        });
      }
      if (relay?.ok) {
        this.recordEscalation(subjectKey, relayLedgerChannel(relay), relayDetail(relay));
      }

      if (push.delivered === 0 && !relay?.ok) {
        // Worth saying out loud: the operator asked to be reached and nothing
        // could reach them. Not an error — a stock install with no devices and
        // no chat integration is the normal state, and the Settings tab says so.
        logger.debug('[Escalation] Nothing could carry an escalation', {
          subjectKey,
          ...(relay && !relay.ok ? { relayReason: relay.reason } : {}),
        });
      }
    } catch (err) {
      logger.warn('[Escalation] Could not escalate a blocking condition', { err, kind });
    }
  }

  /** Write one escalation into the ledger. */
  private recordEscalation(
    subjectKey: string,
    channel: NotificationChannel,
    detail: Record<string, unknown>
  ): void {
    this.deps.store.recordDelivery({
      subjectKey,
      channel,
      // The flag the boot check reads. Without it, an ordinary delivery about
      // the same subject would read as "already escalated" and suppress the one
      // ping the ladder exists to send.
      detail: { escalated: true, ...detail },
    });
  }

  /**
   * Send the chat leg, or answer `undefined` when there is nothing to send it
   * with.
   *
   * The escalation's `policy` is `'always'` on purpose — see the module doc.
   */
  private async sendOverRelay(
    subjectAgentId: string | undefined,
    message: string
  ): Promise<RelayDeliveryOutcome | undefined> {
    const relayDeps = this.deps.relay?.();
    if (!relayDeps) return undefined;

    const agentId = pickRelayAgent(subjectAgentId, relayDeps);
    if (!agentId) return undefined;

    const reserve = this.deps.reserveNote;
    return deliverOverRelay(
      {
        agentId,
        message,
        policy: 'always',
        fromPrincipal: ESCALATION_PRINCIPAL,
        publishBudget: { ...PUBLISH_BUDGET, ttl: this.now() + PUBLISH_TTL_MS },
        ...(reserve ? { reserve: () => reserve(agentId) } : {}),
      },
      relayDeps
    );
  }

  /** The configured delay in milliseconds, or `null` when the answer is `never`. */
  private delayMs(): number | null {
    const delay = this.deps.readDelay();
    return delay === 'never' ? null : delay * 60 * 1000;
  }
}

/**
 * Which agent's chat bindings carry an escalation.
 *
 * A binding belongs to an agent, and the condition being escalated does not
 * always name one. `ask.pending` and `session.error` resolve theirs from the
 * session's working directory (`agent-path-lookup.ts`, DOR-1408), but that
 * resolution is itself best-effort: it comes up empty for a directory that
 * names no registered agent, or if a session event races Mesh wiring the
 * lookup in at boot. Without a fallback, a subject-less condition — still the
 * routine case on an install where that resolution misses — would leave the
 * headline promise ("a blocked agent reaches your pocket") never reaching
 * Telegram at all.
 *
 * So: the subject's own agent when it named one and that agent can actually
 * initiate somewhere, otherwise the most recently bound agent that can. **This
 * cannot route around consent** — every candidate is a binding the operator
 * enabled AND switched "Agent can start conversations" on for, and it is the
 * same person's phone either way.
 *
 * @param subjectAgentId - The agent the condition named, when it named one.
 * @param deps - The relay seams, for the binding list.
 */
function pickRelayAgent(
  subjectAgentId: string | undefined,
  deps: RelayChannelDeps
): string | undefined {
  const bindings = deps.bindingStore?.getAll() ?? [];
  const eligible = bindings.filter((binding) => binding.enabled && binding.canInitiate);
  if (eligible.length === 0) return subjectAgentId;

  if (subjectAgentId && eligible.some((binding) => binding.agentId === subjectAgentId)) {
    return subjectAgentId;
  }
  const newest = [...eligible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return newest.agentId;
}

/**
 * Where a push about a standing condition takes somebody who taps it.
 *
 * The same three answers the desktop shell's `notificationDeepLink` gives for
 * these subject types, restated here because that one lives in the Electron main
 * process and this payload is built on the server.
 */
function escalationDeepLink<K extends StandingNotificationKind>(
  kind: K,
  payload: NotificationPayload<K>
): string {
  if (kind === 'schedule.parked') return '/tasks';
  const sessionId = (payload as NotificationPayload<'ask.pending'>).sessionId;
  return `/session?session=${encodeURIComponent(sessionId)}`;
}

/** Which ledger column a successful relay delivery belongs in. */
function relayLedgerChannel(
  outcome: Extract<RelayDeliveryOutcome, { ok: true }>
): NotificationChannel {
  if (outcome.surface === 'dorkos-dm') return 'in_app';
  return outcome.adapterType === 'slack' ? 'slack' : 'telegram';
}

/** What the ledger records about where an escalation landed. Never message content. */
function relayDetail(
  outcome: Extract<RelayDeliveryOutcome, { ok: true }>
): Record<string, unknown> {
  if (outcome.surface === 'dorkos-dm') {
    return { surface: outcome.surface, roomId: outcome.roomId, entryId: outcome.entryId };
  }
  return {
    surface: outcome.surface,
    adapterId: outcome.adapterId,
    adapterType: outcome.adapterType,
    chatId: outcome.chatId,
    deliveredTo: outcome.deliveredTo,
  };
}

/**
 * The one live service, so a seam can start or stop a clock without being handed
 * a dependency it has no other use for — the same shape `notify()` takes.
 */
let current: EscalationService | null = null;

/**
 * Install the live escalation service. Called once by the composition root.
 *
 * @param service - The service, or `null` to tear it down.
 */
export function setEscalationService(service: EscalationService | null): void {
  current?.stop();
  current = service;
}

/** The live escalation service, or `null` before boot wired one. */
export function getEscalationService(): EscalationService | null {
  return current;
}

/**
 * Start the clock on a blocking condition, from anywhere.
 *
 * **Never throws**, exactly as `notify()` never does, and for a stronger reason:
 * the three arm seams are a projector callback, a route handler and an MCP tool
 * handler, and a failure to set a reminder must not be able to fail the write
 * that produced the condition. A no-op before boot has wired a service.
 *
 * @param kind - Which standing kind.
 * @param payload - That kind's payload.
 */
export function armEscalation<K extends StandingNotificationKind>(
  kind: K,
  payload: NotificationPayload<K>
): void {
  try {
    current?.arm(kind, payload);
  } catch (err) {
    logger.warn('[Escalation] Could not start the clock on a blocking condition', { err, kind });
  }
}

/**
 * Stop the clock, from anywhere, because somebody dealt with it.
 *
 * Never throws, for the same reason {@link armEscalation} does not — and here it
 * matters more, because the callers are the answer paths: a person answering an
 * Ask must never see that fail because a timer could not be cleared.
 *
 * @param subjectKey - `notificationEntry(kind).dedupeKey(payload)`, which is what
 *   {@link EscalationService.arm} filed the timer under.
 */
export function cancelEscalationByKey(subjectKey: string): void {
  try {
    current?.cancelByKey(subjectKey);
  } catch (err) {
    logger.warn('[Escalation] Could not stop the clock on a blocking condition', {
      err,
      subjectKey,
    });
  }
}

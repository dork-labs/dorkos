/**
 * One pipeline for everything DorkOS tells the operator (spec
 * `notification-system`; ADRs 260819-234827, 260819-234828).
 *
 * A seam that has something to say calls one function. This decides the tier,
 * whether it is worth storing, whether it is a repeat, who may see it, and which
 * channels it may reach — all from the registry entry, none of it at the call
 * site.
 *
 * ## Two entry points, because there are two storage disciplines
 *
 * {@link NotificationService.notify} is for Activity: something happened, so the
 * row IS the record and it is written now.
 *
 * {@link NotificationService.resolveStanding} is for Attention: something was
 * stopped and waiting on a person, the store that owns it already answered "is
 * it still waiting?", and what history is missing is only how it ENDED. So
 * nothing is written while it stands, and exactly one row is written when it
 * resolves, carrying the outcome.
 *
 * They are separate functions rather than one with a flag so the compiler
 * enforces the split: `notify('ask.pending', …)` does not type-check, and a
 * standing condition cannot be accidentally stored while it stands.
 *
 * ## The rules baked in here, so no call site repeats them
 *
 * - **Never interrupt somebody about their own action.** A caller that knows who
 *   acted passes `actorPrincipal`; when that is the operator, the row is written
 *   already-read and no channel is dispatched. History stays complete; the bell
 *   stays quiet.
 * - **Say a thing once.** Every kind declares what makes two of these the same,
 *   and a repeat inside the window is dropped.
 * - **Detail is addressed.** Notification events go only to a connection
 *   entitled to the operator's own view, never to an agent principal.
 *
 * @module services/notifications/notification-service
 */
import type {
  ListNotificationsQuery,
  ListNotificationsResponse,
  MarkNotificationsReadResponse,
  NotificationChannel,
  NotificationDTO,
  NotificationOutcome,
} from '@dorkos/shared/notification-schemas';
import type { CallerPrincipal } from '../../lib/caller-principal.js';
import { logger } from '../../lib/logger.js';
import { broadcastNotification, broadcastNotificationRead } from './notification-events.js';
import {
  DEFAULT_DEDUPE_WINDOW_MS,
  notificationEntry,
  resolvePerKind,
  type EventNotificationKind,
  type NotificationPayload,
  type StandingNotificationKind,
} from './notification-registry.js';
import type { NotificationStore } from './notification-store.js';
import { cancelEscalationByKey } from './escalation-service.js';
import { broadcastStandingResolved } from './standing-events.js';
import {
  deliverOverRelay,
  type RelayChannelDeps,
  type RelayDeliveryOutcome,
  type RelayDeliveryRequest,
} from './channels/relay.js';

/** The per-call decisions the relay channel cannot make on its own. */
export type NotifyRelayOptions = Omit<RelayDeliveryRequest, 'agentId' | 'message' | 'policy'>;

/** What a caller can tell the pipeline beyond the payload itself. */
export interface NotifyOptions {
  /**
   * Who caused this, when the seam knows.
   *
   * The operator gets no interruption about something they just did. Omitted
   * where the cause genuinely is not identifiable — a turn finishing does not
   * know whether the message that started it was typed here or arrived over a
   * bridge — and in that case the notification is raised normally.
   */
  actorPrincipal?: CallerPrincipal;
  /** How to reach out of the app, for the kinds allowed to. */
  relay?: NotifyRelayOptions;
  /**
   * A delivery the caller already made, to record rather than repeat.
   *
   * For a seam that has to know where its message landed before it can answer —
   * `relay_notify_user` tells the agent whether the note went to Telegram or to
   * a DorkOS DM, and its wording depends on which. It holds every relay seam
   * itself, so it sends through {@link deliverOverRelay} directly and hands the
   * outcome here. Both paths run the same delivery code; this one just runs it
   * first.
   *
   * Never pass this together with {@link relay} — it takes precedence, and
   * passing both would read as "send it and also record a different send".
   */
  delivered?: RelayDeliveryOutcome;
}

/** What happened to one `notify()` call. */
export interface NotifyResult {
  /** The stored row, or `null` when nothing was stored. */
  notification: NotificationDTO | null;
  /** Whether this was suppressed as a repeat of something already said. */
  deduped: boolean;
  /** Where it got to out of the app, when it was allowed out at all. */
  relay?: RelayDeliveryOutcome;
}

/**
 * Channel refusals that mean the notification does not happen AT ALL, rather
 * than happening in the app and not reaching a phone.
 *
 * Both are about an agent's own note, and both would otherwise leave a row that
 * the thing refusing was supposed to prevent:
 *
 * - `RATE_LIMITED` — the agent has said as much as it may this hour. A ceiling
 *   that bounded only the chat leg would let a looping agent fill the inbox
 *   instead, which is the same interruption by a quieter route.
 * - `INITIATE_NOT_ALLOWED` — the operator switched "Agent can start
 *   conversations" OFF on the binding this resolved to. That is a person saying
 *   "do not start conversations with me", and honouring it on Telegram while
 *   still writing an inbox row would be reading the switch as being about
 *   Telegram. It is about being interrupted.
 *
 * Every other refusal is a delivery problem, not a decision: the news still
 * happened, so the row is still written and the inbox is where it is found.
 */
const SILENCES_EVERY_SURFACE = new Set<string>(['RATE_LIMITED', 'INITIATE_NOT_ALLOWED']);

/** What the service needs wired at boot. */
export interface NotificationServiceDeps {
  /**
   * The relay seams, read at send time rather than held.
   *
   * A function because of BOOT ORDER. Several things that raise notifications —
   * the dead-letter hook, the mesh liveness observer — subscribe early, while
   * the relay core and adapter manager they would send through are built much
   * later in `start()`. Taking the seams as a value would mean either
   * constructing the service after those subscribers (leaving a window where a
   * dead letter goes unrecorded) or handing it a half-built bag. Asking for them
   * per send costs nothing and removes the ordering constraint entirely.
   *
   * Answering `undefined` is normal and means "no out-of-app leg" — an install
   * with relay off, or a boot that has not reached the relay yet.
   */
  relay?: () => RelayChannelDeps | undefined;
}

/** The notification pipeline. */
export class NotificationService {
  constructor(
    private readonly store: NotificationStore,
    private readonly deps: NotificationServiceDeps = {}
  ) {}

  /**
   * Raise an Activity notification: something happened.
   *
   * Never throws — a notification is the least important thing a caller is
   * doing, and it must never be able to fail the work that produced it.
   *
   * @param kind - Which registry entry.
   * @param payload - That kind's payload.
   * @param opts - Who acted, and how to reach out of the app.
   */
  async notify<K extends EventNotificationKind>(
    kind: K,
    payload: NotificationPayload<K>,
    opts: NotifyOptions = {}
  ): Promise<NotifyResult> {
    try {
      return await this.raise(kind, payload, opts, {});
    } catch (err) {
      logger.warn('[Notifications] Could not raise a notification', { err, kind });
      return { notification: null, deduped: false };
    }
  }

  /**
   * Record that a standing condition ended, and how.
   *
   * This is the only row a standing kind ever writes. It is what makes the
   * history honest: an Ask nobody answered becomes a row saying `expired`
   * rather than quietly disappearing.
   *
   * @param kind - Which standing registry entry.
   * @param payload - That kind's payload.
   * @param opts - The outcome, plus who acted when the seam knows.
   */
  async resolveStanding<K extends StandingNotificationKind>(
    kind: K,
    payload: NotificationPayload<K>,
    opts: NotifyOptions & { outcome: NotificationOutcome }
  ): Promise<NotifyResult> {
    // A standing condition that ENDED is the strongest acknowledgement there is,
    // whoever or whatever ended it — so every resolution disarms the escalation
    // ladder, in one place rather than at each of the three seams that can
    // produce one. Synchronous and before anything else here, because `raise()`
    // below awaits a chat network and a phone ping must not slip out in that
    // window about something a person just dealt with.
    const subjectKey = notificationEntry(kind).dedupeKey(payload);
    cancelEscalationByKey(subjectKey);
    // And tell the periphery to retire what it drew when this began standing
    // (DOR-1570). Same reasoning, same moment: a desktop banner about a
    // schedule somebody just approved is the interruption the tiering exists to
    // prevent.
    //
    // Fired for EVERY standing kind this function serves, including the two
    // that are never announced via `standing_pending`: `ask.pending` (its
    // arrival rides `interaction_pending`, and its resolution rides
    // `interaction_resolved`) and `session.error` (out of DOR-1570's scope, not
    // announced at all). For those, this names a `subjectKey` no surface ever
    // drew a standing banner from, so every listener — the desktop's
    // `retireStanding`, any future one — treats it as a no-op. Emitting it
    // unconditionally is deliberate: gating it on "was this kind announced?"
    // would put that fact in two places, and a harmless resolve for an
    // unheld subject is cheaper than a rule that can rot.
    broadcastStandingResolved(kind, subjectKey);

    try {
      return await this.raise(kind, payload, opts, {
        resolvedAt: new Date().toISOString(),
        outcome: opts.outcome,
      });
    } catch (err) {
      logger.warn('[Notifications] Could not record a resolution', { err, kind });
      return { notification: null, deduped: false };
    }
  }

  /**
   * One page of history, plus the unread count the bell draws.
   *
   * @param query - Cursor, page size, and the lens filters.
   */
  list(query: ListNotificationsQuery): ListNotificationsResponse {
    const page = this.store.list(query);
    return { ...page, unreadCount: this.store.unreadCount() };
  }

  /**
   * The subjects of one standing kind whose history still reads as live — a
   * raise row with nothing after it.
   *
   * For the boot repair a `standing-recorded` kind needs: its "is it still
   * waiting?" store is in memory, so a restart mid-episode leaves a raise row
   * that no recovery edge will ever answer. See
   * {@link NotificationStore.unresolvedStandingSubjects}.
   *
   * @param kind - The standing kind to look at.
   */
  unresolvedStanding(kind: StandingNotificationKind): Array<{
    subjectId: string;
    payload: unknown;
  }> {
    return this.store.unresolvedStandingSubjects(kind);
  }

  /**
   * Mark one notification read, and tell every other window.
   *
   * @param id - The notification to mark.
   */
  markRead(id: string): MarkNotificationsReadResponse {
    const marked = this.store.markRead(id);
    const unreadCount = this.store.unreadCount();
    if (marked > 0) {
      broadcastNotificationRead({
        ids: [id],
        all: false,
        readAt: new Date().toISOString(),
        unreadCount,
      });
    }
    return { ok: true, marked, unreadCount };
  }

  /** Mark every unread notification read, and tell every other window. */
  markAllRead(): MarkNotificationsReadResponse {
    const marked = this.store.markAllRead();
    const unreadCount = this.store.unreadCount();
    if (marked > 0) {
      broadcastNotificationRead({
        ids: [],
        all: true,
        readAt: new Date().toISOString(),
        unreadCount,
      });
    }
    return { ok: true, marked, unreadCount };
  }

  /**
   * Mark every `dm.received` / `mention.received` row in one room read, up to
   * where the room's read cursor now stands (read-cursor auto-read, spec
   * `notification-system` task T11) — the same reasoning as {@link
   * NotificationService.markRead}, aimed at a whole room's rows a cursor just
   * passed rather than one id a click named.
   *
   * @param roomId - The room whose cursor moved.
   * @param uptoSeq - The entry `seq` the cursor now stands at.
   */
  markRoomRead(roomId: string, uptoSeq: number): MarkNotificationsReadResponse {
    const ids = this.store.markRoomEntriesRead(roomId, uptoSeq);
    const unreadCount = this.store.unreadCount();
    if (ids.length > 0) {
      broadcastNotificationRead({ ids, all: false, readAt: new Date().toISOString(), unreadCount });
    }
    return { ok: true, marked: ids.length, unreadCount };
  }

  /**
   * The shared body of both entry points: dedupe, dispatch, store, announce.
   *
   * **The channel goes first, and that ordering is load-bearing.** An agent's
   * own note is bounded by an hourly allowance, and a note refused by that
   * allowance must leave nothing behind — a row in the inbox is still the agent
   * talking, so storing one anyway would turn a bound into a formality. Every
   * other kind carries no allowance, so `RATE_LIMITED` cannot arise for it and
   * the rule is inert. The relay publish is an in-process hand-off to the
   * message bus rather than a wait on a chat network, so nothing is delayed by
   * asking first.
   *
   * **Accepted ordering hazard: a caller's own primary write can be visible
   * on its OWN stream a beat before this settles and broadcasts on the
   * `notification` stream.** `notify()` is fire-and-forget by contract (its
   * doc says so), and a seam like `RoomService.writePost` publishes the room
   * entry synchronously and only then calls `notify()` — so a client watching
   * both the room's SSE stream and the notification stream can, for a few
   * milliseconds, see the new room entry before the inbox row that explains
   * it. This is not reordered to close that gap: the RATE_LIMITED rule above
   * requires the channel dispatch to run and settle before the row is even
   * decided, so an insert-first order would either lose that guarantee or
   * require a second write to retract a row the allowance then refused. The
   * gap is eventual consistency, not a correctness bug — every reader
   * converges once `notify()`'s promise resolves — and is deliberately left
   * as a documented trade-off rather than a `TODO`.
   *
   * @param kind - Which registry entry.
   * @param payload - That kind's payload.
   * @param opts - Who acted, and how to reach out of the app.
   * @param resolution - The resolution fields, on the standing path only.
   */
  private async raise<K extends EventNotificationKind | StandingNotificationKind>(
    kind: K,
    payload: NotificationPayload<K>,
    opts: NotifyOptions,
    resolution: { resolvedAt?: string; outcome?: NotificationOutcome }
  ): Promise<NotifyResult> {
    const entry = notificationEntry(kind);
    const dedupeKey = entry.dedupeKey(payload);
    const alreadySaid = this.store.findRecent(
      dedupeKey,
      entry.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS
    );
    if (alreadySaid) {
      // Saying the same thing twice is suppressed, but SENDING it twice is not
      // the same event. A caller that delivered the note itself (the
      // `relay_notify_user` path) really did reach somebody a second time, and
      // the ledger is the record of what reached them — so the delivery is
      // written against the row that already exists. Without this, "seen on
      // Telegram at 4pm and again at 4.02" is unanswerable, which is precisely
      // the question the ledger is for.
      if (opts.delivered?.ok) {
        this.store.recordDelivery({
          notificationId: alreadySaid,
          subjectKey: dedupeKey,
          channel: ledgerChannel(opts.delivered),
          detail: deliveryDetail(opts.delivered),
        });
      }
      return {
        notification: null,
        deduped: true,
        ...(opts.delivered ? { relay: opts.delivered } : {}),
      };
    }

    const ownAction = opts.actorPrincipal?.kind === 'operator';
    const location = entry.locate(payload);
    const title = entry.title(payload);
    const body = entry.body?.(payload);

    const relay =
      opts.delivered ??
      (await this.dispatchRelay(kind, payload, opts, location.agentId, ownAction, { title, body }));
    if (relay?.ok === false && SILENCES_EVERY_SURFACE.has(relay.reason)) {
      return { notification: null, deduped: false, relay };
    }

    const notification = this.store.insert({
      kind,
      tier: resolvePerKind(entry.tier, payload),
      subjectType: entry.subjectType,
      subjectId: location.subjectId,
      ...(location.agentId ? { agentId: location.agentId } : {}),
      ...(location.sessionId ? { sessionId: location.sessionId } : {}),
      ...(location.roomId ? { roomId: location.roomId } : {}),
      title,
      ...(body ? { body } : {}),
      payload,
      dedupeKey,
      read: ownAction || somebodyActed(resolution.outcome),
      ...resolution,
    });

    if (relay?.ok) {
      this.store.recordDelivery({
        notificationId: notification.id,
        subjectKey: dedupeKey,
        channel: ledgerChannel(relay),
        detail: deliveryDetail(relay),
      });
    }

    broadcastNotification(notification);
    return { notification, deduped: false, ...(relay ? { relay } : {}) };
  }

  /**
   * Hand the notification to the relay channel, when its kind is allowed out and
   * the caller supplied the per-send terms.
   *
   * Returns `undefined` — not a failure — when the kind never leaves the app,
   * when the operator caused it themselves, or when the caller had nothing to
   * send it with. Only an attempt produces an outcome.
   */
  private async dispatchRelay<K extends EventNotificationKind | StandingNotificationKind>(
    kind: K,
    payload: NotificationPayload<K>,
    opts: NotifyOptions,
    agentId: string | undefined,
    ownAction: boolean,
    text: { title: string; body?: string }
  ): Promise<RelayDeliveryOutcome | undefined> {
    const entry = notificationEntry(kind);
    const policy = resolvePerKind(entry.relay, payload);
    if (policy === 'never' || ownAction) return undefined;

    const relayOpts = opts.relay;
    const relayDeps = this.deps.relay?.();
    if (!relayOpts || !agentId || !relayDeps) return undefined;

    const message = entry.channelMessage?.(payload) ?? messageFrom(text);
    return deliverOverRelay({ ...relayOpts, agentId, message, policy }, relayDeps);
  }
}

/**
 * Whether a standing condition ended because somebody dealt with it.
 *
 * A history row for something a person just did arrives already read — they were
 * there, and a bell that lit up for their own click would be noise. A condition
 * that ended because NOBODY dealt with it is the opposite: an Ask that expired
 * unanswered, or one cancelled out from under a person, is precisely the thing
 * they should find waiting. That distinction is why the outcome decides this
 * rather than `actorPrincipal`, which several of these seams cannot supply.
 *
 * @param outcome - How it ended, or `undefined` on the Activity path.
 */
function somebodyActed(outcome: NotificationOutcome | undefined): boolean {
  return (
    outcome === 'answered' ||
    outcome === 'approved' ||
    outcome === 'rejected' ||
    outcome === 'cleared'
  );
}

/** The sentence an out-of-app channel says when the kind did not supply its own. */
function messageFrom(text: { title: string; body?: string }): string {
  return text.body ? `${text.title}\n${text.body}` : text.title;
}

/**
 * Which ledger column a successful delivery belongs in.
 *
 * A DorkOS DM is `in_app`: it landed in a room inside DorkOS, which is a
 * different surface from a phone but the same machine. An external chat is named
 * by its adapter type. Telegram and Slack are the only two adapter types that
 * exist, so the ledger enum names exactly those; a third one arriving means
 * adding a member to `NOTIFICATION_CHANNELS` and a branch here, which is a
 * change a reviewer should see rather than a row silently mislabelled.
 */
function ledgerChannel(outcome: Extract<RelayDeliveryOutcome, { ok: true }>): NotificationChannel {
  if (outcome.surface === 'dorkos-dm') return 'in_app';
  return outcome.adapterType === 'slack' ? 'slack' : 'telegram';
}

/** What the ledger records about where a delivery landed. Never message content. */
function deliveryDetail(
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
 * The one live service, so a seam can say something without being handed a
 * dependency it has no other use for.
 *
 * The same shape as `eventFanOut` and `runtimeRegistry`: cross-cutting
 * infrastructure that boot assigns once, rather than a domain service threaded
 * through eight call chains that would otherwise have no reason to know about
 * notifications at all.
 */
let current: NotificationService | null = null;

/**
 * Install the live service. Called once by the composition root.
 *
 * @param service - The service, or `null` to tear it down.
 */
export function setNotificationService(service: NotificationService | null): void {
  current = service;
}

/** The live service, or `null` before boot wired one. */
export function getNotificationService(): NotificationService | null {
  return current;
}

/**
 * Raise an Activity notification from anywhere.
 *
 * The free function every seam calls. Fire-and-forget: it never throws, and it
 * never makes the caller wait on a chat network — `void notify(...)` is the
 * expected form.
 *
 * @param kind - Which registry entry.
 * @param payload - That kind's payload.
 * @param opts - Who acted, and how to reach out of the app.
 */
export async function notify<K extends EventNotificationKind>(
  kind: K,
  payload: NotificationPayload<K>,
  opts: NotifyOptions = {}
): Promise<NotifyResult> {
  if (!current) {
    logger.debug('[Notifications] Nothing raised: no service is wired', { kind });
    return { notification: null, deduped: false };
  }
  return current.notify(kind, payload, opts);
}

/**
 * Record that a standing condition ended, from anywhere.
 *
 * @param kind - Which standing registry entry.
 * @param payload - That kind's payload.
 * @param opts - The outcome, plus who acted when the seam knows.
 */
export async function resolveStanding<K extends StandingNotificationKind>(
  kind: K,
  payload: NotificationPayload<K>,
  opts: NotifyOptions & { outcome: NotificationOutcome }
): Promise<NotifyResult> {
  if (!current) {
    logger.debug('[Notifications] Nothing recorded: no service is wired', { kind });
    return { notification: null, deduped: false };
  }
  return current.resolveStanding(kind, payload, opts);
}

/**
 * Which subjects of a standing kind history still shows as live, from anywhere.
 *
 * An empty list, not a throw, before boot has wired a service: the one caller is
 * a boot-time repair, and "nothing to repair" is the honest answer when there is
 * no store to read.
 *
 * @param kind - The standing kind to look at.
 */
export function unresolvedStanding(kind: StandingNotificationKind): Array<{
  subjectId: string;
  payload: unknown;
}> {
  if (!current) {
    logger.debug('[Notifications] Nothing read: no service is wired', { kind });
    return [];
  }
  return current.unresolvedStanding(kind);
}

/**
 * Mark a room's `dm.received` / `mention.received` rows read up to where its
 * cursor now stands, from anywhere — the read-cursor auto-read hook
 * (`RoomService.setReadCursor` calls this directly, the same way a route calls
 * {@link notify}). A no-op, not a throw, before boot has wired a service: a
 * cursor move must never fail because the inbox is not up yet.
 *
 * @param roomId - The room whose cursor moved.
 * @param uptoSeq - The entry `seq` the cursor now stands at.
 */
export function markRoomRead(roomId: string, uptoSeq: number): MarkNotificationsReadResponse {
  if (!current) {
    logger.debug('[Notifications] Nothing marked: no service is wired', { roomId });
    return { ok: true, marked: 0, unreadCount: 0 };
  }
  return current.markRoomRead(roomId, uptoSeq);
}

import log from 'electron-log';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { NotificationDTO, StandingPendingEvent } from '@dorkos/shared/notification-schemas';
import {
  parseEventPayload,
  subscribeEventStream,
  type GetServerPort,
  type ServerEventFrame,
} from '../event-stream';
import {
  askCopy,
  askDeepLink,
  earnsNativeBanner,
  notificationDeepLink,
  replyEligibility,
  standingCopy,
} from './copy';
import { approveTool, denyTool, submitReplyAnswer, type AnswerOutcome } from './answer';
import {
  electronNotificationHost,
  type NativeNotificationHandle,
  type NativeNotificationSpec,
  type NotificationHost,
} from './wrapper';

/**
 * Native desktop notifications for the two tiers allowed to leave the app:
 * Blocking, always; Notable, only while no DorkOS window has focus (spec
 * `notification-system`, Desktop section; ADR 260819-234830).
 *
 * Three live signals feed this, all riding the shared connection in
 * `event-stream.ts`:
 *
 * - `interaction_pending` / `interaction_resolved` — the existing addressed
 *   Ask stream (DOR-1356). An Ask is Attention: nothing is broadcast on the
 *   `notification` channel while it stands (see `notification-service.ts`'s
 *   module doc), so this is the ONLY live signal for a Blocking Ask, and the
 *   one place actions (Allow/Deny/Reply) apply — they answer a specific
 *   interaction, which only this event names.
 * - `standing_pending` / `standing_resolved` — every OTHER Attention condition
 *   (DOR-1570). An Ask was not the only thing that stores nothing while it
 *   stands: a schedule an agent proposes and an approval it needs for
 *   something irreversible are both standing conditions too, and until this
 *   pair existed the desktop app showed NOTHING for either — no banner, no
 *   dock badge, nothing. The operator had to ask an agent to open the Tasks
 *   panel to find out something was waiting on them. Click-to-open, with no
 *   action buttons: deciding an irreversible action, or a schedule that will
 *   run unattended, deserves the card in front of you.
 * - `notification` / `notification_read` — the Activity pipeline (turn/run
 *   completion, DMs, mentions, and Attention kinds' resolution history). These
 *   arrive pre-built with a title and a tier; a row that resolved because the
 *   operator just acted on it arrives already read (`readAt` set) and is
 *   deliberately skipped — popping a banner about a person's own click would
 *   be the exact noise the tiering exists to prevent.
 *
 * All three are OS banners, which ADR 260819-234830 admits to the periphery.
 * None of them is an in-app toast: the toast diet (spec `notification-system`
 * §6) is intact, and nothing here adds one.
 *
 * @module main/notifications
 */

/** How many shown notifications to remember for de-dupe and close-on-resolve, before the oldest is forgotten. */
const MAX_TRACKED_NOTIFICATIONS = 200;

/**
 * Grace added to a standing condition's expiry timer so it fires strictly AFTER
 * the deadline the server enforces (`now > expiresAt`). Mirrors the same slack
 * `usePendingApprovals` uses in the React app.
 */
const EXPIRY_SLACK_MS = 500;

/**
 * Longest delay `setTimeout` honors: 2^31 - 1 ms (~24.8 days). A larger value is
 * silently clamped to 1ms by the platform and would fire immediately, so a
 * deadline further out than this is left un-timed rather than mis-timed — the
 * banner then relies on `standing_resolved` alone, which is the pre-fix
 * behaviour and no worse than it. Nothing a correct server writes gets near this
 * (the approval window is two hours), but `expiresAt` is an unbounded wire
 * string and a machine with a badly wrong clock could land here.
 */
const MAX_EXPIRY_TIMEOUT_MS = 2_147_483_647;

/** Options for {@link watchNotifications}. */
export interface NotificationsOptions {
  /** Point-in-time accessor for the server's port; `null` while no server is running. */
  getPort: GetServerPort;
  /** True when no DorkOS window currently has OS focus. */
  isWindowUnfocused: () => boolean;
  /** Bring a window forward (creating one if needed) and route it to a client path. */
  focusAndNavigate: (path: string) => void;
  /** Where to show and dismiss native banners. Defaults to the real Electron host. */
  host?: NotificationHost;
}

/** A running subscription to the notification stream. */
export interface NotificationsWatch {
  /** Stop watching and drop the connection. */
  stop(): void;
}

/**
 * Watch for Asks and Activity notifications, and show native banners for the
 * ones that earn one.
 *
 * A no-op on a platform that cannot show native notifications at all (checked
 * once, up front) — there is nothing to subscribe for.
 *
 * @param options - See {@link NotificationsOptions}.
 * @returns A handle that stops the watch.
 */
export function watchNotifications(options: NotificationsOptions): NotificationsWatch {
  const host = options.host ?? electronNotificationHost;
  if (!host.isSupported()) {
    log.warn('[notifications] Native notifications are not supported on this platform.');
    return { stop(): void {} };
  }

  /** Live Ask banners, by interaction id — closed when `interaction_resolved` names them. */
  const shownAsks = new Map<string, NativeNotificationHandle>();
  /**
   * Live standing-condition banners, by subject key — closed when
   * `standing_resolved` names them. Keyed on the server's own `dedupeKey`, so
   * an arrival and its resolution cannot name one condition two ways.
   */
  const shownStanding = new Map<string, NativeNotificationHandle>();
  /**
   * Self-retirement timers for standing conditions that expire without anybody
   * acting, by subject key. Expiry is the one ending the server never announces
   * (see `StandingPendingEvent.expiresAt`), so an approval that runs out of time
   * with no agent retry and no operator click would otherwise leave its banner
   * up forever. Cleared when `standing_resolved` arrives first, or when the
   * timer itself retires the banner.
   */
  const standingExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Activity banners, by notification id. `null` means the id was seen and
   * deliberately not shown (already read, or its tier didn't earn one) — kept
   * so a duplicate upsert of the same id is never reconsidered.
   */
  const shownDtos = new Map<string, NativeNotificationHandle | null>();

  const onFrame = (frame: ServerEventFrame): void => {
    switch (frame.name) {
      case 'interaction_pending':
        handleAskPending(frame.data);
        return;
      case 'interaction_resolved':
        handleAskResolved(frame.data);
        return;
      case 'standing_pending':
        handleStandingPending(frame.data);
        return;
      case 'standing_resolved':
        handleStandingResolved(frame.data);
        return;
      case 'notification':
        handleNotificationUpsert(frame.data);
        return;
      case 'notification_read':
        handleNotificationRead(frame.data);
        return;
      default:
        return;
    }
  };

  function handleAskPending(data: string): void {
    const ask = parseInteractionPending(data);
    if (!ask || shownAsks.has(ask.interaction.id)) return;

    const copy = askCopy(ask);
    const spec: NativeNotificationSpec = {
      title: copy.title,
      body: copy.body,
      onClick: () => options.focusAndNavigate(askDeepLink(ask)),
    };

    if (ask.interaction.type === 'approval') {
      spec.actions = [{ label: 'Allow' }, { label: 'Deny' }];
      spec.onAction = (index) => void handleApprovalAction(ask, index);
    } else {
      const reply = replyEligibility(ask.interaction);
      if (reply) {
        spec.hasReply = true;
        spec.replyPlaceholder = reply.placeholder;
        spec.onReply = (text) => void handleReplyAction(ask, text);
      }
      // A multi-question Ask or an elicitation gets no action: click opens the
      // app, where the full form is the honest place to answer it.
    }

    trackWithCap(shownAsks, ask.interaction.id, host.show(spec));
  }

  function handleAskResolved(data: string): void {
    const interactionId = parseInteractionResolvedId(data);
    if (!interactionId) return;
    shownAsks.get(interactionId)?.close();
    shownAsks.delete(interactionId);
  }

  function handleStandingPending(data: string): void {
    const event = parseStandingPending(data);
    if (!event || shownStanding.has(event.subjectKey)) return;
    // The same tier rule every other banner takes, asked once here rather than
    // assumed: today every standing kind is Blocking, and a future one that is
    // not must obey the away-only rule like anything else Notable.
    if (!earnsNativeBanner(event.tier, options.isWindowUnfocused())) return;

    const copy = standingCopy(event);
    const handle = host.show({
      title: copy.title,
      ...(copy.body ? { body: copy.body } : {}),
      onClick: () => options.focusAndNavigate(event.deepLink),
    });
    trackWithCap(shownStanding, event.subjectKey, handle);
    armStandingExpiry(event.subjectKey, event.expiresAt);
  }

  /**
   * Retire a standing banner, from whichever ending reaches it first — a
   * `standing_resolved` event or its own expiry deadline. Idempotent: a timer
   * that fired and a resolution that arrived after it both land here, and the
   * second is a no-op.
   */
  function retireStanding(subjectKey: string): void {
    shownStanding.get(subjectKey)?.close();
    shownStanding.delete(subjectKey);
    const timer = standingExpiryTimers.get(subjectKey);
    if (timer !== undefined) {
      clearTimeout(timer);
      standingExpiryTimers.delete(subjectKey);
    }
  }

  /**
   * Arm the self-retirement timer for a condition that expires with nobody
   * acting. Only `approval.pending` carries an `expiresAt`; a parked schedule
   * has none and relies on `standing_resolved` alone, which it always sends.
   *
   * A deadline already past retires immediately; one further out than the
   * platform's timer ceiling is left to `standing_resolved` rather than mis-armed
   * to fire at once.
   */
  function armStandingExpiry(subjectKey: string, expiresAt: string | undefined): void {
    if (!expiresAt) return;
    const deadline = Date.parse(expiresAt);
    if (Number.isNaN(deadline)) return;
    const delay = deadline + EXPIRY_SLACK_MS - Date.now();
    if (delay <= 0) {
      retireStanding(subjectKey);
      return;
    }
    if (delay > MAX_EXPIRY_TIMEOUT_MS) return;
    const timer = setTimeout(() => retireStanding(subjectKey), delay);
    // Never let a pending banner timer keep the process alive.
    timer.unref?.();
    standingExpiryTimers.set(subjectKey, timer);
  }

  function handleStandingResolved(data: string): void {
    const subjectKey = parseStandingResolvedKey(data);
    if (!subjectKey) return;
    retireStanding(subjectKey);
  }

  function handleNotificationUpsert(data: string): void {
    const dto = parseNotificationUpsert(data);
    if (!dto || shownDtos.has(dto.id)) return;

    // Already read means either the operator's own action resolved it, or it
    // was read on another window before this one caught up — either way
    // nothing is waiting on a banner.
    if (dto.readAt || !earnsNativeBanner(dto.tier, options.isWindowUnfocused())) {
      trackWithCap(shownDtos, dto.id, null);
      return;
    }

    const handle = host.show({
      title: dto.title,
      body: dto.body,
      onClick: () => options.focusAndNavigate(notificationDeepLink(dto)),
    });
    trackWithCap(shownDtos, dto.id, handle);
  }

  function handleNotificationRead(data: string): void {
    const read = parseNotificationRead(data);
    if (!read) return;
    const ids = read.all ? [...shownDtos.keys()] : read.ids;
    for (const id of ids) {
      const handle = shownDtos.get(id);
      if (handle) {
        handle.close();
        shownDtos.set(id, null);
      }
    }
  }

  /**
   * What to do after an answer-route call didn't succeed.
   *
   * `refused` means the server understood the click and said no — the Ask was
   * already resolved (someone else answered it, or it timed out and parked)
   * or the id no longer exists. Stealing focus to reopen a card that isn't
   * there any more would surprise the person for nothing; the banner already
   * did what it could. Every other reason — no server yet, no credential, the
   * request never landed — is one focus+deep-link can actually help with: it
   * puts the person in front of the app to retry by hand.
   *
   * @param ask - The Ask the click was answering.
   * @param outcome - What the answer route reported.
   */
  function handleAnswerOutcome(ask: InteractionPendingEvent, outcome: AnswerOutcome): void {
    if (outcome.ok) return;
    if (outcome.reason === 'refused') {
      log.warn(
        `[notifications] The server refused to answer the Ask on session ${ask.sessionId} ` +
          '(already resolved, or the id no longer exists); not stealing focus for it.'
      );
      return;
    }
    options.focusAndNavigate(askDeepLink(ask));
  }

  async function handleApprovalAction(ask: InteractionPendingEvent, index: number): Promise<void> {
    // Index 0 is `Allow`, index 1 is `Deny` — the same order `spec.actions`
    // above listed them in; Electron's own callback names an action only by
    // that index.
    const outcome =
      index === 0
        ? await approveTool(options.getPort, ask.sessionId, ask.interaction.id)
        : await denyTool(options.getPort, ask.sessionId, ask.interaction.id);
    handleAnswerOutcome(ask, outcome);
  }

  async function handleReplyAction(ask: InteractionPendingEvent, reply: string): Promise<void> {
    const outcome = await submitReplyAnswer(
      options.getPort,
      ask.sessionId,
      ask.interaction.id,
      reply
    );
    handleAnswerOutcome(ask, outcome);
  }

  const subscription = subscribeEventStream({ getPort: options.getPort }, { onFrame });

  return {
    stop(): void {
      subscription.unsubscribe();
      shownAsks.clear();
      shownStanding.clear();
      for (const timer of standingExpiryTimers.values()) clearTimeout(timer);
      standingExpiryTimers.clear();
      shownDtos.clear();
    },
  };
}

/** Insert into `map`, forgetting the oldest entry once it grows past the cap. */
function trackWithCap<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size <= MAX_TRACKED_NOTIFICATIONS) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * Parse an `interaction_pending` frame's payload, tolerating anything that
 * isn't shaped like one.
 *
 * Shallow on purpose, the same trade `agent-activity.ts` makes for
 * `session_status`: the two fields checked are what this module branches on,
 * and importing `InteractionPendingEventSchema` to validate the rest would
 * pull the interaction contract (and zod-to-openapi with it) into the
 * main-process bundle for a check this module has no use for.
 *
 * @param data - The frame's raw `data:` payload.
 */
function parseInteractionPending(data: string): InteractionPendingEvent | null {
  const payload = parseEventPayload(data);
  if (typeof payload?.sessionId !== 'string' || typeof payload.cwd !== 'string') return null;
  const interaction = payload.interaction;
  if (typeof interaction !== 'object' || interaction === null) return null;
  const type = (interaction as { type?: unknown }).type;
  const id = (interaction as { id?: unknown }).id;
  if (typeof id !== 'string') return null;
  if (type !== 'approval' && type !== 'question' && type !== 'elicitation') return null;
  // `copy.ts` destructures `.questions` for a question-type interaction; a
  // missing or malformed array there would throw instead of failing closed
  // here, which is what this parser's own "tolerates anything that isn't
  // shaped like one" doc promises.
  if (type === 'question' && !Array.isArray((interaction as { questions?: unknown }).questions)) {
    return null;
  }
  return payload as unknown as InteractionPendingEvent;
}

/** Read the `interactionId` off an `interaction_resolved` payload. */
function parseInteractionResolvedId(data: string): string | null {
  const payload = parseEventPayload(data);
  return typeof payload?.interactionId === 'string' ? payload.interactionId : null;
}

/**
 * Parse a `standing_pending` frame down to the fields this module reads.
 *
 * By hand, for the reason {@link parseInteractionPending} gives: validating
 * with `StandingPendingEventSchema` would pull zod (and zod-to-openapi with it)
 * into the main-process bundle for a check on five fields.
 *
 * `tier` is checked against the enum rather than merely for presence, the same
 * way that parser checks an interaction's `type`: it is what `earnsNativeBanner`
 * branches on, and an unrecognised value would fall through to "show it
 * always", which is the wrong direction to fail in for a banner.
 */
function parseStandingPending(data: string): StandingPendingEvent | null {
  const payload = parseEventPayload(data);
  if (!payload) return null;
  const { kind, subjectKey, tier, title, body, deepLink, since, expiresAt } = payload;
  if (typeof kind !== 'string' || typeof subjectKey !== 'string' || subjectKey.length === 0) {
    return null;
  }
  if (tier !== 'blocking' && tier !== 'notable' && tier !== 'quiet') return null;
  if (typeof title !== 'string' || title.length === 0) return null;
  if (typeof deepLink !== 'string' || deepLink.length === 0) return null;
  if (body !== undefined && typeof body !== 'string') return null;
  return {
    kind,
    subjectKey,
    tier,
    title,
    ...(body ? { body } : {}),
    deepLink,
    since: typeof since === 'string' ? since : '',
    // Carried through so the bridge can arm its own retirement timer for a
    // condition that expires without anybody acting. A non-string is dropped
    // rather than passed on — `armStandingExpiry` would `Date.parse` it to
    // `NaN` and skip it anyway, but failing closed here keeps the shape honest.
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
  } as StandingPendingEvent;
}

/** Read the `subjectKey` off a `standing_resolved` payload. */
function parseStandingResolvedKey(data: string): string | null {
  const payload = parseEventPayload(data);
  const subjectKey = payload?.subjectKey;
  return typeof subjectKey === 'string' && subjectKey.length > 0 ? subjectKey : null;
}

/**
 * Every subject type `notificationDeepLink` has a branch for.
 *
 * Spelled out here rather than imported from `NOTIFICATION_SUBJECT_TYPES`, for
 * the reason {@link parseInteractionPending} gives about the interaction
 * contract: this file deliberately validates by hand so the main-process bundle
 * does not have to carry zod. A member added to the shared enum without a branch
 * in `notificationDeepLink` is a compile error there, so the two cannot silently
 * diverge into a banner that opens nowhere.
 */
const KNOWN_SUBJECT_TYPES = new Set(['session', 'task', 'run', 'room', 'agent', 'system']);

/**
 * Parse a `notification` frame's payload down to the fields this module reads.
 *
 * `subject.type` is checked against the enum, not merely for presence, the same
 * way {@link parseInteractionPending} checks an interaction's `type`: it is what
 * `notificationDeepLink` switches on, and an unrecognised value falls off the end
 * of that switch and yields `undefined` — a banner whose click goes nowhere.
 * Failing closed here means such a frame is ignored instead.
 */
function parseNotificationUpsert(data: string): NotificationDTO | null {
  const payload = parseEventPayload(data);
  const notification = payload?.notification;
  if (typeof notification !== 'object' || notification === null) return null;
  const dto = notification as Record<string, unknown>;
  if (typeof dto.id !== 'string' || typeof dto.tier !== 'string' || typeof dto.title !== 'string') {
    return null;
  }
  const subject = dto.subject;
  if (typeof subject !== 'object' || subject === null) return null;
  const subjectType = (subject as { type?: unknown }).type;
  if (typeof subjectType !== 'string' || !KNOWN_SUBJECT_TYPES.has(subjectType)) return null;
  return notification as unknown as NotificationDTO;
}

/** What a `notification_read` frame's payload says was marked read. */
interface NotificationReadIds {
  ids: string[];
  all: boolean;
}

/** Parse a `notification_read` frame's payload. */
function parseNotificationRead(data: string): NotificationReadIds | null {
  const payload = parseEventPayload(data);
  if (!payload) return null;
  const { ids, all } = payload;
  if (!Array.isArray(ids) || typeof all !== 'boolean') return null;
  if (!ids.every((id): id is string => typeof id === 'string')) return null;
  return { ids, all };
}

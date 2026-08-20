import log from 'electron-log';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
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
} from './copy';
import { approveTool, denyTool, submitReplyAnswer } from './answer';
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
 * Two live signals feed this, both riding the shared connection in
 * `event-stream.ts`:
 *
 * - `interaction_pending` / `interaction_resolved` — the existing addressed
 *   Ask stream (DOR-1356). An Ask is Attention: nothing is broadcast on the
 *   `notification` channel while it stands (see `notification-service.ts`'s
 *   module doc), so this is the ONLY live signal for a Blocking Ask, and the
 *   one place actions (Allow/Deny/Reply) apply — they answer a specific
 *   interaction, which only this event names.
 * - `notification` / `notification_read` — the Activity pipeline (turn/run
 *   completion, DMs, mentions, and Attention kinds' resolution history). These
 *   arrive pre-built with a title and a tier; a row that resolved because the
 *   operator just acted on it arrives already read (`readAt` set) and is
 *   deliberately skipped — popping a banner about a person's own click would
 *   be the exact noise the tiering exists to prevent.
 *
 * @module main/notifications
 */

/** How many shown notifications to remember for de-dupe and close-on-resolve, before the oldest is forgotten. */
const MAX_TRACKED_NOTIFICATIONS = 200;

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

  async function handleApprovalAction(ask: InteractionPendingEvent, index: number): Promise<void> {
    // Index 0 is `Allow`, index 1 is `Deny` — the same order `spec.actions`
    // above listed them in; Electron's own callback names an action only by
    // that index.
    const outcome =
      index === 0
        ? await approveTool(options.getPort, ask.sessionId, ask.interaction.id)
        : await denyTool(options.getPort, ask.sessionId, ask.interaction.id);
    if (!outcome.ok) options.focusAndNavigate(askDeepLink(ask));
  }

  async function handleReplyAction(ask: InteractionPendingEvent, reply: string): Promise<void> {
    const outcome = await submitReplyAnswer(
      options.getPort,
      ask.sessionId,
      ask.interaction.id,
      reply
    );
    if (!outcome.ok) options.focusAndNavigate(askDeepLink(ask));
  }

  const subscription = subscribeEventStream({ getPort: options.getPort }, { onFrame });

  return {
    stop(): void {
      subscription.unsubscribe();
      shownAsks.clear();
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
  return payload as unknown as InteractionPendingEvent;
}

/** Read the `interactionId` off an `interaction_resolved` payload. */
function parseInteractionResolvedId(data: string): string | null {
  const payload = parseEventPayload(data);
  return typeof payload?.interactionId === 'string' ? payload.interactionId : null;
}

/** Parse a `notification` frame's payload down to the fields this module reads. */
function parseNotificationUpsert(data: string): NotificationDTO | null {
  const payload = parseEventPayload(data);
  const notification = payload?.notification;
  if (typeof notification !== 'object' || notification === null) return null;
  const dto = notification as Record<string, unknown>;
  if (typeof dto.id !== 'string' || typeof dto.tier !== 'string' || typeof dto.title !== 'string') {
    return null;
  }
  if (typeof dto.subject !== 'object' || dto.subject === null) return null;
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

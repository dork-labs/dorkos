/**
 * The notification vocabulary — the one place a message to the operator is
 * named, tiered, and shaped (spec `notification-system`, ADR 260819-234827).
 *
 * Every user-facing message is exactly one of four KINDS. Two of them live here:
 * **Attention** (a standing condition — something is stopped and waiting on a
 * person) and **Activity** (an event — something happened). The other two,
 * Suggestion (the product talking) and Feedback (a response to the operator's
 * own action), have their own homes and never become notifications.
 *
 * Both kinds carry a TIER, which is the only knob that decides loudness:
 * `blocking` (the only tier that may escalate or make sound), `notable` (an OS
 * notification while the operator is away, silent), `quiet` (history and unread
 * weight, never an OS notification, never a sound).
 *
 * Nothing here carries transcript content, tool inputs, or credentials: a
 * notification is a title, a short body, and enough ids to open the thing it is
 * about. That is deliberate — these payloads ride SSE and, later, out-of-app
 * channels the operator does not control.
 *
 * @module shared/notification-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';

extendZodWithOpenApi(z);

/**
 * How loud a notification is allowed to be.
 *
 * Plain words on purpose: a contributor picking a tier should not have to
 * translate a platform's vocabulary first. "Critical" is reserved for a future
 * destructive-action case and deliberately has no member here.
 */
export const NOTIFICATION_TIERS = ['blocking', 'notable', 'quiet'] as const;

/** How loud a notification is allowed to be. */
export const NotificationTierSchema = z.enum(NOTIFICATION_TIERS).openapi('NotificationTier');

/** How loud a notification is allowed to be. */
export type NotificationTier = (typeof NOTIFICATION_TIERS)[number];

/**
 * Every kind of notification DorkOS can raise. A closed set on purpose.
 *
 * A closed enum is what makes tier, storage and channel policy reviewable
 * properties of a kind rather than a per-call-site choice: adding a way to
 * interrupt somebody means adding a member here and a registry entry beside it,
 * which is a diff a reviewer can see.
 *
 * Dot-notation `subject.verb`, matching the activity log's event types.
 */
export const NOTIFICATION_KINDS = [
  /** An agent is stopped, waiting on a person to answer. Standing. */
  'ask.pending',
  /** An agent proposed a schedule that only a person can approve. Standing. */
  'schedule.parked',
  /** A session hit an error and stopped. Standing. */
  'session.error',
  /** A turn finished. */
  'turn.completed',
  /** A scheduled task run finished. */
  'run.completed',
  /** A direct message arrived. */
  'dm.received',
  /** Somebody mentioned the operator in a room. */
  'mention.received',
  /** An agent said something to the operator on its own initiative. */
  'agent.note',
  /** A relay message could not be delivered. */
  'dead-letter.created',
  /** An agent stopped answering. */
  'agent.unreachable',
  /** DorkOS is running a version it was not running before. */
  'update.installed',
  /** The daily digest. */
  'report.daily',
] as const;

/** Every kind of notification DorkOS can raise. */
export const NotificationKindSchema = z.enum(NOTIFICATION_KINDS).openapi('NotificationKind');

/** Every kind of notification DorkOS can raise. */
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/**
 * What a notification is about — the thing a surface opens when it is clicked.
 *
 * Distinct from `agentId`/`sessionId`/`roomId`, which are LENS keys: a run
 * notification's subject is the run, and its `agentId` is what makes it show up
 * in that agent's notification list.
 */
export const NOTIFICATION_SUBJECT_TYPES = [
  'session',
  'task',
  'run',
  'room',
  'agent',
  'system',
] as const;

/** What a notification is about. */
export const NotificationSubjectTypeSchema = z
  .enum(NOTIFICATION_SUBJECT_TYPES)
  .openapi('NotificationSubjectType');

/** What a notification is about. */
export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];

/** The thing a notification is about, and its id. */
export const NotificationSubjectSchema = z
  .object({
    type: NotificationSubjectTypeSchema,
    /** Id of the subject within its type. Never empty. */
    id: z.string().min(1),
  })
  .openapi('NotificationSubject');

/** The thing a notification is about, and its id. */
export type NotificationSubject = z.infer<typeof NotificationSubjectSchema>;

/**
 * How a standing condition ended.
 *
 * Standing kinds are never stored while they stand — they stay derived from the
 * domain stores that own them. This is what gets recorded when one resolves, and
 * it is the reason the history is honest: an Ask nobody answered reads `expired`
 * rather than quietly vanishing.
 */
export const NOTIFICATION_OUTCOMES = [
  /** Somebody answered the Ask. */
  'answered',
  /** Nobody answered before the park ceiling ran out. */
  'expired',
  /** The thing that was waiting went away on its own. */
  'cancelled',
  /** The operator approved the proposed schedule. */
  'approved',
  /** The operator rejected the proposed schedule. */
  'rejected',
  /** The error state ended without anybody acting on it. */
  'cleared',
] as const;

/** How a standing condition ended. */
export const NotificationOutcomeSchema = z
  .enum(NOTIFICATION_OUTCOMES)
  .openapi('NotificationOutcome');

/** How a standing condition ended. */
export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

/** How a surface should draw an action button. */
export const NOTIFICATION_ACTION_STYLES = ['primary', 'danger', 'neutral'] as const;

/** How a surface should draw an action button. */
export const NotificationActionStyleSchema = z
  .enum(NOTIFICATION_ACTION_STYLES)
  .openapi('NotificationActionStyle');

/** How a surface should draw an action button. */
export type NotificationActionStyle = (typeof NOTIFICATION_ACTION_STYLES)[number];

/**
 * Something the operator can do about a notification without leaving the surface
 * that showed it.
 *
 * The action names an INTENT, not an endpoint. Every surface that offers one —
 * the inbox, a desktop banner, a Telegram button — already knows how to reach
 * the route behind an intent it supports, and one that does not simply omits the
 * button. Putting a URL here instead would mean a phone notification carrying a
 * localhost address it can never call.
 */
export const NotificationActionDTOSchema = z
  .object({
    /** Stable intent id, e.g. `approve`. Unique within one notification. */
    id: z.string().min(1),
    /** Button label, already written for a person. */
    label: z.string().min(1),
    /** How to draw it. */
    style: NotificationActionStyleSchema,
  })
  .openapi('NotificationAction');

/** Something the operator can do about a notification. */
export type NotificationActionDTO = z.infer<typeof NotificationActionDTOSchema>;

/**
 * One notification, as every surface receives it.
 *
 * The same shape whether it came off `GET /api/notifications` or the
 * `notification` SSE event, so a client stores one thing and never reconciles
 * two representations of the same row.
 */
export const NotificationDTOSchema = z
  .object({
    /** ULID. Also the pagination cursor — ULIDs sort by creation time. */
    id: z.string().min(1),
    kind: NotificationKindSchema,
    tier: NotificationTierSchema,
    subject: NotificationSubjectSchema,
    /** Agent this concerns, when there is one. The per-agent lens key. */
    agentId: z.string().optional(),
    /** Session this concerns, when there is one. The per-session lens key. */
    sessionId: z.string().optional(),
    /** Room this concerns, when there is one. */
    roomId: z.string().optional(),
    /** One line, already written for a person. */
    title: z.string().min(1),
    /** An optional second line. Never transcript content or tool input. */
    body: z.string().optional(),
    /** What the operator can do about it, if anything. */
    actions: z.array(NotificationActionDTOSchema).optional(),
    /** When it was raised. ISO 8601 UTC. */
    createdAt: z.string(),
    /** When the operator read it. Absent means unread. ISO 8601 UTC. */
    readAt: z.string().optional(),
    /**
     * When the standing condition behind it ended. ISO 8601 UTC.
     *
     * Only ever set on a history row: a stored notification for a standing kind
     * exists BECAUSE it resolved.
     */
    resolvedAt: z.string().optional(),
    /** How it ended. Set exactly when {@link resolvedAt} is. */
    outcome: NotificationOutcomeSchema.optional(),
  })
  .openapi('Notification');

/** One notification, as every surface receives it. */
export type NotificationDTO = z.infer<typeof NotificationDTOSchema>;

/**
 * Where a notification was sent, for the delivery ledger.
 *
 * The ledger is what lets DorkOS answer "did this reach you?" per channel, which
 * is the question escalation is built on. `in_app` is a channel like any other:
 * a notification the operator saw in the cockpit is one nothing needs to get
 * louder about.
 */
export const NOTIFICATION_CHANNELS = [
  'in_app',
  'desktop',
  'browser',
  'web_push',
  'telegram',
  'slack',
  'sound',
] as const;

/** Where a notification was sent. */
export const NotificationChannelSchema = z
  .enum(NOTIFICATION_CHANNELS)
  .openapi('NotificationChannel');

/** Where a notification was sent. */
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Query parameters of `GET /api/notifications`.
 *
 * Filters are lens keys, not a search: the bell reads it unfiltered, an agent
 * profile reads it with `agentId`, a session view with `sessionId`.
 */
export const ListNotificationsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(25),
    /**
     * ULID cursor — return notifications older than this one.
     *
     * The id rather than a timestamp: ULIDs already sort by creation time, and
     * two notifications raised in the same millisecond would make a timestamp
     * cursor either skip one or repeat it forever.
     */
    before: z.string().min(1).optional(),
    agentId: z.string().optional(),
    sessionId: z.string().optional(),
    kind: NotificationKindSchema.optional(),
    /**
     * Only unread notifications.
     *
     * Parsed from the literal strings rather than with `z.coerce.boolean`, which
     * maps the string `'false'` to `true` and would turn "show me everything"
     * into "show me only the unread ones".
     */
    unread: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => v === 'true'),
  })
  .openapi('ListNotificationsQuery');

/** Query parameters of `GET /api/notifications`. */
export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

/** Response body of `GET /api/notifications`. */
export const ListNotificationsResponseSchema = z
  .object({
    notifications: z.array(NotificationDTOSchema),
    /** Pass as `before` for the next page. `null` when this was the last one. */
    nextCursor: z.string().nullable(),
    /**
     * How many stored notifications are unread, ignoring the filters above.
     *
     * Unfiltered on purpose: it is what the bell draws, and a bell that counted
     * only the current lens would go quiet the moment somebody opened one agent.
     */
    unreadCount: z.number().int().min(0),
  })
  .openapi('ListNotificationsResponse');

/** Response body of `GET /api/notifications`. */
export type ListNotificationsResponse = z.infer<typeof ListNotificationsResponseSchema>;

/** Response body of `PATCH /api/notifications/:id/read` and `POST /api/notifications/read-all`. */
export const MarkNotificationsReadResponseSchema = z
  .object({
    ok: z.literal(true),
    /** How many rows moved from unread to read. Zero when they already were. */
    marked: z.number().int().min(0),
    /** Unread count after the change — what the bell should now draw. */
    unreadCount: z.number().int().min(0),
  })
  .openapi('MarkNotificationsReadResponse');

/** Response body of the read endpoints. */
export type MarkNotificationsReadResponse = z.infer<typeof MarkNotificationsReadResponseSchema>;

/**
 * Payload of the global `notification` SSE event — an upsert.
 *
 * Upsert rather than "created": a standing condition that resolves is broadcast
 * again as the same id carrying `resolvedAt`, so a surface holding the row
 * replaces it instead of drawing the outcome twice.
 */
export const NotificationEventSchema = z
  .object({
    notification: NotificationDTOSchema,
  })
  .openapi('NotificationEvent');

/** Payload of the global `notification` SSE event. */
export type NotificationEvent = z.infer<typeof NotificationEventSchema>;

/**
 * Payload of the global `notification_read` SSE event.
 *
 * Read state is server-side and shared, so clearing the bell on the laptop has
 * to clear it on the phone. `all: true` means every unread row was marked, which
 * a client applies without needing the ids.
 */
export const NotificationReadEventSchema = z
  .object({
    /** Ids that were marked read. Empty when `all` is true. */
    ids: z.array(z.string()),
    /** Whether every unread notification was marked, not just {@link ids}. */
    all: z.boolean(),
    /** When they were marked. ISO 8601 UTC. */
    readAt: z.string(),
    /** Unread count after the change. */
    unreadCount: z.number().int().min(0),
  })
  .openapi('NotificationReadEvent');

/** Payload of the global `notification_read` SSE event. */
export type NotificationReadEvent = z.infer<typeof NotificationReadEventSchema>;

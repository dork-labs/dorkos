/**
 * The notification registry — the one place a kind of message to the operator is
 * declared (spec `notification-system`; ADRs 260819-234827, 260819-234828).
 *
 * **This is the DX contract.** Adding a way for DorkOS to tell somebody
 * something is one entry here plus one `notify()` call at the seam where it
 * happens. Tier, storage discipline, dedupe, routing and channel policy are
 * properties of the entry, so a reviewer reading this file can see exactly how
 * loud every kind of message is allowed to be and where it is allowed to reach.
 * Nothing decides loudness at a call site.
 *
 * Each entry declares:
 * - `tier` — how loud. A plain value where the answer is fixed, a function only
 *   where the payload genuinely changes it (one kind does).
 * - `storage` — `event` writes a row when it happens; `standing` writes nothing
 *   while the condition stands and one history row when it resolves. See
 *   {@link NotificationStorageRule}.
 * - `subjectType` + `locate` — what it is about, and the lens keys it files under.
 * - `title` / `body` — what a person reads. Typed against that kind's payload.
 * - `actions` — what they can do about it without leaving the surface.
 * - `dedupeKey` (+ optional `dedupeWindowMs`) — what makes two of these the same.
 * - `relay` — whether it may leave the app over Telegram/Slack, and on what terms.
 * - `channelMessage` — the sentence an out-of-app channel says, when that is not
 *   simply the title and body.
 *
 * @module services/notifications/notification-registry
 */
import {
  NOTIFICATION_KINDS,
  type NotificationActionDTO,
  type NotificationKind,
  type NotificationSubjectType,
  type NotificationTier,
} from '@dorkos/shared/notification-schemas';

/**
 * How a run finished, as `run.completed` reports it.
 *
 * Cancellations are absent on purpose: the operator cancelled it, so telling them
 * it stopped is the pipeline's own "never notify somebody about their own action"
 * rule spelled out as a type.
 */
export type RunCompletionStatus = 'completed' | 'failed';

/**
 * What each kind of notification is told when it is raised.
 *
 * A payload carries ids and short, already-human sentences — never transcript
 * content, tool input, or anything that would be unsafe on a phone lock screen.
 */
export interface NotificationPayloads {
  /** An agent is parked on something only a person can answer. */
  'ask.pending': {
    sessionId: string;
    interactionId: string;
    agentId?: string;
    /**
     * What to call the session in a sentence.
     *
     * The working directory's own name, which is the identity fallback every
     * other session surface uses. A title has to stand on its own in a desktop
     * banner or a phone, so it cannot be left for a client to fill in.
     */
    sessionLabel: string;
    /** One line saying what it wants, e.g. `run a Bash command`. */
    summary: string;
  };
  /** An agent proposed a schedule that only a person can approve. */
  'schedule.parked': {
    taskId: string;
    taskName: string;
    agentId?: string;
    /** What to call whoever proposed it. */
    proposedBy: string;
  };
  /** A session stopped on an error. */
  'session.error': {
    sessionId: string;
    agentId?: string;
    /** What to call the session in a sentence. See `ask.pending`. */
    sessionLabel: string;
    /** One line of what went wrong, already trimmed. */
    detail?: string;
  };
  /** A turn finished. */
  'turn.completed': {
    sessionId: string;
    agentId?: string;
    /** What to call the session in a sentence. See `ask.pending`. */
    sessionLabel: string;
    /** When it finished. ISO 8601 UTC — also what keeps two turns distinct. */
    completedAt: string;
  };
  /** A scheduled task run reached a terminal status. */
  'run.completed': {
    runId: string;
    taskId: string;
    taskName: string;
    agentId?: string;
    status: RunCompletionStatus;
    /** How long it took, already written, e.g. `2m 14s`. */
    duration?: string;
    /** The first line of output or error. */
    detail?: string;
    /** The sentence an out-of-app channel says. Preserves the wording DOR-240 shipped. */
    channelMessage: string;
  };
  /** A direct message arrived. */
  'dm.received': {
    roomId: string;
    entryId: string;
    /**
     * The entry's room-local `seq`. Never rendered — it is what lets a room's
     * read cursor tell the read-cursor service which rows it just passed
     * (`markRoomRead`, `read-cursor-service.ts`), without a second query back
     * into the room's own log.
     */
    entrySeq: number;
    agentId?: string;
    /** Who sent it. */
    fromName: string;
    /** The opening of the message, already truncated. */
    preview: string;
  };
  /** Somebody mentioned the operator in a room. */
  'mention.received': {
    roomId: string;
    entryId: string;
    /** The entry's room-local `seq`. See `dm.received`'s field of the same name. */
    entrySeq: number;
    roomName: string;
    agentId?: string;
    fromName: string;
    preview: string;
  };
  /** An agent said something to the operator on its own initiative. */
  'agent.note': {
    agentId: string;
    agentName: string;
    /** Exactly what the agent wrote. */
    message: string;
    sessionId?: string;
  };
  /** A relay message could not be delivered to anybody. */
  'dead-letter.created': {
    deadLetterId: string;
    agentId?: string;
    /**
     * Why it could not be delivered.
     *
     * Deliberately the only detail. What a dead letter is ADDRESSED to is an
     * endpoint hash, which is not something a person can read, and the message
     * itself is content this must never carry. The reason is the part somebody
     * can act on; the Relay page holds the rest.
     */
    reason: string;
  };
  /** An agent stopped answering. */
  'agent.unreachable': {
    agentId: string;
    agentName: string;
  };
  /** DorkOS is running a version it was not running before. */
  'update.installed': {
    version: string;
    /** What it was running last time. Absent on the very first boot that records one. */
    previousVersion?: string;
  };
  /** The daily digest. */
  'report.daily': {
    /** The day it covers, `YYYY-MM-DD`. */
    date: string;
    /** The digest itself, already written for a person. */
    summary: string;
  };
}

/** The payload one kind of notification is raised with. */
export type NotificationPayload<K extends NotificationKind> = NotificationPayloads[K];

/**
 * Whether a kind is stored when it happens or only when it ends.
 *
 * `event` — an Activity notification. Something happened; the row IS the record.
 *
 * `standing` — an Attention notification. Something is stopped and waiting on a
 * person, and the store that owns it (interactions, tasks, session lifecycle)
 * already answers "is it still waiting?" correctly. Writing a row while it stands
 * would create a second source of truth for the state the whole product is built
 * around, so nothing is written until it resolves — and then exactly one row,
 * carrying the outcome, so the history says what happened rather than going
 * quiet.
 */
export type NotificationStorageRule = 'event' | 'standing';

/**
 * The kinds that describe a standing condition rather than an event.
 *
 * Written out rather than derived from {@link NotificationRegistryEntry.storage}
 * — a `storage` field is a runtime value, and this is what lets the two entry
 * points on the service (`notify` for events, `resolveStanding` for conditions
 * that ended) be separated at COMPILE time. Calling the wrong one is then a type
 * error instead of a silently mis-stored row.
 *
 * `notification-registry.test.ts` pins this against the `storage` field, so the
 * two cannot drift.
 */
export type StandingNotificationKind = 'ask.pending' | 'schedule.parked' | 'session.error';

/** The kinds that record something that happened. Every kind that is not standing. */
export type EventNotificationKind = Exclude<NotificationKind, StandingNotificationKind>;

/**
 * Whether a kind may leave the app over a connected chat integration, and on what
 * terms.
 *
 * `never` — stays in DorkOS.
 *
 * `always` — goes out whenever a target resolves. The agent's own note is this:
 * reaching the person is the entire point of the verb.
 *
 * `opt-in` — goes out only when the operator switched `notifyOnTaskComplete` on
 * for the binding it resolved to. This is the policy DOR-240 shipped for
 * successful runs, kept exactly: a failure is worth interrupting somebody for,
 * a success is not unless they said so.
 *
 * Every one of these still passes the binding's `canInitiate` consent gate and
 * the per-agent hourly budget — the channel owns those, not the registry.
 */
export type RelayPolicy = 'never' | 'always' | 'opt-in';

/** A value on a registry entry that some kinds vary by payload. */
type PerKind<K extends NotificationKind, T> = T | ((payload: NotificationPayload<K>) => T);

/** Where a notification files itself — its subject id and its lens keys. */
export interface NotificationLocation {
  /** Id of the subject within {@link NotificationRegistryEntry.subjectType}. */
  subjectId: string;
  agentId?: string;
  sessionId?: string;
  roomId?: string;
}

/** One kind of notification, fully declared. */
export interface NotificationRegistryEntry<K extends NotificationKind = NotificationKind> {
  kind: K;
  /** How loud. A function only where the payload genuinely changes the answer. */
  tier: PerKind<K, NotificationTier>;
  /** Stored when it happens, or only when it resolves. */
  storage: NotificationStorageRule;
  /** What it is about. */
  subjectType: NotificationSubjectType;
  /** The subject id and lens keys, read off the payload. */
  locate: (payload: NotificationPayload<K>) => NotificationLocation;
  /** The one line a person reads. */
  title: (payload: NotificationPayload<K>) => string;
  /** An optional second line. */
  body?: (payload: NotificationPayload<K>) => string | undefined;
  /** What the operator can do about it in place. */
  actions?: (payload: NotificationPayload<K>) => NotificationActionDTO[];
  /** What makes two of these the same notification. */
  dedupeKey: (payload: NotificationPayload<K>) => string;
  /** How long a duplicate is suppressed for. Defaults to {@link DEFAULT_DEDUPE_WINDOW_MS}. */
  dedupeWindowMs?: number;
  /** Whether it may leave the app, and on what terms. */
  relay: PerKind<K, RelayPolicy>;
  /** The sentence an out-of-app channel says, when it differs from title + body. */
  channelMessage?: (payload: NotificationPayload<K>) => string;
}

/**
 * How long the same notification is suppressed for by default.
 *
 * Five minutes is chosen against the failure it exists to stop: a seam that fires
 * twice for one real event (a retried write, two observers on one hook). It is
 * deliberately short enough that a genuinely recurring condition — an agent that
 * goes unreachable, recovers, and goes again — is still reported the second time.
 */
export const DEFAULT_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/** How long an unreachable agent stays quiet before it is worth saying again. */
const UNREACHABLE_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

/** Longest slice of an agent's note that is used to tell two notes apart. */
const NOTE_DEDUPE_PREFIX = 120;

/** The Approve/Reject pair a parked schedule offers. */
const SCHEDULE_ACTIONS: NotificationActionDTO[] = [
  { id: 'approve', label: 'Approve', style: 'primary' },
  { id: 'reject', label: 'Reject', style: 'danger' },
];

/** The single "take me there" action a standing condition offers. */
const OPEN_ACTION: NotificationActionDTO[] = [{ id: 'open', label: 'Open', style: 'primary' }];

/**
 * The registry's shape: one entry per kind, each typed against its own payload.
 *
 * A mapped type rather than an array, so a kind added to
 * {@link NotificationKind} without an entry here is a compile error rather than
 * a hole nobody notices until something fails to notify.
 */
type NotificationRegistryMap = { [K in NotificationKind]: NotificationRegistryEntry<K> };

/**
 * Every kind of notification DorkOS can raise, declared once.
 *
 * Read down the `tier` and `relay` columns to see the whole interruption budget
 * of the product in one screen. That is the point of the file.
 */
const ENTRIES: NotificationRegistryMap = {
  'ask.pending': {
    kind: 'ask.pending',
    tier: 'blocking',
    storage: 'standing',
    subjectType: 'session',
    locate: (p) => ({ subjectId: p.sessionId, sessionId: p.sessionId, agentId: p.agentId }),
    title: (p) => `${p.sessionLabel} is waiting on your answer`,
    body: (p) => p.summary,
    actions: () => OPEN_ACTION,
    dedupeKey: (p) => `ask:${p.interactionId}`,
    relay: 'never',
  },

  'schedule.parked': {
    // The RAISE edge is reserved for W3 escalation: a standing kind stores
    // nothing while it stands, so there is nothing for a raise-time call to do
    // until a timer needs arming. Its two resolutions (approved, rejected) ARE
    // wired, in `routes/tasks.ts`.
    kind: 'schedule.parked',
    tier: 'blocking',
    storage: 'standing',
    subjectType: 'task',
    locate: (p) => ({ subjectId: p.taskId, agentId: p.agentId }),
    title: (p) => `${p.proposedBy} proposed a scheduled task`,
    body: (p) => `${p.taskName} will not run until you approve it.`,
    actions: () => SCHEDULE_ACTIONS,
    dedupeKey: (p) => `schedule:${p.taskId}`,
    relay: 'never',
  },

  'session.error': {
    kind: 'session.error',
    tier: 'blocking',
    storage: 'standing',
    subjectType: 'session',
    locate: (p) => ({ subjectId: p.sessionId, sessionId: p.sessionId, agentId: p.agentId }),
    title: (p) => `${p.sessionLabel} stopped on an error`,
    body: (p) => p.detail,
    actions: () => OPEN_ACTION,
    dedupeKey: (p) => `session-error:${p.sessionId}`,
    relay: 'never',
  },

  'turn.completed': {
    kind: 'turn.completed',
    tier: 'notable',
    storage: 'event',
    subjectType: 'session',
    locate: (p) => ({ subjectId: p.sessionId, sessionId: p.sessionId, agentId: p.agentId }),
    title: (p) => `${p.sessionLabel} finished`,
    dedupeKey: (p) => `turn:${p.sessionId}:${p.completedAt}`,
    relay: 'never',
  },

  'run.completed': {
    kind: 'run.completed',
    // The one kind whose loudness the payload decides. A run that failed is worth
    // a glance; one that worked is history. Splitting it into two kinds would
    // mean two registry entries, two dedupe keys and two rows for one event.
    tier: (p) => (p.status === 'failed' ? 'notable' : 'quiet'),
    storage: 'event',
    subjectType: 'run',
    locate: (p) => ({ subjectId: p.runId, agentId: p.agentId }),
    title: (p) => (p.status === 'failed' ? `${p.taskName} failed` : `${p.taskName} finished`),
    body: (p) => {
      const timing = p.duration
        ? p.status === 'failed'
          ? `Failed after ${p.duration}.`
          : `Done in ${p.duration}.`
        : undefined;
      return [timing, p.detail].filter(Boolean).join(' ') || undefined;
    },
    dedupeKey: (p) => `run:${p.runId}`,
    // Failures always reach out; successes only where the operator asked for
    // them. This is DOR-240's policy, moved from the notifier to the declaration.
    relay: (p) => (p.status === 'failed' ? 'always' : 'opt-in'),
    // The chat message keeps the wording DOR-240 shipped rather than being
    // rebuilt from title and body: a phone message and an inbox row are not the
    // same sentence, and this one is already tuned.
    channelMessage: (p) => p.channelMessage,
  },

  'dm.received': {
    // Wired in `services/rooms/room-service.ts`'s `writePost` (spec task T11,
    // DOR-1388): raised when an agent posts in a room that is a 1:1 DM with the
    // operator (`kind: 'dm'`, exactly one agent on the roster, the operator
    // among its human members) and it is the sole agent there — never for an
    // agent-to-agent DM the owner was only seeded into (the three-way rule),
    // and never for a human author, since only an agent can BE the DM's other
    // party (a human posting in a `dm` room is either the operator's own
    // cockpit voice or a bridged collaborator, and neither is "an agent
    // messaged you"). Muting the room suppresses this kind
    // (`RoomServiceDeps.isRoomMuted`); it never suppresses `mention.received`.
    //
    // Dedupes per ROOM, not per entry — deliberately coarser than every other
    // kind here. A burst of messages from the same agent in the same DM is
    // one conversation, and the point of a notification is "you have
    // something waiting in this DM", not a running tally of how many lines it
    // grew by. The room's own log is still the full per-message history; this
    // is one row/banner per room, per dedupe window — `dedupeWindowMs` is not
    // set here, so it defaults to `DEFAULT_DEDUPE_WINDOW_MS` (five minutes).
    kind: 'dm.received',
    tier: 'notable',
    storage: 'event',
    subjectType: 'room',
    locate: (p) => ({ subjectId: p.roomId, roomId: p.roomId, agentId: p.agentId }),
    title: (p) => `${p.fromName} messaged you`,
    body: (p) => p.preview,
    dedupeKey: (p) => `dm:${p.roomId}`,
    relay: 'never',
  },

  'mention.received': {
    // Wired in `services/rooms/room-service.ts`'s `writePost` (spec task T11,
    // DOR-1388): raised whenever an entry's resolved mentions name the
    // operator, in any room kind. Pierces mute on purpose — an @-mention is a
    // directed call-out, not the room's ambient chatter. Dedupes per ENTRY,
    // unlike `dm.received`: each mention is its own event worth its own row.
    //
    // **Inert until the operator has set their own handle.** A mention is
    // resolved from `@handle` text against the roster (`mentions.ts`), and the
    // local human author's handle is `null` until asked for one
    // (`author-registry.ts`) — so nobody can spell an `@`-mention that
    // resolves to the operator, agent or collaborator alike, until they set
    // one in their profile. This is expected, not a bug to chase: the same
    // gap exists for every other `@`-mention on the install.
    kind: 'mention.received',
    tier: 'notable',
    storage: 'event',
    subjectType: 'room',
    locate: (p) => ({ subjectId: p.roomId, roomId: p.roomId, agentId: p.agentId }),
    title: (p) => `${p.fromName} mentioned you in ${p.roomName}`,
    body: (p) => p.preview,
    dedupeKey: (p) => `mention:${p.entryId}`,
    relay: 'never',
  },

  'agent.note': {
    kind: 'agent.note',
    tier: 'notable',
    storage: 'event',
    subjectType: 'agent',
    locate: (p) => ({ subjectId: p.agentId, agentId: p.agentId, sessionId: p.sessionId }),
    title: (p) => `${p.agentName} has a note for you`,
    body: (p) => p.message,
    dedupeKey: (p) => `agent-note:${p.agentId}:${p.message.slice(0, NOTE_DEDUPE_PREFIX)}`,
    // Reaching the person wherever they are IS the verb. The binding's
    // `canInitiate` switch and the hourly budget still decide whether it may.
    //
    // The `relay_notify_user` tool runs that delivery itself and hands the
    // outcome back through `NotifyOptions.delivered`, because the answer it owes
    // the agent depends on where the note landed. Same delivery code, run one
    // step earlier — the policy declared here is what it runs it under.
    relay: 'always',
    channelMessage: (p) => p.message,
  },

  'dead-letter.created': {
    kind: 'dead-letter.created',
    tier: 'quiet',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.deadLetterId, agentId: p.agentId }),
    title: () => 'A message could not be delivered',
    body: (p) => p.reason,
    dedupeKey: (p) => `dead-letter:${p.deadLetterId}`,
    relay: 'never',
  },

  'agent.unreachable': {
    kind: 'agent.unreachable',
    tier: 'quiet',
    storage: 'event',
    subjectType: 'agent',
    locate: (p) => ({ subjectId: p.agentId, agentId: p.agentId }),
    title: (p) => `${p.agentName} stopped answering`,
    dedupeKey: (p) => `agent-unreachable:${p.agentId}`,
    // An agent that flaps would otherwise fill the inbox on its own.
    dedupeWindowMs: UNREACHABLE_DEDUPE_WINDOW_MS,
    relay: 'never',
  },

  'update.installed': {
    kind: 'update.installed',
    tier: 'quiet',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.version }),
    title: (p) => `DorkOS updated to ${p.version}`,
    body: (p) => (p.previousVersion ? `You were on ${p.previousVersion}.` : undefined),
    dedupeKey: (p) => `update:${p.version}`,
    relay: 'never',
  },

  'report.daily': {
    // Reserved: emitter lands in W4 (spec task T12, the daily Shift Report card).
    kind: 'report.daily',
    tier: 'quiet',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.date }),
    title: () => 'Your day, in short',
    body: (p) => p.summary,
    dedupeKey: (p) => `report-daily:${p.date}`,
    relay: 'never',
  },
};

/**
 * Look one kind up.
 *
 * Total by construction — {@link ENTRIES} is annotated with the full
 * {@link NotificationKind} union, so a kind nobody declared is a type error
 * rather than a runtime hole.
 *
 * @param kind - The kind to look up.
 */
export function notificationEntry<K extends NotificationKind>(
  kind: K
): NotificationRegistryEntry<K> {
  return ENTRIES[kind];
}

/** Every declared kind, in declaration order. @internal Exported for tests. */
export const NOTIFICATION_REGISTRY_KINDS: readonly NotificationKind[] = NOTIFICATION_KINDS;

/**
 * The kinds something in the server actually raises today.
 *
 * The registry declares the whole vocabulary, which is deliberate — a closed
 * enum is what makes tier and channel policy reviewable in one place — but a
 * declared kind nobody emits is a promise, not a feature. This names the ones
 * that are real, so the gap is a listed fact rather than something a reader has
 * to discover by grepping for call sites.
 *
 * Absent, with its wave noted at the entry: `report.daily` (W4 task T12), and
 * the RAISE edge of `schedule.parked` (W3 escalation — its resolutions are
 * wired).
 */
export const WIRED_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'ask.pending',
  'schedule.parked',
  'session.error',
  'turn.completed',
  'run.completed',
  'dm.received',
  'mention.received',
  'agent.note',
  'dead-letter.created',
  'agent.unreachable',
  'update.installed',
];

/**
 * Resolve a value that a kind is allowed to vary by payload.
 *
 * @param value - The declared value or builder.
 * @param payload - The payload to resolve it against.
 */
export function resolvePerKind<K extends NotificationKind, T>(
  value: PerKind<K, T>,
  payload: NotificationPayload<K>
): T {
  return typeof value === 'function' ? (value as (p: NotificationPayload<K>) => T)(payload) : value;
}

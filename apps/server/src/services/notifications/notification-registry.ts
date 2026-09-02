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
 *   while the condition stands and one history row when it resolves;
 *   `standing-recorded` writes on both edges, for the one condition whose own
 *   store does not survive a restart. See {@link NotificationStorageRule}.
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
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
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
    /**
     * The session the proposal came from, so the operator can open the
     * conversation that led to it rather than judging a cron line cold.
     * Absent for a proposal made through the sessionless external `/mcp`
     * server, which has no session to point at.
     */
    proposedBySessionId?: string;
    /** What to call whoever proposed it. */
    proposedBy: string;
  };
  /**
   * An agent asked to do something irreversible and is waiting on a yes.
   *
   * The `approvals` table's own pending row is the state; this describes it to
   * the operator. Deliberately carries NO argument values — the approval card
   * shows those, and this payload is what a phone push and a desktop banner are
   * built from.
   */
  'approval.pending': {
    /** ULID of the pending approval. */
    approvalId: string;
    /** The capability or tool that would run, e.g. `tasks_delete`. */
    capabilityId: string;
    /**
     * Its human-facing title, from the capability registry — never from the
     * requester (`approval-service.ts`'s `CapabilityDescriptorLookup`).
     */
    capabilityTitle: string;
    /**
     * The Mesh agent that asked, when its project path resolves to one. The
     * lens key, and what routes the escalation's chat leg.
     */
    agentId?: string;
    /** What to call whoever asked. */
    requestedBy: string;
  };
  /** A session stopped on an error. */
  'session.error': {
    sessionId: string;
    agentId?: string;
    /**
     * When THIS error episode started. ISO 8601 UTC.
     *
     * **Not decoration — it is the episode's identity.** A session can fall
     * over, be fixed, and fall over again, and those are two different things
     * to be told about. Keyed on the session alone, the escalation ledger's
     * "already escalated?" check would read the first episode's row forever and
     * silently suppress every later one (DOR-1387 review). It is stamped once
     * when the error starts and carried verbatim to the resolution, so both
     * edges of one episode build the same key.
     */
    since: string;
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
  /**
   * A runtime's sign-in stopped working, so nothing can run on it.
   *
   * Deliberately says NOTHING about the turn that discovered it. An expired
   * credential is a fact about the RUNTIME — every agent on it is stopped, not
   * just the one that happened to notice — so the payload carries the runtime
   * and the episode, and nothing about the session that tripped over it.
   */
  'signin.required': {
    /** The runtime type, e.g. `claude-code`. */
    runtime: string;
    /**
     * When THIS sign-in episode started. ISO 8601 UTC.
     *
     * **Not decoration — it is the episode's identity**, for exactly the reason
     * `session.error` carries one. A credential can expire, be renewed, and
     * expire again, and those are two different things to be told about. Keyed
     * on the runtime alone, the escalation ledger's "already escalated?" check
     * would read the first episode's row forever and silently suppress every
     * later phone ping (DOR-1387's shape, avoided here by construction).
     *
     * Stamped once by the watch that noticed (`runtime-signin-watch.ts`) and
     * carried verbatim to the resolution, so both edges build the same key.
     */
    since: string;
    /**
     * When a turn got through again and ended the episode. ISO 8601 UTC, and
     * present ONLY on the resolution edge.
     *
     * Its absence is what tells the two edges apart, which they have to be: this
     * kind writes a row at both, and one `title` builder serves both. Without
     * it the "it is working again" row would repeat the failure row's sentence
     * word for word, and the inbox would show the same line twice for one
     * episode. Deliberately NOT part of {@link dedupeKey} — an episode is
     * identified by when it began, so both rows and the escalation timer file
     * under one string.
     */
    clearedAt?: string;
    /**
     * True when boot closed this episode rather than a working turn ending it.
     *
     * **The one resolution DorkOS cannot vouch for.** The episode store is in
     * memory, so a server killed mid-episode leaves a raise row no recovery edge
     * will ever answer, and boot closes it so history stops reading as the
     * present tense (`emitters/runtime-signin.ts`). What boot knows is that
     * nobody can find out any more — not that the sign-in works. So the row says
     * that instead of claiming an all-clear it has not seen.
     */
    closedAtBoot?: boolean;
  };
  /** DorkOS is running a version it was not running before. */
  'update.installed': {
    version: string;
    /** What it was running last time. Absent on the very first boot that records one. */
    previousVersion?: string;
  };
  /** The daily digest. */
  'report.daily': {
    /** The day it covers, `YYYY-MM-DD` (the boundary's own date — see
     * `shift-report.ts`). Also what makes two of these the same day. */
    date: string;
    /** The headline, already written for a person, e.g. "While you were
     * away: 3 runs finished, 1 needs a look". */
    title: string;
    /** The full rundown, already written for a person. */
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
 *
 * `standing-recorded` — standing in every way that matters (it rides the
 * escalation ladder, and it has a resolution edge), but it writes a row on BOTH
 * edges rather than only the last one. Exactly one kind needs this, and the
 * reason is that its owning store is the only one that does not survive a
 * restart: `signin.required` is held in memory by
 * `services/observability/runtime-signin-watch.ts`, so under plain `standing` a
 * server that restarted overnight left no push, no row, and no trace at all that
 * a credential had died at 3am. The row written at the raise edge is that trace.
 *
 * It is affordable here only because the wording can stay true forever — "your
 * sign-in stopped working" reads as correctly a month later as it did that
 * night. Reach for this rule only when BOTH halves hold: the condition has no
 * durable owner, and its raise-edge wording never goes stale. A stored row
 * insisting something "is waiting" when it was answered hours ago is exactly the
 * failure `standing` exists to prevent, and `standing` is still the default.
 */
export type NotificationStorageRule = 'event' | 'standing' | 'standing-recorded';

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
export type StandingNotificationKind =
  'ask.pending' | 'schedule.parked' | 'approval.pending' | 'session.error' | 'signin.required';

/**
 * The standing kinds that ALSO write a row the moment they begin — the
 * `standing-recorded` storage rule, which today is one kind.
 *
 * Named as its own type rather than folded into the union below because it is
 * the single deliberate hole in an otherwise total split: these are the only
 * kinds that legitimately reach BOTH `notify()` and `resolveStanding()`. A
 * reviewer can read the exception in one line, and adding a second member is a
 * diff that has to argue for itself.
 */
export type RecordedStandingKind = 'signin.required';

/**
 * The kinds that record something that happened — everything that is not
 * standing, plus the standing kinds that record their own arrival.
 *
 * The union with {@link RecordedStandingKind} is what lets
 * `notify('signin.required', …)` type-check while `notify('ask.pending', …)`
 * still does not. The guarantee that matters is unharmed: a standing condition
 * whose own store survives a restart still cannot be stored while it stands.
 */
export type EventNotificationKind =
  Exclude<NotificationKind, StandingNotificationKind> | RecordedStandingKind;

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

/**
 * How long a day's Shift Report stays deduped once raised.
 *
 * A local day is exactly 24 hours (4am to 4am; see `shift-report.ts`), and
 * this window has to OUTLAST the whole of it — not trim to it — so a restart
 * late in the day still finds today's row via `findRecent`, however early in
 * the day it was first raised. An hour past the day's own length is the
 * margin: 24h flush against the day length leaves zero room for a report
 * raised right at the boundary, where a restart minutes later could miss the
 * window and insert a duplicate. The date key already scopes the dedupe to
 * ONE calendar day on its own, so a wider window here can never suppress the
 * NEXT day's report, which carries a different key regardless.
 */
const REPORT_DAILY_DEDUPE_WINDOW_MS = 25 * 60 * 60 * 1000;

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
    kind: 'schedule.parked',
    tier: 'blocking',
    storage: 'standing',
    subjectType: 'task',
    locate: (p) => ({ subjectId: p.taskId, agentId: p.agentId, sessionId: p.proposedBySessionId }),
    title: (p) => `${p.proposedBy} proposed a scheduled task`,
    body: (p) => `${p.taskName} will not run until you approve it.`,
    actions: () => SCHEDULE_ACTIONS,
    dedupeKey: (p) => `schedule:${p.taskId}`,
    relay: 'never',
  },

  'approval.pending': {
    kind: 'approval.pending',
    tier: 'blocking',
    storage: 'standing',
    // `system`, not `task`: an approval is not about one schedule — the same
    // condition covers a marketplace uninstall, a `mesh_unregister`, or any
    // future destructive capability. The bell on `/` is where every one of them
    // is decided, and `system` is the subject type that opens there.
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.approvalId, agentId: p.agentId }),
    title: (p) => `${p.requestedBy} needs your approval`,
    // The capability's TITLE and nothing else. The approval's own summary
    // carries the argument values an agent asked to run something with, and
    // this body reaches a lock screen and a Telegram thread — the card in the
    // app is where those belong.
    body: (p) => `${p.capabilityTitle} cannot be undone, so it will not run until you decide.`,
    actions: () => OPEN_ACTION,
    dedupeKey: (p) => `approval:${p.approvalId}`,
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
    // Keyed per EPISODE, not per session — the one kind here whose subject can
    // recur. A session that falls over, is fixed, and falls over again is two
    // things to be told about, and the escalation ledger asks "has this subject
    // already been escalated?" against this exact string. On a session-only key
    // the first episode's ledger row would answer yes forever and silently
    // suppress the phone ping for every later one (DOR-1387 review).
    dedupeKey: (p) => `session-error:${p.sessionId}:${p.since}`,
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

  'signin.required': {
    // Raised by the runtime-registry wrap (`emitters/runtime-signin.ts`), which
    // sees EVERY turn on every runtime — the interactive composer, a room reply,
    // a 3am scheduled run and an agent-to-agent relay delivery alike.
    //
    // **Standing since DOR-1657, and `blocking` with it.** DOR-1654 shipped this
    // as a plain `event` for one stated reason: `blocking` is reserved for a
    // condition a person can END, every such kind is `standing`, and a standing
    // kind needs a store that answers "is it still waiting?" — which nothing
    // owned for a credential. `runtime-signin-watch.ts` is now that store: a
    // runtime stands in it while its last turn died on its sign-in and no turn
    // since has gone through, and the next clean turn on that runtime is the
    // resolution edge. With an owner, the reservation is satisfied and the
    // storage discipline the ADR prescribes applies.
    //
    // **`standing-recorded`, not plain `standing`, and the restart is why.**
    // Being standing buys the phone: escalation carries standing kinds only, so
    // this is what reaches somebody asleep at 3am with a dead token and a
    // schedule about to run. But a standing kind writes nothing while it stands,
    // and this one's store is the only one held in MEMORY — so a server that
    // restarted overnight would leave no push, no row, and no evidence at all
    // that anything had broken. Writing the row at the raise edge is what keeps
    // the record; see {@link NotificationStorageRule}.
    //
    // The staleness objection that argues for plain `standing` does not apply,
    // because the wording below never goes stale: "stopped working" is as true
    // next month as it was that night, and the resolution row that follows says
    // plainly that it came back.
    kind: 'signin.required',
    tier: 'blocking',
    storage: 'standing-recorded',
    // `system`, not `agent` or `session`: a dead credential is not about the
    // turn that tripped over it. Clicking through opens Settings → Runtimes,
    // which is where signing in again actually happens.
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.runtime }),
    // **Past tense on both edges, because a stored row outlives what it
    // describes.** `session.error` set the pattern with "stopped on an error",
    // and the reason is the same: the raise row sits in the inbox long after
    // somebody signs in, so a present-tense "needs you to sign in" would be
    // telling them to do a thing they already did. `outcome` cannot rescue it —
    // the client renders title and body, and nothing else.
    //
    // `clearedAt` is what lets one builder serve both rows. Without it the
    // second row would repeat the first word for word.
    //
    // The third sentence is the restart case, and it is deliberately NOT the
    // all-clear: boot closes an episode it can never see the end of, and saying
    // "working again" there would be DorkOS asserting something nobody checked.
    title: (p) => {
      const name = runtimeDisplayName(p.runtime);
      if (!p.clearedAt) return `Your ${name} sign-in stopped working`;
      return p.closedAtBoot
        ? `DorkOS restarted while your ${name} sign-in was broken`
        : `Your ${name} sign-in is working again`;
    },
    body: (p) => {
      if (!p.clearedAt) return 'Scheduled tasks and agent replies cannot run until you sign in.';
      return p.closedAtBoot
        ? 'It stopped tracking that. If the sign-in is still broken, the next task or reply will say so.'
        : undefined;
    },
    // ONE per runtime per EPISODE, however many tasks, rooms and relay
    // deliveries trip over the same dead credential — the watch's own store is
    // what collapses them, synchronously, before any of them can say anything.
    // The `since` is what keeps a SECOND episode distinct from the first; see
    // the payload field for why the ledger makes that non-negotiable.
    dedupeKey: (p) => `signin:${p.runtime}:${p.since}`,
    // **Zero, and it has to be.** The two rows of one episode share this key by
    // design — that shared string is what files them, the escalation timer and
    // the resolution under one identity. Any positive window would therefore
    // suppress the "working again" row whenever somebody fixed their sign-in
    // faster than the window, which is a surface that silently comes and goes
    // with how quickly the operator reacted. Nothing is lost: repeat suppression
    // for this kind lives in the watch's episode store, which is synchronous and
    // so catches the concurrent burst a store-based window never could.
    dedupeWindowMs: 0,
    // Relay `never` governs the stored rows, which are in-app history. The
    // escalation ladder sends under its own `always` policy while the condition
    // still stands — see `escalation-service.ts`.
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
    // The one kind whose title AND body are already fully written when they
    // arrive — `shift-report.ts` composes both from the day's actual counts,
    // and re-deriving a headline here from a payload that only carries the
    // prose would be a second author for the same sentence.
    kind: 'report.daily',
    tier: 'quiet',
    storage: 'event',
    subjectType: 'system',
    locate: (p) => ({ subjectId: p.date }),
    title: (p) => p.title,
    body: (p) => p.summary,
    dedupeKey: (p) => `report-daily:${p.date}`,
    // Held open for most of a day: the dedupe key already scopes to ONE
    // calendar day, so a wide window here only guards against the composer
    // being asked twice for the SAME day (a restart mid-day re-checking) —
    // it can never suppress the next day's report, which carries a different
    // key. See `REPORT_DAILY_DEDUPE_WINDOW_MS`.
    dedupeWindowMs: REPORT_DAILY_DEDUPE_WINDOW_MS,
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
 * **Every kind is wired now.** `dm.received` and `mention.received` in
 * `services/rooms/room-service.ts` (W4 task T11, DOR-1388); `report.daily` via
 * `emitters/shift-report.ts` (W4 task T12, DOR-1389).
 *
 * The STANDING kinds are listed here on their RESOLUTION edge, which is the
 * only edge that writes a row. Their raise edge is wired too — it announces the
 * arrival (`standing_pending`, DOR-1570) and starts an escalation clock instead
 * of storing anything (W3 task T10, DOR-1387), so a blocking condition nobody
 * answers reaches a phone. See `standing-events.ts` and `escalation-service.ts`.
 *
 * **`approval.pending` is the one standing kind with no resolution row**, and
 * that is deliberate rather than missing (DOR-1570): the `approvals` table
 * already records how every approval ended (`state`, `decidedAt`, `consumedAt`)
 * and `approval_resolved` already retires its card in every open window, so a
 * second history row would be a second source of truth for something that has
 * one. Its resolution edge disarms the ladder and announces
 * `standing_resolved`, and writes nothing — see
 * `emitters/capability-approval.ts`.
 *
 * `signin.required` joined them in DOR-1657. Its raise edge is a failing turn
 * and its resolution edge is the next turn on that runtime that gets through,
 * both seen by `services/observability/runtime-signin-watch.ts` — see
 * `emitters/runtime-signin.ts`.
 */
export const WIRED_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'ask.pending',
  'schedule.parked',
  'approval.pending',
  'session.error',
  'turn.completed',
  'run.completed',
  'dm.received',
  'mention.received',
  'agent.note',
  'dead-letter.created',
  'agent.unreachable',
  'signin.required',
  'update.installed',
  'report.daily',
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

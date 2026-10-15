/** Pure event/status data contracts and cold projection builders. */
import type {
  SessionEvent,
  SessionStatus,
  SessionContextUsage,
} from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO, PermissionMode } from '@dorkos/shared/types';

/**
 * An event as produced by an adapter: a {@link SessionEvent} union member with
 * the `seq` omitted. The projector stamps `seq` on ingest so the adapter never
 * has to track ordering. This keeps the adapter a pure normalizer.
 */
type UnsequencedSessionEvent<Event> = Event extends unknown ? Omit<Event, 'seq'> : never;
export type RawSessionEvent = UnsequencedSessionEvent<SessionEvent>;

/**
 * A sign-in card the projector is carrying past its own turn (DOR-1004), plus
 * how much of its grace it has spent.
 */
export interface SigninCardEntry {
  /** The card itself — the link, the disclosure, and who it is for. */
  required: Extract<SessionEvent, { type: 'mcp_signin_required' }>;
  /** The resolution that turned it into a receipt, once one has arrived. */
  resolved?: Extract<SessionEvent, { type: 'mcp_signin_resolved' }>;
  /**
   * Whether this entry has already survived a `turn_start`. An unresolved card
   * and a receipt both get exactly one turn of grace; the second `turn_start`
   * retires them.
   */
  carried: boolean;
}

/**
 * The partial status payload carried by a `status_change` event: top-level
 * keys are optional and the nested `contextUsage` is itself partial (a delta
 * may carry only `outputTokens`, or only the context/cache totals).
 */
export type StatusChangePayload = Extract<SessionEvent, { type: 'status_change' }>['status'];

/** Permission mode used before any `status_change` reports one. */
const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/** Allocate an unrelated context-usage base; the projector retains its actual instance privately. */
export function createIsolatedProjectorContextBase(): Readonly<{
  mergeBaseContextUsage(prior: SessionContextUsage | null): SessionContextUsage;
}> {
  /** A fully-zeroed {@link SessionContextUsage}; the base for the first delta. */
  const ZERO_CONTEXT_USAGE: SessionContextUsage = {
    totalTokens: 0,
    maxTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  /**
   * Resolve the base to field-wise-merge a partial `contextUsage` delta onto.
   * When no prior usage exists (cold status), start from {@link ZERO_CONTEXT_USAGE}
   * so the merged result is still the full (non-partial) {@link SessionContextUsage}.
   *
   * @param prior - The currently-held usage, or `null` on a cold status.
   */
  function mergeBaseContextUsage(prior: SessionContextUsage | null): SessionContextUsage {
    return prior ?? ZERO_CONTEXT_USAGE;
  }

  return Object.freeze({ mergeBaseContextUsage });
}

/** A cold-snapshot status: every usage field null, idle, no subagents. */
export function coldStatus(): SessionStatus {
  return {
    contextUsage: null,
    cost: null,
    usage: null,
    cacheStats: null,
    model: null,
    permissionMode: DEFAULT_PERMISSION_MODE,
    todoCounts: null,
    runningSubagentCount: 0,
    lifecycle: 'idle',
    lastError: null,
    limit: null,
    accountUsage: null,
  };
}

/**
 * What a hydrator may fill into a held status without an event: cached figures
 * that describe the session but that no runtime event carries on open.
 */
export interface StatusSeed {
  /** The account's cached usage (replaces the held value). */
  accountUsage?: SessionStatus['accountUsage'];
  /** The session's `usage` as derived from its account (replaces the held value). */
  usage?: SessionStatus['usage'];
  /** A stored or derived context reading (fills only an EMPTY held value). */
  contextUsage?: SessionContextUsage;
}

/** A live interaction the projector tracks for pending-recovery projection. */
export interface TrackedInteraction {
  type: PendingInteractionDTO['type'];
  startedAt: number;
  /** Re-emit payload, minus the timer fields the selector recomputes. */
  snapshot: Record<string, unknown>;
}

/**
 * A lifecycle-bearing status update fanned out to global listeners (the
 * session-list broadcaster turns these into `session_status` events on
 * `/api/events`, which drive the sidebar's liveness indicators).
 */
export interface ProjectorStatusUpdate {
  /** The id the projector is CURRENTLY registered under (canonical post-rekey). */
  sessionId: string;
  /** Working directory of the session, when known — lets clients group liveness per agent. */
  cwd: string | undefined;
  /**
   * On a rekey re-announce only: the request UUID this projector streamed
   * under before the canonical id resolved. Listeners must retire any state
   * held under it — pre-rekey transitions fanned out under that id, and no
   * removal event will ever follow for it.
   */
  retiredSessionId?: string;
  /** A copy of the full projected status. */
  status: SessionStatus;
}

/**
 * How an `interaction_resolved` ended, in the three words a receipt can say.
 *
 * The stream's own five resolutions collapse to three because that is what a
 * card has to draw: a person answered it, it stopped mattering, or the clock
 * answered instead. `approved`, `denied` and `answered` are all "a person
 * answered"; the receipt line that follows reads the transcript's own record for
 * WHICH, and this is only deciding whether to say "already answered" or
 * "no longer needed".
 *
 * A resolution with no outcome at all — the stream's generic clear — is
 * `cancelled` rather than `answered`, because nobody can say a person did
 * anything. "No longer needed" is the honest thing to put on a card whose
 * request quietly went away.
 *
 * @param resolution - The resolution the stream carried, when it carried one.
 */
export function askOutcomeOf(
  resolution: 'approved' | 'denied' | 'answered' | 'expired' | 'cancelled' | undefined
): 'answered' | 'cancelled' | 'expired' {
  if (resolution === 'expired') return 'expired';
  if (resolution === undefined || resolution === 'cancelled') return 'cancelled';
  return 'answered';
}

/** Allocate unrelated turn-membership DATA; the projector keeps its actual set private. */
export function createIsolatedProjectorTurnMembership(): ReadonlySet<SessionEvent['type']> {
  /**
   * Events that ride the stream but are NOT part of the turn they arrive during.
   *
   * `inProgressTurn` is the turn's transcript: it is what a cold hydrate replays
   * as the live turn, what a log-backed projector persists as history, and what
   * the client folds into the conversation. Two members belong nowhere near it:
   *
   * - **`turn_end`** closes the window rather than joining it (the original rule).
   * - **`queue_update`** is bookkeeping ABOUT the session, not something the agent
   *   or the person said in it. Letting it in would persist the queue into a
   *   runtime's history and — worse — replay a STALE copy of the queue behind the
   *   snapshot's fresh `queuedMessages` on every reconnect, so a client applying
   *   the turn would overwrite a correct queue with an older one.
   * - **`context_staged`** is the receipt for a stage, which opens no turn (spec
   *   §2.5, task 4.2). It rides the stream so a window can show that a note landed,
   *   but it belongs to no turn's transcript: a staged message is not a turn the
   *   agent ran, and folding it into `inProgressTurn` would attach it to whatever
   *   window happened to be open, or strand it in a phantom one when none is.
   *
   * This is a rule about turn MEMBERSHIP only. It has nothing to do with the
   * reopen predicate (`TURN_REOPENING_STREAM_EVENT_TYPES`, #909), which acts on
   * raw runtime StreamEvents inside `feedProjector`: a `queue_update` never
   * travels that path at all, so it cannot open a window either.
   */
  const EVENTS_OUTSIDE_THE_TURN: ReadonlySet<SessionEvent['type']> = new Set([
    'turn_end',
    'queue_update',
    'context_staged',
    // - **`canvas`** is a change to the session's own table (spec
    //   `canvas-agent-seat` §1.3), and a person opening a document while nothing
    //   is running must not open a turn. A document opened MID-turn must not be
    //   replayed as part of that turn's content either: it is state, durable in
    //   SQLite, and a reader hydrates it from the snapshot.
    'canvas',
    // - **`chat_activity`** is a nudge that this chat's messaging changed (spec
    //   `spin-off-chats` §6), for the same reason `queue_update` is here: it is
    //   about the chat, not the words of the turn running in it.
    'chat_activity',
  ]);
  return EVENTS_OUTSIDE_THE_TURN;
}

/**
 * One projector starting or stopping holding a prompt only a person can answer.
 *
 * `pending` carries the whole DTO because the card that draws it is the card the
 * per-session stream already draws; `resolved` carries the id and how it ended,
 * because that is all a receipt needs.
 */
export type InteractionChange =
  | { type: 'pending'; sessionId: string; cwd: string; interaction: PendingInteractionDTO }
  | {
      type: 'resolved';
      sessionId: string;
      interactionId: string;
      outcome: 'answered' | 'cancelled' | 'expired';
      /**
       * The name of the person who answered, when the caller that took the
       * answer named one. Carried straight off the resolving event, so it is
       * present exactly when a person answered AND this install knows what to
       * call them — never on a cancellation or an expiry, which nobody
       * answered.
       */
      resolvedBy?: string;
    };

/**
 * The refusal rule: every path that declines to do the obvious thing writes
 * exactly one line, saying why — and whether anybody was told.
 *
 * > On 2026-07-31 a room exchange ran forty-one minutes. Four notices were
 * > written, two approval prompts expired unanswered, a watchdog killed a turn,
 * > and the server wrote three log lines. The refusals that mattered most were
 * > the ones nobody could see, and those were exactly the ones that left no
 * > record at all.
 *
 * Two fields make a refusal answerable by `jq` rather than by reading prose:
 *
 * - **`reason`** comes from a CLOSED union ({@link RefusalReason}), never a
 *   free-form string, so `jq 'group_by(.reason)'` works without parsing English.
 * - **`visibility`** says whether the person was told: `shown`, `damped`
 *   (a notice was suppressed), or `silent` (there was never a notice).
 *
 * **Level follows visibility, and that is the load-bearing part.** A refusal
 * the user can see is `info` — the product already told them. A refusal that was
 * damped or silent is `warn`, because the log line is then the ONLY record that
 * anything happened. That is precisely the class of event that produced two
 * invisible ten-minute silences in the incident.
 *
 * @module services/observability/refusals
 */
import { currentDispatch } from '../../lib/dispatch-context.js';
import { logger } from '../../lib/logger.js';
import { recordRefusal } from './dispatch-buffers.js';

/**
 * Whether the person on the other end learned that something was declined.
 *
 * - `shown` — a notice, an error, or an HTTP status reached them.
 * - `damped` — a notice existed but was deliberately suppressed as a repeat.
 * - `silent` — there is no notice for this path; the log is the only record.
 * - `chosen` — the agent decided this, and nobody was waiting to be told.
 *
 * **`chosen` is the one that does not log at `warn`, and the reason is the same
 * reason the other three do.** Level follows visibility because a refusal
 * nobody saw is the only record that it happened. A `chosen` refusal is the
 * expected, common outcome on the commonest path in the product — an engaged
 * agent overhearing a message that named somebody else — and filing thousands of
 * them at `warn` would make `warn` mean nothing, which is the fastest way to
 * lose the very signal the rule protects. It is a fourth value rather than a
 * reuse of `silent` so that an operator grepping for invisible failures does not
 * have to subtract the expected case by hand.
 */
export type RefusalVisibility = 'shown' | 'damped' | 'silent' | 'chosen';

/**
 * Every reason DorkOS declines to do the obvious thing, as one closed set.
 *
 * Closed on purpose. A free-form reason string reads fine to a person and is
 * useless to the tool that has to group ten thousand lines, and it drifts: the
 * same refusal acquires three spellings across three files, and nothing notices.
 * Adding a reason here is a deliberate act, and the guide's table is generated
 * from the same list a call site picks from.
 */
export const REFUSAL_REASONS = {
  /** An agent was already mid-turn, so no second turn ran. */
  agent_busy: 'the agent was already working',
  /**
   * A routing rule sent an overheard message straight to silence, so no turn
   * ran (spec `engaged-response-gate` §4).
   *
   * The agent was picked only because its engaged window was open — nobody
   * named it — and one of the tier-1 rules recognised the message as somebody
   * else's: it named another agent, or it was a colleague answering a question
   * this agent is not part of. `detail.rule` says which.
   *
   * Paired with `visibility: 'chosen'` and never with any other: nothing was
   * refused TO anybody, because nobody asked.
   */
  not_addressed_to_me: 'the message was addressed to somebody else',
  /** A turn ran and ended in an error, or never finished at all. */
  turn_failed: 'the turn failed',
  /**
   * A room member's directory no longer holds the agent it was added as, so no
   * turn was started. Distinct from `agent_missing`, which is the inbound-chat
   * path failing to find a bound agent: this one is a room author that outlived
   * its agent, or was minted for a previous occupant of that directory.
   */
  agent_gone: 'the agent that owned this identity is gone',
  /** The cascade guard stopped an exchange that had gone around enough times. */
  cascade_depth: 'the exchange reached its automatic-reply limit',
  /** The cascade guard refused an agent that has already had its turns here. */
  cascade_repeat: 'the agent has already replied enough times in this exchange',
  /** The room has spent its automatic turns for the window. */
  room_budget: 'the room ran out of automatic turns',
  /**
   * A gathered message was owed a turn, and by the time its batch came round the
   * member had left the room (or the room had been archived). Distinct from
   * {@link agent_gone}: the agent is still registered and still answering
   * elsewhere, it is simply not a member here any more.
   */
  agent_left: 'the agent is no longer in the room',
  /**
   * A person asked, a turn ran perfectly well, and the agent chose not to reply
   * (spec `tool-only-room-replies` §D6).
   *
   * **The one reason here that is not a fault.** Every other member of this union
   * is something the room could not do; this is something an agent decided, and
   * it is the outcome `rooms.toolOnlyReplies` exists to make possible. It is
   * recorded anyway because each one is a measured near-miss during the flag's
   * dogfood week — a `group_by(.reason)` over it is exactly the count that
   * decides whether the flip graduates.
   */
  agent_declined: 'the agent read the question and chose not to reply',
  /** The `(room, agent)` session row could not be written, so no turn started. */
  session_bind_failed: 'the room session could not be bound',
  /** A prompt only a person can answer expired, and was denied by the clock. */
  interaction_expired: 'nobody answered the prompt in time',
  /** An inbound chat message resolved to no binding at all. */
  no_binding: 'nothing connects this chat to an agent',
  /**
   * An inbound message came from a chat a person explicitly blocked via the
   * unclaimed-chat claim feed (connection-scoping spec §Part 3). Recordless
   * by design — the block itself already lives in `unclaimed_chats`; this
   * reason exists only so the drop is not indistinguishable from an
   * ordinary `no_binding` in the log.
   */
  chat_blocked: 'the chat is blocked',
  /** An inbound chat subject could not be parsed. */
  unreadable_subject: 'the chat subject could not be read',
  /** The binding exists but is paused. */
  binding_paused: 'the connection is paused',
  /** The binding is set not to pass messages to its agent. */
  receive_denied: 'the connection may not send to its agent',
  /** The bound agent is not in the mesh registry. */
  agent_missing: 'the agent is not registered',
  /** A session for the inbound message could not be created. */
  session_failed: 'a session could not be created',
  /** The relay's per-sender rate limit refused the publish. */
  rate_limited: 'too many messages too quickly',
  /**
   * An agent had spent its hourly allowance of proactive notes to a person, so
   * `relay_notify_user` refused one (`relay/notify-budget.ts`, DOR-1265).
   *
   * Separate from {@link rate_limited}, which protects the message BUS from a
   * sender publishing too fast. This one protects a PERSON from being messaged
   * too often, at a completely different order of magnitude — ten an hour, not a
   * hundred a minute — and a `group_by(.reason)` that could not tell them apart
   * would report a bus problem where the truth is an agent being a nuisance.
   */
  notify_budget: 'the agent has sent as many notes as it may this hour',
  /** The relay's authoritative budget gate refused the publish. */
  budget_exceeded: 'the message ran out of budget',
  /** Nothing accepted the turn — no subscriber, or a gate that named itself. */
  delivery_failed: 'the runtime did not accept the turn',
  /**
   * An inbound message carried no text and the binding is not bridged. A
   * captionless media message (spec `chats-as-channels` §5.5) publishes with
   * `content: ''` so a future bridge can build a placeholder from
   * `platformData.media`, but nothing on the classic (unbridged) path reads
   * that descriptor yet — dispatching empty content anyway would run a real
   * agent turn over nothing (DOR-866).
   */
  empty_content: 'no text content to answer',
} as const;

/** One reason from {@link REFUSAL_REASONS}. */
export type RefusalReason = keyof typeof REFUSAL_REASONS;

/**
 * One refusal, in the shape both the log and the diagnostic buffer take.
 *
 * Everything optional is an id or a coarse enum, never content — the same
 * discipline the span allowlist enforces, applied to a log line.
 */
export interface Refusal {
  reason: RefusalReason;
  visibility: RefusalVisibility;
  /** The room it happened in, when it happened in one. */
  roomId?: string;
  /** The agent it happened to. */
  authorId?: string;
  /** The session it happened on. */
  sessionId?: string;
  /** The room entry that triggered it. */
  entryId?: string;
  /**
   * WHICH dispatch this refusal belongs to, when the caller knows better than
   * the ambient scope does. Three states, and the third is the one that matters:
   *
   * - **absent** — inherit the ambient dispatch. Correct for a refusal written
   *   from inside the dispatch it is about.
   * - **a string** — this dispatch, whatever the ambient one says.
   * - **`null`** — *no* dispatch, and never the ambient one.
   *
   * `null` exists because "no id" and "the wrong id" are different failures and
   * only one of them is survivable. A room's refusals are decided synchronously
   * inside `RoomService.post`, before any target has been claimed — and when the
   * post is an AGENT'S REPLY, that runs inside the replying agent's dispatch
   * scope. Left ambient, a cascade refusal about Bo is stamped with Ana's
   * dispatch id, and a `jq 'select(.dispatchId==…)'` over Ana's chain returns a
   * refusal that has nothing to do with her. A missing field is legible; a
   * bystander's id is a lie the tooling cannot detect.
   */
  dispatchId?: string | null;
  /** Free-form-shaped but bounded extras — ids, counts, durations, coarse enums. */
  detail?: Record<string, string | number | boolean | undefined>;
}

/**
 * Write the one line a refusal owes, at the level its visibility earns.
 *
 * Correlation is ambient by default — the file reporter adds the dispatch id of
 * whatever scope the line was written in — so a refusal written from inside its
 * own dispatch needs to say nothing. A caller that knows better passes
 * {@link Refusal.dispatchId}: a string to name the dispatch, or `null` to state
 * that there is none and refuse the ambient one.
 *
 * @param message - The `'[tag] sentence'` line, in the same voice as every other.
 * @param refusal - Why, who it happened to, and whether they were told.
 */
export function logRefusal(message: string, refusal: Refusal): void {
  const { reason, visibility, dispatchId, detail, ...where } = refusal;
  const ambient = currentDispatch();
  // `undefined` means "the caller did not say" — inherit. `null` means "there is
  // no dispatch" — and must beat the ambient one rather than falling back to it.
  const resolved = dispatchId === undefined ? ambient?.dispatchId : (dispatchId ?? undefined);
  const fields = {
    ...compact(where),
    ...compact(detail),
    // Present as a KEY whenever there is an ambient id to override, because the
    // reporter injects that id into any entry that does not already carry one —
    // and `JSON.stringify` drops a key whose value is `undefined`. That is what
    // makes an explicit `null` a SUPPRESSION rather than a no-op. When there is
    // nothing to suppress and nothing to say, the key stays off the line.
    ...(resolved !== undefined
      ? { dispatchId: resolved }
      : ambient !== undefined
        ? { dispatchId: undefined }
        : {}),
    reason,
    visibility,
  };
  // Level follows visibility. A refusal nobody saw is the only record that it
  // happened, and a record filed at `info` is a record nobody looks at — so
  // `damped` and `silent` are `warn`. `chosen` joins `shown` at `info` for the
  // opposite reason: it is the expected outcome rather than an incident, and it
  // is common enough that filing it at `warn` would drown the two that are not.
  if (visibility === 'shown' || visibility === 'chosen') logger.info(message, fields);
  else logger.warn(message, fields);
  // The same fact, kept in memory so `GET /api/debug/refusals` can answer
  // "why has nothing replied for ten minutes" without anyone opening a file.
  // The log is still the durable record; this is the last 256, for right now.
  //
  // The origin rides along only when the id came from the ambient scope. An
  // explicitly-named dispatch may belong to a scope this frame is not inside,
  // and the ambient origin would then describe a different dispatch — the exact
  // substitution `dispatchId: null` exists to prevent, one field over.
  const fromAmbient = resolved !== undefined && resolved === ambient?.dispatchId;
  recordRefusal(refusal, {
    ...(resolved !== undefined ? { dispatchId: resolved } : {}),
    ...(fromAmbient ? { origin: ambient.origin } : {}),
  });
}

/** Drop the `undefined` entries of a bag, so no key reaches a line with no value. */
function compact(bag: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!bag) return {};
  return Object.fromEntries(Object.entries(bag).filter(([, value]) => value !== undefined));
}

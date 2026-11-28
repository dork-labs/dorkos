/**
 * `session_start`'s claim step (DOR-4019, DOR-3690): a chat started on a key
 * claims it for the new chat. A start on a key another live chat of the same
 * agent holds starts nothing: the caller gets that chat back to message
 * instead, or, when it may not read that chat, a refusal naming it as private.
 * Either way it can call again with `startAnyway`.
 *
 * The key is the one the caller named, else the one ticket or pull request the
 * start's title, reason or first message names ({@link inferWorkKey}), so an
 * agent that forgets to name it still does not start a duplicate. A key read
 * off the brief is a guess, so it is held to less:
 *
 * - Read only for a start made from a chat. The work queue starts a person's
 *   queued work with no calling chat, and a claim never blocks a person.
 * - Handed back only when the title or reason names it. A key only the first
 *   message names is claimed when it is free and otherwise left alone, since a
 *   brief often names the work it relates to rather than the work it is.
 * - Never handed over from the calling chat: a coordinator that holds a ticket
 *   and starts a parallel lane on it keeps the ticket. Naming `claim` is how a
 *   caller hands its own work on.
 *
 * The claim is taken under the new chat's minted id before anything launches,
 * so two racing starts on one key cannot both get it; a start that is refused
 * later frees it again (`discardUnstartedSession`), and a chat that settles on
 * another id takes it along.
 *
 * @module services/session/claims/work-claim-start
 */
import { dorkReferenceOrNull } from '@dorkos/shared/dork-ref';
import { chatRefMarkdownLink } from '@dorkos/shared/session-link';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { chatTitleOf, maySeeChat } from '../chat-messages/chat-message-wiring.js';
import { normaliseClaimKey } from './work-claim-service.js';
import { getWorkClaims } from './work-claim-current.js';
import { inferWorkKey } from './work-claim-infer.js';

/** What the start step needs from the call. */
export interface ClaimForStartInput {
  /** The call's own arguments: the key it named, the override, and its brief. */
  args: {
    claim?: string;
    startAnyway?: boolean;
    title?: string;
    reason?: string;
    prompt?: string;
  };
  /** The calling agent's Mesh id, from the verified caller. */
  agentId: string | undefined;
  /** The calling agent's home. */
  agentPath: string;
  /** The calling chat, when the call came from one. */
  callerSessionId: string | null;
  /** The new chat's minted id. */
  sessionId: string;
}

/**
 * What `session_start` answers instead of starting a second chat on work one of
 * the caller's own chats already holds: that chat, to message instead.
 */
export interface SessionAlreadyRunningResult {
  /** The chat that holds the work. */
  sessionId: string;
  /** Its title, when one is known. Untrusted text. */
  title: string | null;
  /** A markdown link that opens it, to use instead of its id. */
  link: string;
  /** Its `dork:chat:` reference, for a `/r/` link, or null when the id cannot be one. */
  ref: string | null;
  /** The work key it holds, normalised. */
  claim: string;
  /** Always `already-running`: nothing new was started. */
  status: 'already-running';
  /** What to do next. */
  note: string;
}

/** Why a start did not go ahead: a chat to use instead, or a refusal. */
export type ClaimForStartHold =
  { running: SessionAlreadyRunningResult; refusal?: never } | { refusal: string; running?: never };

/**
 * Claim the start's key for the chat about to start.
 *
 * @param input - The call's arguments, the verified caller and the new chat's id.
 * @returns `null` to go ahead; otherwise the holding chat when the caller may
 *   read it, or the refusal sentence when it may not.
 */
export async function claimForStart(input: ClaimForStartInput): Promise<ClaimForStartHold | null> {
  const claims = getWorkClaims();
  const named = input.args.claim;
  const inferred =
    named === undefined && input.callerSessionId !== null ? inferWorkKey(input.args) : null;
  const raw = named ?? inferred?.key;
  if (!raw || !input.agentId || !claims) return null;
  const key = normaliseClaimKey(raw);
  if (!key) return null;
  const result = claims.claim(input.agentId, input.sessionId, key, undefined, {
    writer: 'session-start',
    chatId: input.callerSessionId,
  });
  if (result.ok || input.args.startAnyway) return null;
  const holder = result.holder.sessionId;
  // The calling chat holds it itself: naming it hands the job on to the new lane, and a
  // key only read off the brief leaves it where it is, the lane starting unclaimed.
  if (holder === input.callerSessionId) {
    if (named !== undefined) claims.handOver(input.agentId, key, holder, input.sessionId);
    return null;
  }
  // A key only the first message names is too weak a guess to turn a start away.
  if (inferred?.from === 'prompt') return null;
  // Handed back only when the calling chat may read it; otherwise named as private.
  const visible =
    input.callerSessionId !== null &&
    maySeeChat({ sessionId: input.callerSessionId, agentPath: input.agentPath }, holder);
  if (!visible) {
    return {
      refusal: `${key} is already claimed by a private chat of yours since ${result.holder.claimedAt}. Leave it to that chat, or call again with startAnyway: true to start a second chat without the claim.`,
    };
  }
  const stored = await chatTitleOf(holder);
  const title = stored ? (sanitizeIdentity(stored) ?? null) : null;
  const link = chatRefMarkdownLink(holder, title);
  return {
    running: {
      sessionId: holder,
      title,
      link,
      ref: dorkReferenceOrNull('chat', holder),
      claim: key,
      status: 'already-running',
      note: `Already running: ${link}, on ${key} since ${result.holder.claimedAt}. Nothing new started. Message that chat instead (a message wakes it), or call again with startAnyway: true for a second chat.`,
    },
  };
}

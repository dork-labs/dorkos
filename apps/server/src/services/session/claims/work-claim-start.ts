/**
 * `session_start`'s claim step (DOR-4019): a chat started on a key claims it for
 * the new chat, and a start on a key another live chat of the same agent holds
 * is refused, naming the holder. The caller either leaves the work to it or
 * calls again with `startAnyway`.
 *
 * The claim is taken under the new chat's minted id before anything launches,
 * so two racing starts on one key cannot both get it; a start that is refused
 * later frees it again (`discardUnstartedSession`), and a chat that settles on
 * another id takes it along.
 *
 * @module services/session/claims/work-claim-start
 */
import { chatMarkdownLink } from '@dorkos/shared/session-link';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { chatTitleOf, maySeeChat } from '../chat-messages/chat-message-wiring.js';
import { normaliseClaimKey } from './work-claim-service.js';
import { getWorkClaims } from './work-claim-current.js';

/** What the start step needs from the call. */
export interface ClaimForStartInput {
  /** The key the caller named, raw. */
  claim?: string;
  /** Start even when another chat holds it. */
  startAnyway?: boolean;
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
 * Claim `claim` for the chat about to start.
 *
 * @returns The refusal sentence when another chat holds the key and the caller
 *   did not say to start anyway; otherwise `null`.
 */
export async function claimForStart(input: ClaimForStartInput): Promise<string | null> {
  const claims = getWorkClaims();
  if (!input.claim || !input.agentId || !claims) return null;
  const key = normaliseClaimKey(input.claim);
  if (!key) return null;
  const result = claims.claim(input.agentId, input.sessionId, key);
  if (result.ok || input.startAnyway) return null;
  const holder = result.holder.sessionId;
  // The calling chat holds it itself: starting a lane for its own job hands the job on.
  if (holder === input.callerSessionId) {
    claims.handOver(input.agentId, key, holder, input.sessionId);
    return null;
  }
  // Named only as private when the calling chat may not read the holder.
  const visible =
    input.callerSessionId !== null &&
    maySeeChat({ sessionId: input.callerSessionId, agentPath: input.agentPath }, holder);
  const raw = visible ? await chatTitleOf(holder) : null;
  const who = visible
    ? chatMarkdownLink(holder, raw ? (sanitizeIdentity(raw) ?? null) : null)
    : 'a private chat of yours';
  return `${key} is already claimed by ${who} since ${result.holder.claimedAt}. Leave it to that chat, or call again with startAnyway: true to start a second chat without the claim.`;
}

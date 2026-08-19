/**
 * Whether an Ask's DETAIL may be delivered into one bridged chat (spec
 * `ask-entitlement` §5.1).
 *
 * Two shipped sentences, put together, are this whole module:
 *
 * 1. An approval binds to the exact action the person saw (ADR 260725-133221),
 *    so an actionable card MUST carry the tool it authorizes.
 * 2. Detail may only go where every reader may act on it
 *    (`asks/ask-entitlement.ts`).
 *
 * @module services/relay/chat-bridge/ask-audience
 */
import { mayApprove } from '@dorkos/relay';

import type { Bridge } from './bridge-store.js';

/** One person on a chat platform, as the room's roster records them. */
export interface ExternalChatAuthor {
  /** The platform's own id for them, as an approver allowlist names it. */
  readonly platformUserId: string;
}

/**
 * Whether an Ask's detail may be delivered into this bridged chat as an
 * actionable card.
 *
 * True only for a live `private` chat — one person on the other end — whose
 * single external author is on that adapter's approver allowlist.
 *
 * **A group or supergroup is never eligible**, however many approvers are in
 * it, because the platform cannot tell us who is READING: a lurker who has
 * never posted has no author row, so the roster under-counts the audience and
 * would licence a leak. A `private` chat carrying two external authors — which
 * a group migration can produce — is refused for the same reason.
 *
 * Every clause fails closed. An empty or absent allowlist authorizes nobody
 * (`mayApprove`, DOR-609: absence is not consent).
 *
 * @param input - The bridge, the room's external roster, and the adapter's
 *   configured approvers.
 * @returns Whether a card carrying the Ask's detail may be sent there.
 */
export function bridgedAskIsActionable(input: {
  readonly bridge: Bridge;
  readonly externalAuthors: readonly ExternalChatAuthor[];
  readonly approvers: readonly string[];
}): boolean {
  const { bridge, externalAuthors, approvers } = input;
  if (bridge.archivedAt !== null) return false;
  if (bridge.platformChatType !== 'private') return false;
  if (externalAuthors.length !== 1) return false;
  return mayApprove(approvers, externalAuthors[0]?.platformUserId);
}

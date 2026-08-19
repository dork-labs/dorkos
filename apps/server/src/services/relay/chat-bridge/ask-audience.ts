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
// The narrow subpath, not the `@dorkos/relay` barrel — the barrel pulls in
// `RelayCore` and its subscription registry, and this predicate needs one
// self-contained module (see `asks/ask-entitlement.ts` for the incident).
import { mayApprove } from '@dorkos/relay/approver-allowlist';

import type { Bridge } from './bridge-store.js';

/** One person on a chat platform, as the room's roster records them. */
export interface ExternalChatAuthor {
  /** The platform's own id for them, as an approver allowlist names it. */
  readonly platformUserId: string;
  /**
   * The adapter instance they reached us through, off their stored natural key.
   *
   * Compared against the bridge's own `adapterId` below. A roster is a room's,
   * not a chat's, so nothing else guarantees that the person the roster names
   * is a person on the chat this card would go to — and a platform user id is
   * only unique on the installation that issued it, so a match against another
   * platform's allowlist proves nothing.
   */
  readonly instanceId: string;
}

/**
 * Whether an Ask's detail may be delivered into this bridged chat as an
 * actionable card.
 *
 * True only for a live `private` chat — one person on the other end — whose
 * single external author reached us through THIS bridge's own adapter and is
 * on that adapter's approver allowlist.
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
  const person = externalAuthors[0];
  if (person === undefined || person.instanceId !== bridge.adapterId) return false;
  return mayApprove(approvers, person.platformUserId);
}

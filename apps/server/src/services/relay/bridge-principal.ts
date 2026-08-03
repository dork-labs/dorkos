/**
 * Grammar for the server-only bridge delivery principal (chats-as-channels
 * spec §6.4): `relay.bridge.{reply|initiate}.{adapterId}.{chatId}`.
 *
 * `deliver` (task 1.8) is the only writer of this principal and the consent
 * gate (`initiate-consent.ts`) is the only reader. Between them, the `from`
 * string is the ONLY channel a delivery's reply-vs-initiate classification can
 * travel over — `InitiateConsentGate` is `(from, subject) => decision`
 * (`packages/relay/src/types.ts:169`), two strings and nothing else — so the
 * classification has to be encoded in `from` itself, and this module is the
 * one place that encodes and decodes it.
 *
 * **The classification sits at a fixed position, ahead of the variable-length
 * tail, and that position is load-bearing.** A Telegram chat id — and, later,
 * a Slack channel id — may itself contain a dot. Reading the classification
 * from a fixed offset after the `relay.bridge.` prefix cannot be shifted by
 * anything in `adapterId` or `chatId`; reading it from the END of the string
 * would make the read depend on how many dots the chat id happened to have.
 * That is exactly the class of bug `parseHumanSubject` was written to avoid
 * (`human-subject.ts:55-60`), and this grammar follows the same discipline.
 *
 * @module server/services/relay/bridge-principal
 */

/** Every `relay.bridge.*` principal starts here. */
export const BRIDGE_PRINCIPAL_PREFIX = 'relay.bridge.';

/**
 * The two provenance classifications a bridge delivery can assert (spec
 * §6.6). Anything else in that position is unrecognized and must be denied,
 * never defaulted to either.
 */
export type BridgePrincipalClassification = 'reply' | 'initiate';

/** A `relay.bridge.*` principal, decomposed into its fixed-position parts. */
export interface ParsedBridgePrincipal {
  /** Read from the fixed segment right after the `relay.bridge.` prefix. */
  classification: BridgePrincipalClassification;
  /** The adapter instance the delivery targets. */
  adapterId: string;
  /**
   * The platform chat id. May itself contain dots (a Telegram chat id can);
   * this is the entire remainder of the principal after `adapterId`, joined
   * back together, never split further.
   */
  chatId: string;
}

const RECOGNIZED_CLASSIFICATIONS: ReadonlySet<string> = new Set<BridgePrincipalClassification>([
  'reply',
  'initiate',
]);

/**
 * Build a `relay.bridge.*` delivery principal.
 *
 * @param classification - Whether this delivery answers an inbound message
 *   (`'reply'`) or starts one (`'initiate'`) — spec §6.6's provenance rule.
 * @param adapterId - The adapter instance the delivery targets.
 * @param chatId - The platform chat id. May contain dots; the parser reads it
 *   positionally, never by counting separators, so no escaping is needed here.
 */
export function buildBridgePrincipal(
  classification: BridgePrincipalClassification,
  adapterId: string,
  chatId: string
): string {
  return `${BRIDGE_PRINCIPAL_PREFIX}${classification}.${adapterId}.${chatId}`;
}

/**
 * Parse a `relay.bridge.*` principal back into its parts.
 *
 * Returns `null` for anything that is not this grammar: a different prefix, a
 * classification segment that is not exactly `reply` or `initiate`, or a
 * missing `adapterId`/`chatId`. The caller (the consent gate) must treat
 * `null` as a denial, never as a default classification — see spec §6.6 point
 * 1 ("denying an unrecognised value rather than defaulting to either").
 *
 * @param from - The publish `from` principal.
 */
export function parseBridgePrincipal(from: string): ParsedBridgePrincipal | null {
  if (!from.startsWith(BRIDGE_PRINCIPAL_PREFIX)) return null;

  const rest = from.slice(BRIDGE_PRINCIPAL_PREFIX.length);
  const parts = rest.split('.');

  // Fixed position: classification first, adapterId second, everything after
  // that is the chat id, rejoined — never re-split by counting dots.
  const classification = parts[0];
  if (!classification || !RECOGNIZED_CLASSIFICATIONS.has(classification)) return null;

  const adapterId = parts[1];
  if (!adapterId) return null;

  const chatId = parts.slice(2).join('.');
  if (!chatId) return null;

  return { classification: classification as BridgePrincipalClassification, adapterId, chatId };
}

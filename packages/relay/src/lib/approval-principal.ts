/**
 * The sender principal a chat adapter publishes a person's approval click as.
 *
 * One definition, read from both sides of the approval bus: the Telegram and
 * Slack adapters stamp it on the `approval_response` they publish when a person
 * clicks Approve or Deny, and the Claude Code adapter's approval handler accepts
 * a decision from nobody else (DOR-2431).
 *
 * ## Why a `relay.system.*` principal
 *
 * The approval handler cannot trust anything in the payload — the session id,
 * tool call id, platform and user id are all things an agent can know or guess.
 * The one field an agent cannot choose is the envelope's `from`: every
 * `relay_send*` tool stamps the calling agent's own identity (there is no `from`
 * argument), and `POST /api/relay/messages`, the only ingress that takes a
 * caller-supplied `from`, refuses every `relay.system.*` principal
 * (`isServerOnlyPrincipal` in the server's `initiate-consent.ts`). The adapters
 * used to publish as `telegram:{userId}` and `slack:{userId}`, which that route
 * accepts from anyone, so those are no longer trusted.
 *
 * @module relay/lib/approval-principal
 */

/**
 * Prefix of the principal a chat adapter publishes an approval click as:
 * `relay.system.approval-bridge.{platform}.{adapterId}`.
 */
export const APPROVAL_BRIDGE_PRINCIPAL_PREFIX = 'relay.system.approval-bridge.';

/**
 * The principal one chat adapter publishes its approval clicks as.
 *
 * @param platform - The adapter's platform (`telegram`, `slack`). It is the
 *   segment the approval handler reads back, so it must hold no `.`.
 * @param adapterId - The adapter instance, for the audit trail.
 */
export function approvalBridgePrincipal(platform: string, adapterId: string): string {
  return `${APPROVAL_BRIDGE_PRINCIPAL_PREFIX}${platform}.${adapterId}`;
}

/**
 * The platform an approval sender speaks for, or `undefined` when the sender is
 * not a chat adapter's approval principal — which the approval handler refuses.
 *
 * @param from - The envelope's `from`, stamped by the publish pipeline.
 */
export function approvalBridgePlatformOf(from: string): string | undefined {
  if (!from.startsWith(APPROVAL_BRIDGE_PRINCIPAL_PREFIX)) return undefined;
  const rest = from.slice(APPROVAL_BRIDGE_PRINCIPAL_PREFIX.length);
  const dot = rest.indexOf('.');
  // Both segments must be present: a principal with no adapter id was not
  // built by `approvalBridgePrincipal`.
  if (dot <= 0 || dot === rest.length - 1) return undefined;
  return rest.slice(0, dot);
}

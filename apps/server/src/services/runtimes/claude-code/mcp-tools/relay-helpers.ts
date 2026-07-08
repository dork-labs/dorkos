/**
 * Shared helpers for Relay MCP tool handlers.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-helpers
 */
import path from 'node:path';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Sender identity injected on the external `/mcp` surface (no per-session context). */
export const EXTERNAL_MCP_SENDER = 'relay.external.mcp';

/** Server-resolved identity of the principal behind a Relay tool call. */
export interface SenderIdentity {
  /**
   * Relay subject used as the publish `from`. Namespace deny/allow rules
   * (written by RelayBridge) match on the agent subject `relay.agent.{ns}.{id}`,
   * so this is the value access control keys on.
   */
  subject: string;
  /**
   * Mesh agent id — present only when the session maps to a registered agent.
   * Used by `relay_notify_user` to resolve the caller's own channel bindings.
   */
  agentId?: string;
}

/**
 * Resolve the trusted sender identity for a Relay publish, server-side.
 *
 * The relay `from` is an authorization principal, not a label: namespace
 * deny/allow rules match on the agent's subject `relay.agent.{ns}.{id}`. Letting
 * the LLM assert its own `from` (or `agentId`) lets any agent claim another
 * identity and bypass those rules, so identity is derived from the session's
 * working directory rather than from tool arguments.
 *
 * - Registered agent (a manifest at `cwd`): its canonical subject via
 *   `meshCore.getSubjectByPath()`, which reads the UN-stripped registry entry —
 *   the same resolved namespace RelayBridge registered the endpoint and ACL
 *   rules with. (`getByPath()` cannot be used here: it returns a public
 *   manifest with `namespace` stripped, which would silently degrade the
 *   subject to `basename(cwd)` and match no rule for nested or
 *   explicit-namespace agents.)
 * - Any other session (or the external `/mcp` surface, `cwd` undefined): a
 *   deterministic, non-agent identity so the sender is still stable and
 *   unspoofable — no agent ACL rules apply to it.
 *
 * @param deps - Tool dependencies, for the Mesh registry lookup
 * @param cwd - The session's working directory, when known
 */
export function resolveSenderIdentity(deps: McpToolDeps, cwd: string | undefined): SenderIdentity {
  if (cwd && deps.meshCore) {
    const identity = deps.meshCore.getSubjectByPath(cwd);
    if (identity) return identity;
  }
  return { subject: cwd ? `relay.session.${path.basename(cwd)}` : EXTERNAL_MCP_SENDER };
}

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * Mirrors the prefix-matching convention used in RelayCore and ClaudeCodeAdapter.
 * Inlined here to avoid a runtime dependency on the @dorkos/relay dist output.
 */
export function inferEndpointType(
  subject: string
): 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown' {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.')) return 'query';
  if (subject.startsWith('relay.inbox.')) return 'persistent';
  if (subject.startsWith('relay.agent.')) return 'agent';
  return 'unknown';
}

/** Guard that returns an error response when Relay is disabled. */
export function requireRelay(deps: McpToolDeps) {
  if (!deps.relayCore) {
    return jsonContent({ error: 'Relay is not enabled', code: 'RELAY_DISABLED' }, true);
  }
  return null;
}

/**
 * Actionable guidance attached to ACCESS_DENIED publish errors.
 *
 * Cross-namespace messaging is denied by default (ADR-0033); the denial must
 * tell the agent (and through it, the user) how to open the path rather than
 * failing opaquely.
 */
export const ACCESS_DENIED_HINT =
  'Cross-namespace agent messaging is denied by default. Ask the user to allow it from the ' +
  'Agents page Access panel (or PUT /api/mesh/topology/access with ' +
  '{ sourceNamespace, targetNamespace, action: "allow" }). Use mesh_query_topology() to see ' +
  'current namespaces and rules.';

/**
 * Map a relay publish failure to an MCP error response, attaching the
 * cross-namespace remediation hint on access denials.
 *
 * @param e - The thrown publish error
 * @param fallback - Message used when the error is not an Error instance
 * @param fallbackCode - Code used when the message matches no known failure
 */
export function publishErrorContent(e: unknown, fallback: string, fallbackCode: string) {
  const message = e instanceof Error ? e.message : fallback;
  const code = message.includes('Access denied')
    ? 'ACCESS_DENIED'
    : message.includes('Invalid subject')
      ? 'INVALID_SUBJECT'
      : fallbackCode;
  return jsonContent(
    { error: message, code, ...(code === 'ACCESS_DENIED' && { hint: ACCESS_DENIED_HINT }) },
    true
  );
}

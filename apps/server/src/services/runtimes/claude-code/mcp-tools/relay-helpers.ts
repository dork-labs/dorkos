/**
 * Shared helpers for Relay MCP tool handlers.
 *
 * @module services/runtimes/claude-code/mcp-tools/relay-helpers
 */
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

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

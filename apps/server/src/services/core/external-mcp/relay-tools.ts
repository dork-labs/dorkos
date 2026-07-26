/**
 * Puts the `relay_*` tools (send/inbox/endpoints, adapters, trace and metrics)
 * on the external `/mcp` server.
 *
 * The names, descriptions, and input schemas are NOT written here: they come from
 * `getRelayTools`, `adapterToolDefinitions`, and `traceToolDefinitions` — the same
 * definitions the in-session server uses — via {@link registerFromDefinitions}.
 * Only the external-only additions live here — see that module for why (DOR-499).
 *
 * `relay_notify_user` is deliberately absent from {@link RELAY_EXTERNAL_CONFIGS}:
 * `getRelayTools` returns it alongside the other relay tools, but it has no entry
 * here, so `registerFromDefinitions` skips it and it never reaches `/mcp`.
 *
 * @module services/core/external-mcp/relay-tools
 */
import { DeliveryMetricsSchema } from '@dorkos/shared/relay-schemas';
import type { ToolRegistrar } from '../mcp-tool-gate.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { SenderIdentity } from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import { getRelayTools } from '../../runtimes/claude-code/mcp-tools/relay-tools.js';
import { adapterToolDefinitions } from '../../runtimes/claude-code/mcp-tools/adapter-tools.js';
import { traceToolDefinitions } from '../../runtimes/claude-code/mcp-tools/trace-tools.js';
import { ToolAnnotationPresets } from '../mcp-tool-metadata.js';
import { registerFromDefinitions, type ExternalToolConfigs } from './register-from-definitions.js';

const A = ToolAnnotationPresets;

/** The external-only additions for each `relay_*` tool (13 total). */
const RELAY_EXTERNAL_CONFIGS: ExternalToolConfigs = {
  relay_send: { annotations: A.mutateCreateLocal },
  // Not read-only: ack:true destroys the returned messages' payloads.
  relay_inbox: { annotations: A.mutateUpdateLocal },
  relay_list_endpoints: { annotations: A.readOnlyLocal },
  // Throws "already registered" on a duplicate subject rather than upserting — not idempotent.
  relay_register_endpoint: { annotations: A.mutateCreateLocal },
  relay_send_and_wait: { annotations: A.mutateCreateLocal },
  relay_send_async: { annotations: A.mutateCreateLocal },
  relay_unregister_endpoint: { annotations: A.mutateDeleteLocal },
  relay_list_adapters: { annotations: A.readOnlyLocal },
  // Opens a live connection to an external chat platform (Telegram, Slack, ...).
  relay_enable_adapter: { annotations: A.mutateUpdateOpenWorld },
  relay_disable_adapter: { annotations: A.mutateUpdateLocal },
  // Restarts connections to every enabled external chat platform.
  relay_reload_adapters: { annotations: A.mutateUpdateOpenWorld },
  relay_get_trace: { annotations: A.readOnlyLocal },
  relay_get_metrics: { annotations: A.readOnlyLocal, outputSchema: DeliveryMetricsSchema },
};

/**
 * Register every `relay_*` tool (send/inbox/endpoints, adapters, trace and
 * metrics — 13 tools total) against `registrar`.
 *
 * @param registrar - The gated tool registrar from `mcp-server.ts`, which runs each
 *   tool's permission tier before its handler.
 * @param deps - Shared MCP tool dependencies.
 * @param identity - Server-resolved sender identity injected as the publish
 *   `from` for every send tool, so the LLM cannot assert (spoof) its own
 *   identity to bypass namespace access rules.
 */
export function registerRelayTools(
  registrar: ToolRegistrar,
  deps: McpToolDeps,
  identity: SenderIdentity
): void {
  const definitions = [
    ...getRelayTools(deps, identity),
    ...adapterToolDefinitions(deps),
    ...traceToolDefinitions(deps),
  ];
  registerFromDefinitions(registrar, definitions, RELAY_EXTERNAL_CONFIGS);
}

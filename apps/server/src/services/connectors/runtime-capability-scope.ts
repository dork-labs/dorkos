/** Exact capability scope exposed by the internal runtime connector server. */

/** Classified execution capabilities eligible for turn-bound runtime projection. */
export const CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS = Object.freeze([
  'connectors.execute_read',
  'connectors.execute_write',
  'connectors.execute_destructive',
] as const);

/** Classified connector execution capability id. */
export type ConnectorRuntimeExecutionCapabilityId =
  (typeof CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS)[number];

/** Exact discovery and execution capabilities projected to authenticated runtimes. */
export const CONNECTOR_RUNTIME_CAPABILITY_IDS = Object.freeze([
  'connectors.list_granted_connections',
  'connectors.list_granted_operations',
  'connectors.request_connection',
  'connectors.get_connection_request',
  ...CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS,
] as const);

/** Capability id accepted by the internal runtime connector projection. */
export type ConnectorRuntimeCapabilityId = (typeof CONNECTOR_RUNTIME_CAPABILITY_IDS)[number];

/**
 * Test exact membership without prefix inference or broader MCP registration.
 *
 * @param capabilityId - Registry capability identifier.
 * @returns Whether the identifier is one of the private connector tools.
 */
export function isConnectorRuntimeCapabilityId(
  capabilityId: string
): capabilityId is ConnectorRuntimeCapabilityId {
  return CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === capabilityId);
}

/**
 * How long one `connectors.request_connection` call holds open waiting for the
 * person's answer before it returns the still-open request. Every runtime's
 * ceiling for one call on the connection tools is derived from this
 * (`CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS` in `runtimes/connector-tools.ts`), so a
 * held call never times out on the agent's side before the person could
 * answer. Past the hold nothing is lost: the answer reaches the agent's chat as
 * a follow-up when the person gives it. It lives here, beside the tool list,
 * because this module has no dependencies and every runtime can import it.
 */
export const CONNECTOR_REQUEST_LIVE_HOLD_MS = 10 * 60_000;

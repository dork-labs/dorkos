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
  ...CONNECTOR_RUNTIME_EXECUTION_CAPABILITY_IDS,
] as const);

/** Capability id accepted by the internal runtime connector projection. */
export type ConnectorRuntimeCapabilityId = (typeof CONNECTOR_RUNTIME_CAPABILITY_IDS)[number];

/**
 * Test exact membership without prefix inference or broader MCP registration.
 *
 * @param capabilityId - Registry capability identifier.
 * @returns Whether the identifier is one of the five private connector tools.
 */
export function isConnectorRuntimeCapabilityId(
  capabilityId: string
): capabilityId is ConnectorRuntimeCapabilityId {
  return CONNECTOR_RUNTIME_CAPABILITY_IDS.some((candidate) => candidate === capabilityId);
}

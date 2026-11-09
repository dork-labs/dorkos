import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_RUNTIME_CAPABILITY_IDS,
  isConnectorRuntimeCapabilityId,
} from '../runtime-capability-scope.js';

describe('runtime connector capability scope', () => {
  it('matches only the principal-bound access tools and three execution gates', () => {
    expect(CONNECTOR_RUNTIME_CAPABILITY_IDS).toEqual([
      'connectors.list_granted_connections',
      'connectors.list_granted_operations',
      'connectors.request_connection',
      'connectors.get_connection_request',
      'connectors.narrow_own_access',
      'connectors.narrow_agent_access',
      'connectors.approve_request',
      'connectors.undo_access_change',
      'connectors.list_access_changes',
      'connectors.execute_read',
      'connectors.execute_write',
      'connectors.execute_destructive',
    ]);
    for (const id of CONNECTOR_RUNTIME_CAPABILITY_IDS) {
      expect(isConnectorRuntimeCapabilityId(id)).toBe(true);
    }
    for (const id of [
      'connector.list_accounts',
      'connectors.list_granted_connections.extra',
      'connectors.list_granted_operations_for_agent',
      'connectors.execute',
      'connectors.execute_read.extra',
      'external.connectors.execute_read',
    ]) {
      expect(isConnectorRuntimeCapabilityId(id)).toBe(false);
    }
  });
});

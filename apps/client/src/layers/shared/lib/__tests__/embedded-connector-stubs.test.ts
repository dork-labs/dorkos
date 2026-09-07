import { describe, expect, it } from 'vitest';
import type { ConnectionId } from '@dorkos/shared/connector-schemas';

import { connectorStubs } from '../embedded-mode-stubs';

describe('embedded connector authority stubs', () => {
  it('refuses every authority-sensitive read instead of fabricating empty access', async () => {
    const reads = [
      () => connectorStubs.getAccessibleConnectorConnections(),
      () =>
        connectorStubs.getAccessibleConnectorOperations('agent-a', 'connection-a' as ConnectionId),
      () => connectorStubs.getAgentConnectorUsage(),
      () => connectorStubs.getOperatorConnectorUsage(),
      () => connectorStubs.getConnectorManagementReviews(),
    ];

    for (const read of reads) {
      await expect(read()).rejects.toThrow('Connections can only be managed in DorkOS itself.');
    }
  });
});

/**
 * A connected app's writes-back switch, mocked (DOR-4794): off for every
 * connection, and every change succeeds with the state it asked for. The mock
 * remembers each change, so a read after it (a refetch) answers what was set.
 *
 * @module test-utils/mock-connector-writes-back-transport
 */
import { vi } from 'vitest';
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChangeRequest,
} from '@dorkos/shared/connector-exclusion-schemas';
import type { Transport } from '@dorkos/shared/transport';

/** The time a mocked change says it was made. */
const ATTESTED_AT = '2026-11-19T12:00:00.000Z';

/** One connection's switch: offered (a Linear account, say) and off, unless overridden. */
export function writesBackState(
  connectionId: string,
  overrides: Partial<ConnectorWritesBack> = {}
): ConnectorWritesBack {
  return {
    connectionId,
    writesBackUnasked: false,
    writesBackAttestedAt: null,
    supported: true,
    ...overrides,
  };
}

/**
 * Mocks for the switch's two methods, sharing one in-memory store: `get`
 * answers what `set` last stored for that connection, off until then.
 */
export function createMockConnectorWritesBackTransport(): Pick<
  Transport,
  'getConnectorWritesBack' | 'setConnectorWritesBack'
> {
  const stored = new Map<string, ConnectorWritesBack>();
  return {
    getConnectorWritesBack: vi
      .fn()
      .mockImplementation(
        async (connectionId: string) => stored.get(connectionId) ?? writesBackState(connectionId)
      ),
    setConnectorWritesBack: vi
      .fn()
      .mockImplementation(
        async (connectionId: string, change: ConnectorWritesBackChangeRequest) => {
          const before = stored.get(connectionId) ?? writesBackState(connectionId);
          const after = writesBackState(connectionId, {
            writesBackUnasked: change.writesBackUnasked,
            writesBackAttestedAt: change.writesBackUnasked ? ATTESTED_AT : null,
          });
          stored.set(connectionId, after);
          return { ...after, changed: before.writesBackUnasked !== after.writesBackUnasked };
        }
      ),
  };
}

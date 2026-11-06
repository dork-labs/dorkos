/**
 * The global MCP servers slice of the mock Transport (DOR-3213), and a factory for one server.
 *
 * @module test-utils/mock-global-mcp
 */
import { vi } from 'vitest';
import type { GlobalMcpServerView } from '@dorkos/shared/global-mcp-schemas';
import type { Transport } from '@dorkos/shared/transport';

/** The global MCP server methods of the Transport port. */
type GlobalMcpMethods = Pick<
  Transport,
  'listGlobalMcpServers' | 'addGlobalMcpServer' | 'patchGlobalMcpServer' | 'removeGlobalMcpServer'
>;

/**
 * One server that is on for every agent and runs a pinned package, overridden field by field.
 *
 * @param overrides - The fields this test cares about.
 */
export function createMockGlobalMcpServer(
  overrides: Partial<GlobalMcpServerView> = {}
): GlobalMcpServerView {
  return {
    name: 'made-up-server',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'made-up-mcp@1.2.3'],
    env: [],
    headers: [],
    excludedAgents: [],
    addedAt: new Date(0).toISOString(),
    skippedOn: [],
    warnings: [],
    ...overrides,
  };
}

/** Mock global MCP server methods: an empty list, and writes a test must stub before using. */
export function globalMcpTransportMocks(): GlobalMcpMethods {
  return {
    listGlobalMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    addGlobalMcpServer: vi.fn().mockRejectedValue(new Error('addGlobalMcpServer not mocked')),
    patchGlobalMcpServer: vi.fn().mockRejectedValue(new Error('patchGlobalMcpServer not mocked')),
    removeGlobalMcpServer: vi.fn().mockRejectedValue(new Error('removeGlobalMcpServer not mocked')),
  };
}

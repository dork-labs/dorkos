/**
 * The shared injection decision for Codex and OpenCode agent turns.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { ConnectorRuntimeMcpInjection } from '../../connector-tools.js';
import {
  dorkosToolsPosture,
  resolveDorkosMcpInjection,
  DORKOS_MCP_HEADER_ENV_VARS,
} from '../dorkos-mcp-injection.js';

const runtimeTools: ConnectorRuntimeMcpInjection = {
  url: 'http://127.0.0.1:43123/mcp',
  agentToolsUrl: 'http://127.0.0.1:43123/agent-mcp',
  headers: {
    Authorization: 'Bearer turn-secret',
    'X-DorkOS-Connector-Runtime': 'codex',
    'X-DorkOS-Connector-Cwd': encodeURIComponent('/agents/researcher'),
  },
};

describe('DorkOS runtime tool injection', () => {
  it('reuses the authenticated turn headers on the agent-only route', async () => {
    expect(await resolveDorkosMcpInjection('/agents/researcher', runtimeTools)).toEqual({
      url: 'http://127.0.0.1:43123/agent-mcp',
      headers: runtimeTools.headers,
    });
  });

  it('maps every header value through subprocess environment indirection', () => {
    expect(DORKOS_MCP_HEADER_ENV_VARS).toEqual({
      Authorization: 'DORKOS_CONNECTOR_MCP_AUTHORIZATION',
      'X-DorkOS-Connector-Runtime': 'DORKOS_CONNECTOR_MCP_RUNTIME',
      'X-DorkOS-Connector-Cwd': 'DORKOS_CONNECTOR_MCP_CWD',
    });
  });

  it('wires an agent-bound turn with nothing switched on (DOR-2099)', async () => {
    // The graduation, stated as a test: there is no setting left to read. This
    // file mocks NOTHING — if the posture ever starts consulting configuration
    // again, the missing `configManager` stub is what fails here.
    expect(dorkosToolsPosture('/agents/researcher', true)).toEqual({ wired: true });
    expect(await resolveDorkosMcpInjection('/agents/researcher', runtimeTools)).not.toBeNull();
  });

  it('withholds for a plain session with no registered agent', async () => {
    expect(dorkosToolsPosture(undefined, true)).toEqual({ wired: false, why: 'no-agent' });
    expect(await resolveDorkosMcpInjection(undefined, runtimeTools)).toBeNull();
  });

  it('withholds when boot did not install the authenticated runtime boundary', async () => {
    expect(dorkosToolsPosture('/agents/researcher', false)).toEqual({
      wired: false,
      why: 'runtime-boundary-unavailable',
    });
    expect(await resolveDorkosMcpInjection('/agents/researcher', undefined)).toBeNull();
  });
});

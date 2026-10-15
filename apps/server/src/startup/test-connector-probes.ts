import type { ConnectorRuntimePrincipalService } from '../services/connectors/principal/runtime-principal-service.js';
import type {
  ConnectorRuntimeExecutionProbe,
  ConnectorRuntimeRequestProbe,
} from '../routes/test-control.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { connectorRuntimeHeaders } from '../services/runtimes/connector-tools.js';

/** Compose the test-only probes at the original guarded startup frontier, using its original principals. */
export function wireTestConnectorProbes(
  connectorRuntimePrincipals: ConnectorRuntimePrincipalService,
  listenerUrl: () => string
): {
  runtimeRequestProbe: ConnectorRuntimeRequestProbe;
  runtimeExecutionProbe: ConnectorRuntimeExecutionProbe;
} {
  const callRuntimeConnectorTool = async (input: {
    readonly sessionId: string;
    readonly agentPath: string;
    readonly signal: AbortSignal;
    readonly name: 'connectors.request_connection' | 'connectors.execute_read';
    readonly arguments: Record<string, unknown>;
  }) => {
    await runtimeRegistry.persistSessionRuntime(
      input.sessionId,
      'claude-code',
      { kind: 'test-harness' },
      input.agentPath
    );
    let ownsBinding = true;
    const binding = await connectorRuntimePrincipals.openTurn(
      {
        runtime: 'claude-code',
        canonicalSessionId: input.sessionId,
        agentPath: input.agentPath,
        canonicalCwd: input.agentPath,
        signal: input.signal,
      },
      { isCurrent: () => ownsBinding && !input.signal.aborted }
    );
    const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    ]);
    const client = new Client(
      { name: 'dorkos-e2e-connector-request', version: '1.0.0' },
      { capabilities: {} }
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(listenerUrl()), {
          requestInit: {
            headers: connectorRuntimeHeaders({
              bearer: binding.bearer,
              runtime: 'claude-code',
              canonicalCwd: input.agentPath,
            }),
          },
        })
      );
      return await client.callTool(
        {
          name: input.name,
          arguments: input.arguments,
        },
        undefined,
        { signal: input.signal, timeout: 120_000 }
      );
    } finally {
      ownsBinding = false;
      await client.close().catch(() => {});
      await connectorRuntimePrincipals.revoke(binding.bindingId, 'turn_terminal');
    }
  };
  const runtimeRequestProbe: ConnectorRuntimeRequestProbe = (input) =>
    callRuntimeConnectorTool({
      ...input,
      name: 'connectors.request_connection',
      arguments: { ...input.request },
    });
  const runtimeExecutionProbe: ConnectorRuntimeExecutionProbe = (input) =>
    callRuntimeConnectorTool({
      ...input,
      name: 'connectors.execute_read',
      arguments: { ...input.target },
    });
  return { runtimeRequestProbe, runtimeExecutionProbe };
}

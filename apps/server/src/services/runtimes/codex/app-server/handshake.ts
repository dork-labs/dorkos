/**
 * The `initialize` handshake every DorkOS connection to `codex app-server`
 * opens with (protocol §1): one `initialize`, then the `initialized`
 * notification. The binary's version is read from `userAgent`, the only place
 * the protocol reports it.
 *
 * @module services/runtimes/codex/app-server/handshake
 */
import { SERVER_VERSION } from '../../../../lib/version.js';
import { parseCodexAppServerVersion } from '../model-context-windows.js';
import type { CodexJsonRpcClient } from './json-rpc-client.js';
import type { InitializeParams } from './protocol/methods.js';

/**
 * Who DorkOS says it is. `name` is what Codex records as the rollout's
 * `originator`, so threads DorkOS starts say `dorkos`.
 *
 * @param experimentalApi - Opt into the experimental surface (the turn pool
 *   does; the one-shot model query does not need it).
 */
export function codexInitializeParams(experimentalApi: boolean): InitializeParams {
  return {
    clientInfo: { name: 'dorkos', title: 'DorkOS', version: SERVER_VERSION },
    capabilities: experimentalApi ? { experimentalApi: true } : null,
  };
}

/**
 * Run the handshake and return the binary's version, or `null` when its
 * `userAgent` does not say.
 *
 * @param client - A fresh connection.
 * @param options - Whether to opt into the experimental API, and a deadline.
 */
export async function initializeCodexClient(
  client: CodexJsonRpcClient,
  options: { experimentalApi: boolean; timeoutMs?: number }
): Promise<string | null> {
  const result = await client.request(
    'initialize',
    codexInitializeParams(options.experimentalApi),
    {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    }
  );
  client.notify('initialized');
  return parseCodexAppServerVersion(result?.userAgent);
}

/**
 * The reachability-probe mechanics behind {@link AgentMcpServerService.test}:
 * building a short-lived MCP client transport for a stored server, bounding the
 * round trip, and classifying a 401 as "needs sign-in" (DOR-942).
 *
 * Split out of `agent-mcp-server-service.ts` to keep that file focused on manifest
 * CRUD + injection; these are pure transport/error helpers with no service state.
 *
 * @module services/mesh/agent-mcp-probe
 */
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';

/** Wall-clock cap on the connect + list-tools round trip in the reachability probe. */
export const TEST_PROBE_TIMEOUT_MS = 10_000;

/** HTTP status that means "you must sign in" — the signal the probe classifier keys on. */
const HTTP_UNAUTHORIZED = 401;

/**
 * Build a short-lived MCP client transport for a managed server's connection.
 *
 * @param connection - The stored transport (stdio/http/sse).
 * @param probeFetch - Optional `fetch` seam for the http/sse round trip (tests
 *   inject a 401-returning fetch); omitted uses the transport's global fetch.
 */
export function createProbeTransport(
  connection: McpServerTransport,
  probeFetch?: typeof fetch
): Transport {
  if (connection.transport === 'stdio') {
    return new StdioClientTransport({
      command: connection.command,
      args: connection.args,
      env: connection.env,
    });
  }
  if (connection.transport === 'http') {
    return new StreamableHTTPClientTransport(new URL(connection.url), {
      requestInit: { headers: connection.headers },
      ...(probeFetch ? { fetch: probeFetch } : {}),
    });
  }
  return new SSEClientTransport(new URL(connection.url), {
    requestInit: { headers: connection.headers },
    ...(probeFetch ? { fetch: probeFetch } : {}),
  });
}

/**
 * Classify a probe error as "needs sign-in": the MCP SDK throws
 * {@link UnauthorizedError} on a 401 when no auth provider is wired, and a
 * {@link StreamableHTTPError} carrying `code: 401` for a raw unauthorized HTTP
 * response. Anything else is an ordinary reachability failure.
 *
 * @param err - The error the probe threw.
 */
export function isUnauthorizedProbeError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  if (err instanceof StreamableHTTPError && err.code === HTTP_UNAUTHORIZED) return true;
  return false;
}

/**
 * Reject a promise if it does not settle within `ms`.
 *
 * @param promise - The work to bound.
 * @param ms - The wall-clock budget in milliseconds.
 */
export function withProbeTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`MCP server probe timed out after ${ms}ms`)), ms)
    ),
  ]);
}

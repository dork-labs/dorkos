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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
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

/**
 * How long `add` is willing to WAIT for its advisory sign-in probe before it
 * persists the entry anyway.
 *
 * Deliberately far below {@link TEST_PROBE_TIMEOUT_MS}: adding a server is a
 * foreground action a person is watching, and a server that is slow, wedged or
 * unroutable must not hold the button down for ten seconds. The probe keeps
 * running past this point — it just stops being something the add waits on, and
 * a late 401 heals the entry through `learnOAuthAuthKind` instead.
 */
export const ADD_PROBE_BUDGET_MS = 1_500;

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

/**
 * Resolve to `promise`'s value if it settles within `ms`, and to `fallback` if it
 * does not — WITHOUT cancelling the promise, which keeps running.
 *
 * The difference from {@link withProbeTimeout} is the whole point: that one turns
 * a slow server into a failure, this one turns it into "no answer yet". `add`
 * needs the second, because a probe that has not come back is not evidence of
 * anything and must not become one.
 *
 * @param promise - The work to wait on.
 * @param ms - How long to wait before giving up on an answer.
 * @param fallback - What to resolve to when the wait runs out.
 */
export function settledWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      // Unreferenced so a wait nobody is left listening for cannot hold the
      // process (or a test runner) open on its own.
      setTimeout(() => resolve(fallback), ms).unref();
    }),
  ]);
}

/**
 * What one bounded probe round trip found. Split three ways because the callers
 * treat a 401 differently from every other failure: it is not just "unreachable",
 * it is evidence the server is OAuth-protected.
 */
export type ProbeOutcome =
  | { kind: 'ok'; toolCount: number }
  | { kind: 'unauthorized'; error: string }
  | { kind: 'failed'; error: string };

/**
 * Connect to an MCP server once, list its tools, and close — the single probe
 * round trip shared by `AgentMcpServerService.test` (which reports it to the
 * operator) and by `add`'s advisory sign-in detection (which only wants to know
 * whether the server answers 401).
 *
 * Never throws: every outcome, timeout included, comes back as a
 * {@link ProbeOutcome}. The whole round trip is capped at `timeoutMs`.
 *
 * @param connection - The transport to dial, already carrying whatever headers a
 *   turn would send.
 * @param probeFetch - Optional `fetch` seam for the http/sse round trip (tests).
 * @param timeoutMs - Wall-clock cap; defaults to {@link TEST_PROBE_TIMEOUT_MS}.
 */
export async function runProbe(
  connection: McpServerTransport,
  probeFetch?: typeof fetch,
  timeoutMs: number = TEST_PROBE_TIMEOUT_MS
): Promise<ProbeOutcome> {
  const client = new Client({ name: 'dorkos-mcp-probe', version: '1.0.0' }, { capabilities: {} });
  const transport = createProbeTransport(connection, probeFetch);
  try {
    const tools = await withProbeTimeout(
      (async () => {
        await client.connect(transport);
        return client.listTools();
      })(),
      timeoutMs
    );
    return { kind: 'ok', toolCount: tools.tools.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return isUnauthorizedProbeError(err)
      ? { kind: 'unauthorized', error }
      : { kind: 'failed', error };
  } finally {
    await client.close().catch(() => {});
  }
}

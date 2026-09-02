/**
 * The Nango Proxy→MCP wrapper (DOR-415, connector-completion spec §Detailed
 * Design 4) — the DorkOS-hosted MCP endpoint that turns Nango's credentialed
 * HTTP proxy into a per-account tool server, so a self-host account can expose
 * tools to a session without ever touching Nango's Enterprise-gated MCP.
 *
 * One instance is created at boot and mounted at
 * `POST /api/connectors/nango/mcp/:accountId` (Streamable HTTP, stateless per
 * request — the same shape as the `/mcp` mount). `NangoConnectorProvider`
 * registers each active account here at `toolServerForAccount` time and hands
 * the session the returned {@link McpAppServerConnection}.
 *
 * Security posture:
 *
 * - **Per-account, process-scoped bearer tokens.** A token is minted in memory
 *   when an account is registered, rides the returned connection's
 *   `authorization` header, and is never persisted or logged. The endpoint 401s
 *   without a matching token, so a browser or any other caller cannot ride it.
 *   Tokens share the liveness of connect flows: a restart clears them, and the
 *   next attach mints fresh ones.
 * - **One honest generic tool.** Each request builds a fresh `McpServer`
 *   exposing a single `proxy_request` tool whose description names the service
 *   and label; responses are size-capped; the Nango secret key and stored
 *   credentials never appear in any response (they never leave the outbound
 *   request headers inside `nango-client.ts`).
 * - The Nango proxy endpoint shapes are `ASSUMPTION (live-unverified)`, like
 *   the rest of the Nango client (see `nango-client.ts` module docs).
 *
 * @module services/connectors/providers/nango-proxy-mcp
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpAppServerConnection } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import type { NangoHttpClient, NangoProxyMethod } from './nango-client.js';

/**
 * Upper bound on the upstream body text a `proxy_request` result carries. An
 * API that returns megabytes must not flood a model's context; the tail is
 * replaced with an honest truncation notice.
 */
const MAX_PROXY_RESPONSE_CHARS = 100_000;

/** The `proxy_request` input fields, as a Zod field map for `registerTool`. */
const PROXY_REQUEST_SHAPE = {
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).describe('Upstream HTTP method.'),
  path: z
    .string()
    .min(1)
    .describe("API path relative to the connected service's API base, e.g. 'gmail/v1/users/me'."),
  query: z.record(z.string(), z.string()).optional().describe('Query parameters.'),
  body: z.unknown().optional().describe('JSON request body.'),
  headers: z
    .record(z.string(), z.string())
    .optional()
    .describe('Extra upstream headers. Authentication is added by Nango; never send credentials.'),
};

/** What the wrapper needs to serve one registered account. */
interface RegisteredAccount {
  /** The process-scoped bearer token gating this account's endpoint. */
  token: string;
  /** Integration (provider config key) the connection belongs to, e.g. `'gmail'`. */
  integration: string;
  /** Raw Nango `connectionId` whose stored credentials authenticate proxy calls. */
  connectionId: string;
  /** User-facing label, named in the tool description ("gmail (work)"). */
  label: string;
  /** The Nango HTTP seam the proxy calls ride (injected; a fake in tests). */
  client: NangoHttpClient;
}

/** Construction options for {@link NangoProxyMcp}. */
export interface NangoProxyMcpOpts {
  /**
   * Origin of THIS DorkOS server as reachable from the runtime's MCP client,
   * e.g. `http://127.0.0.1:4242`. The per-account endpoint URL is built on it.
   */
  localOrigin: string;
}

/**
 * DorkOS-hosted Streamable-HTTP MCP wrapper over Nango's credentialed proxy:
 * mints per-account bearer-gated endpoints and serves one generic
 * `proxy_request` tool per account.
 */
export class NangoProxyMcp {
  private readonly _localOrigin: string;
  private readonly _accounts = new Map<string, RegisteredAccount>();

  /**
   * Construct the wrapper for this server's local origin.
   *
   * @param opts - The local origin; see {@link NangoProxyMcpOpts}.
   */
  constructor(opts: NangoProxyMcpOpts) {
    this._localOrigin = opts.localOrigin.replace(/\/+$/, '');
  }

  /**
   * Register (or refresh) an account and return the runtime-neutral connection
   * a session injects. Called by `NangoConnectorProvider.toolServerForAccount`
   * for ACTIVE accounts only — the provider owns the null branch.
   *
   * A re-registration keeps the account's existing token (a live session's
   * connection stays valid) while updating the binding and client.
   *
   * @param accountId - The opaque `nango:`-scoped account id (the endpoint path segment).
   * @param binding - Integration, raw connection id, and display label.
   * @param client - The Nango HTTP seam the proxy calls will ride.
   */
  connectionForAccount(
    accountId: string,
    binding: { integration: string; connectionId: string; label: string },
    client: NangoHttpClient
  ): McpAppServerConnection {
    const token = this._accounts.get(accountId)?.token ?? randomBytes(32).toString('hex');
    this._accounts.set(accountId, { token, ...binding, client });
    return {
      transport: 'http',
      url: `${this._localOrigin}/api/connectors/nango/mcp/${encodeURIComponent(accountId)}`,
      headers: { authorization: `Bearer ${token}` },
    };
  }

  /**
   * Forget every registered account: their tokens die, so every previously
   * handed-out connection 401s from the next request on. Called when the Nango
   * provider is unregistered (credential deleted / reload refused) — the
   * registered clients close over the old secret key and must not keep serving.
   * A re-registered provider re-registers accounts (with fresh tokens) at the
   * next `toolServerForAccount`.
   */
  clear(): void {
    this._accounts.clear();
  }

  /**
   * The Express router serving `POST /:accountId` (stateless MCP per request;
   * GET/DELETE 405 exactly like the main `/mcp` mount). Mount at
   * `/api/connectors/nango/mcp`.
   */
  createRouter(): Router {
    const router = Router();

    router.post('/:accountId', async (req, res) => {
      const account = this._authorize(req.params.accountId, req.headers.authorization);
      if (!account) {
        // No token, a wrong token, or an unregistered account: one
        // indistinguishable 401, so the endpoint cannot be probed for which
        // accounts exist.
        res.status(401).json({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        });
        return;
      }
      try {
        const server = buildProxyServer(account);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          transport.close().catch(() => {});
          server.close().catch(() => {});
        });
      } catch (err) {
        logger.error('[Connectors] Nango proxy MCP request failed', err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          });
        }
      }
    });

    const methodNotAllowed = (_req: unknown, res: import('express').Response): void => {
      res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed. This server is stateless.' },
        id: null,
      });
    };
    router.get('/:accountId', methodNotAllowed);
    router.delete('/:accountId', methodNotAllowed);

    return router;
  }

  /**
   * Resolve the account IFF the bearer token matches (timing-safe).
   *
   * The credential must START with a non-space (`\S.*` rather than `.+`).
   * `\s+` and `.` both match a space, so the old form had to try every way of
   * splitting a whitespace run between them (CodeQL js/polynomial-redos).
   * Demanding a non-space first makes every non-maximal split fail immediately.
   *
   * How reachable that actually was, stated honestly: the blow-up needs the run
   * to be followed by a character `.` cannot match, which in practice means a
   * CR or LF — and Node's HTTP parser will not put one inside a header value.
   * Measured on the raw pattern, `'Bearer' + 16k spaces + '\n'` costs ~230ms
   * while the same header WITHOUT a terminator costs 0.01ms. So this is a real
   * quadratic on a pre-auth parser rather than a live remote DoS, and it is
   * fixed because the next caller of this pattern may not have Node in front.
   *
   * The only value that now parses differently is an all-whitespace credential,
   * which used to capture a lone space. Tokens here are 32 random bytes in hex,
   * so such a value could never have matched one — the 401 is the same 401.
   */
  private _authorize(
    accountId: string,
    authorization: string | undefined
  ): RegisteredAccount | undefined {
    const account = this._accounts.get(accountId);
    if (!account) return undefined;
    const presented = authorization?.match(/^Bearer\s+(\S.*)$/i)?.[1];
    if (!presented) return undefined;
    const expected = Buffer.from(account.token);
    const actual = Buffer.from(presented);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
    return account;
  }
}

/**
 * Build the fresh per-request `McpServer` exposing this account's single
 * generic `proxy_request` tool.
 *
 * @param account - The authorized account binding.
 */
function buildProxyServer(account: RegisteredAccount): McpServer {
  const server = new McpServer({ name: 'nango-proxy', version: '1.0.0' });
  const service = `${account.integration} (${account.label})`;
  server.registerTool(
    'proxy_request',
    {
      description:
        `Send an authenticated HTTP request to ${service} through your self-hosted Nango. ` +
        'Authentication is injected from the tokens stored in your own Nango database; never ' +
        'send credentials yourself. The result carries the upstream HTTP status and body.',
      inputSchema: PROXY_REQUEST_SHAPE,
      annotations: { openWorldHint: true },
    },
    async (args: Record<string, unknown>) => {
      try {
        const response = await account.client.proxyRequest({
          method: args.method as NangoProxyMethod,
          path: args.path as string,
          integration: account.integration,
          connectionId: account.connectionId,
          ...(args.query !== undefined && { query: args.query as Record<string, string> }),
          ...(args.body !== undefined && { body: args.body }),
          ...(args.headers !== undefined && { headers: args.headers as Record<string, string> }),
        });
        const truncated = response.body.length > MAX_PROXY_RESPONSE_CHARS;
        const body = truncated
          ? `${response.body.slice(0, MAX_PROXY_RESPONSE_CHARS)}\n…[truncated: response exceeded ${MAX_PROXY_RESPONSE_CHARS} characters]`
          : response.body;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ status: response.status, body }) },
          ],
          // An upstream 4xx/5xx is surfaced as a tool error so the model treats
          // it as a failure, while still seeing the honest status + body.
          ...(response.status >= 400 ? { isError: true } : {}),
        };
      } catch (err) {
        // A transport failure (timeout, unreachable Nango). The message is
        // secret-free by construction (nango-client never embeds the key).
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                error: err instanceof Error ? err.message : 'Nango proxy request failed',
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );
  return server;
}

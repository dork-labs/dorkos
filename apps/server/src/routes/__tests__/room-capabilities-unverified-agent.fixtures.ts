/**
 * Shared setup for `room-capabilities-unverified-agent.test.ts`: the dead-token
 * states, the real routers those tests drive, and the readers for what comes
 * back through the MCP envelope. The suite's rationale is on the test file.
 *
 * @module server/routes/__tests__/room-capabilities-unverified-agent.fixtures
 */
import { expect, vi } from 'vitest';
import type { RequestListener, Server } from 'node:http';
import request, { type Response, type Test } from '@dorkos/test-utils/supertest';
import { agentIdentityTokens } from '@dorkos/db';
import type { CapabilityRegistry } from '../../services/core/capabilities/index.js';
import { createExternalMcpServer } from '../../services/core/mcp-server.js';
import type { McpToolDeps } from '../../services/runtimes/claude-code/mcp-tools/types.js';
import {
  initAgentIdentityService,
  TOKEN_ABSOLUTE_TTL_MS,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createMcpEndpoint } from '../mcp.js';
import {
  agentLookupFor,
  type RoomHarness,
} from '../../services/rooms/__tests__/room-test-harness.js';

/** A token shaped like the real thing that resolves to NO agent at all. */
export const UNVERIFIABLE = 'dork_agent_this-token-resolves-to-nothing';

/** The three states a presented token can be dead in. Each must be refused. */
export type DeadTokenState = 'fabricated' | 'revoked' | 'expired';

/** Every dead state, so a row that only covers one cannot pass for coverage. */
export const DEAD_TOKEN_STATES: DeadTokenState[] = ['fabricated', 'revoked', 'expired'];

/** The code every room seam now answers a token it cannot verify with. */
export const REFUSAL_CODE = 'AGENT_IDENTITY_UNVERIFIED';

/** The problem code the HTTP doors answer that refusal with. */
export const PROBLEM_CODE = 'agent_identity_unverified';

/** Ana's working directory, which is her identity. */
export const ANA_PATH = '/agents/ana';

/** The one agent on the roster: Ana, who answers everything. */
export const agents = agentLookupFor({
  [ANA_PATH]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** Minimal deps for the external MCP server — the shape `mcp-integration` uses. */
function minimalMcpDeps(): McpToolDeps {
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
    dorkHome: '/tmp/dorkos-test-home',
  };
}

/** JSON-RPC `tools/call`, in the shape the stateless transport accepts. */
export function toolCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'tools/call', params: { name, arguments: args }, id: 1 };
}

/** Read one JSON-RPC message back, whichever way the transport chose to send it. */
export function jsonRpc(res: Response): {
  result?: { isError?: boolean; content?: Array<{ text?: string }> };
} {
  const contentType = (res.headers['content-type'] as string) ?? '';
  if (contentType.includes('text/event-stream')) {
    const line = res.text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(line!.slice(6));
  }
  return res.body;
}

/** The payload a capability refusal carries back through the MCP envelope. */
export function mcpErrorPayload(res: Response): { code?: string; error?: string } {
  const body = jsonRpc(res);
  expect(body.result?.isError).toBe(true);
  return JSON.parse(body.result!.content![0]!.text!);
}

/**
 * Whether a JSON-RPC reply is a refusal, in EITHER shape a refusal can take.
 *
 * Two gates can turn one of these calls away and they answer differently on
 * purpose: `callerAuthor` throws the rooms domain's typed error (`isError`),
 * while the tier gate returns a structured `denied` payload that is deliberately
 * NOT `isError` so a model reads it rather than retrying. Which one answers
 * depends on the caller and the tier — a revoked token is capped at `observe`,
 * so an `act` verb is stopped by the ceiling before `callerAuthor` ever runs.
 * The property under test is that the call did not happen, so the assertion is
 * on that, not on which door closed first (DOR-486).
 *
 * @param res - The transport response.
 * @returns The refusal text, for the caller to make its own claims about.
 */
export function refusalText(res: Response): string {
  const body = jsonRpc(res);
  const text = body.result?.content?.[0]?.text ?? '';
  // Parsed, not substring-matched: the denial payload is pretty-printed, so
  // `"status":"denied"` never appears literally in it.
  let status: unknown;
  try {
    status = (JSON.parse(text) as { status?: unknown }).status;
  } catch {
    status = undefined;
  }
  const refused = body.result?.isError === true || status === 'denied';
  expect(refused, `expected a refusal, got: ${text.slice(0, 200)}`).toBe(true);
  return text;
}

/**
 * A token that really does resolve to Ana.
 *
 * @param harness - The room harness whose database holds the token.
 */
export function anaTokenIn(harness: RoomHarness): Promise<string> {
  return initAgentIdentityService(harness.db).mint({
    agentPath: ANA_PATH,
    displayName: 'Ana',
  });
}

/**
 * A token in one of the three dead states, built the way it really happens.
 *
 * `revoked` and `expired` are REAL — minted for Ana and then killed — because
 * the fabricated string is the one dead state that never had an identity to
 * resolve to, and it is precisely the state that kept passing while the other
 * two walked through (DOR-486).
 *
 * @param harness - The room harness whose database holds the token.
 * @param state - Which dead state to produce.
 * @returns The token to present.
 */
export async function deadTokenIn(harness: RoomHarness, state: DeadTokenState): Promise<string> {
  if (state === 'fabricated') return UNVERIFIABLE;
  const token = await anaTokenIn(harness);
  if (state === 'revoked') {
    await initAgentIdentityService(harness.db).revoke(ANA_PATH);
    return token;
  }
  // Past the absolute cap, which no amount of use resets.
  const longAgo = new Date(Date.now() - TOKEN_ABSOLUTE_TTL_MS - 60_000).toISOString();
  harness.db.update(agentIdentityTokens).set({ createdAt: longAgo, lastUsedAt: longAgo }).run();
  return token;
}

/**
 * The invoke route behind the `/api` chain, which resolves the agent identity.
 *
 * @param registry - The registry the route invokes.
 */
export function invokeApp(registry: CapabilityRegistry): RequestListener {
  return honoGroupListener({
    path: '/api/capabilities',
    routes: createCapabilitiesInvokeRoutes(registry),
  });
}

/**
 * The real MCP endpoint over the real external server, behind the chain
 * that resolves the agent header, as `index.ts` wires it.
 *
 * @param registry - The registry the external server exposes.
 */
export function mcpApp(registry: CapabilityRegistry): RequestListener {
  return honoGroupListener({
    path: '/mcp',
    routes: createMcpEndpoint((caller) =>
      createExternalMcpServer(
        minimalMcpDeps(),
        undefined,
        registry,
        caller.identity,
        caller.userId,
        caller.agentIdentityPresented
      )
    ),
  });
}

/**
 * Post one JSON-RPC message with the headers the transport insists on.
 *
 * `token` is set before the body so the identity is complete before awaiting
 * the chain; awaiting, `.then()`, or `.end()` dispatches it.
 *
 * @param server - The server with {@link mcpApp} mounted.
 * @param body - The JSON-RPC message.
 * @param token - The agent token to present, if any.
 */
export function mcpRpc(server: Server, body: Record<string, unknown>, token?: string): Test {
  const req = request(server)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream');
  if (token) req.set('X-DorkOS-Agent', token);
  return req.send(body);
}

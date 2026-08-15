/**
 * Drift-guard for the read-only carve-out SSOT (DOR-278).
 *
 * READ_ONLY_MCP_TOOL_NAMES must stay in exact lock-step with the tools the live
 * server advertises as `readOnlyHint: true`. This test stands up the real
 * `createExternalMcpServer` (with marketplace + connector deps so all 31
 * read-only tools register), issues a `tools/list`, and asserts the constant
 * equals the live set in BOTH directions — so the carve-out can never silently
 * drift from the annotations it mirrors.
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Mock env for the server factory and core-tools handlers.
vi.mock('../../../../env.js', () => ({
  env: {
    DORKOS_PORT: 4242,
    MCP_API_KEY: undefined,
  },
}));

vi.mock('../../../../lib/version.js', () => ({
  SERVER_VERSION: 'test',
  IS_DEV_BUILD: false,
}));

// Suppress log output during the test.
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Manifest reader used by the get_agent handler.
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

import { createExternalMcpServer } from '../../mcp-server.js';
import { GUARDED_READ_ONLY_TOOL_NAMES, READ_ONLY_MCP_TOOL_NAMES } from '../tool-security.js';
import { readOnlyCarveOutToolNames } from '../../capabilities/index.js';
import { operatorDomain } from '../../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../../marketplace-mcp/marketplace-capabilities.js';
import { connectorDomain } from '../../../connectors/connector-capabilities.js';
import type { ConnectorCapabilityDeps } from '../../../connectors/connector-capabilities.js';
import { mcpDomain } from '../../../mesh/mcp-capabilities.js';
import type { McpCapabilityDeps } from '../../../mesh/mcp-capability-deps.js';
import { roomsDomain } from '../../../rooms/room-capabilities.js';
import { capabilitiesDomain } from '../../self-description/capabilities-domain.js';
import { composeDorkOsCapabilityRegistry } from '../../self-description/dorkos-registry.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { MarketplaceMcpDeps } from '../../../marketplace-mcp/marketplace-mcp-tools.js';

/** Minimal McpToolDeps — only the fields registration touches are set. */
function createMinimalDeps(): McpToolDeps {
  return {
    transcriptReader: {
      listSessions: vi.fn().mockResolvedValue([]),
    } as unknown as McpToolDeps['transcriptReader'],
    defaultCwd: '/tmp/test',
  };
}

/**
 * Minimal MarketplaceMcpDeps. Registration only calls the `create*Handler(deps)`
 * factories (which return closures without dereferencing deps), so a stub bundle
 * is enough to register all five marketplace read-only tools — without these the
 * live count is 23, not 28. See `createExternalMcpServer`, which only joins the
 * marketplace capabilities to the registry when `marketplaceDeps` is present.
 */
function createMarketplaceDeps(): MarketplaceMcpDeps {
  return {
    dorkHome: '/tmp/test',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as MarketplaceMcpDeps;
}

/** Stateless test app: a fresh server + transport per POST (the SDK pattern). */
function createStatelessTestApp() {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    try {
      // Compose the registry with all three domain bundles (stubs are enough:
      // tools/list registers, never invokes), exactly as boot does — without
      // `connectorDeps` the live server would omit the connector tools while
      // the constant lists them.
      const deps = createMinimalDeps();
      const marketplaceDeps = createMarketplaceDeps();
      const registry = composeDorkOsCapabilityRegistry({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
        operatorDeps: deps,
        marketplaceDeps,
        connectorDeps: {} as ConnectorCapabilityDeps,
        mcpDeps: {} as McpCapabilityDeps,
        // Composed in so the rooms tools are LIVE on the server this test reads
        // `tools/list` from. They contribute nothing to the carve-out, which is
        // exactly the claim worth guarding: without the domain here, a later
        // `readOnlyCarveOut: true` on a room read would widen the tokenless
        // surface and every assertion below would still pass.
        roomDeps: {} as never,
      });
      const server = createExternalMcpServer(deps, marketplaceDeps, registry);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (_err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        });
      }
    }
  });

  return app;
}

/** A tool entry as returned by tools/list, with its annotations. */
interface ToolListEntry {
  name: string;
  annotations?: { readOnlyHint?: boolean };
}

/** Fetch every tool from the live server's tools/list, with annotations. */
async function fetchLiveTools(): Promise<ToolListEntry[]> {
  const app = createStatelessTestApp();
  const res = await request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });

  expect(res.status).toBe(200);
  const body = parseResponse(res);
  return (body.result?.tools ?? []) as ToolListEntry[];
}

describe('READ_ONLY_MCP_TOOL_NAMES drift guard', () => {
  it('has exactly 32 members (the audited read-only set)', () => {
    // A hard count anchors the constant against silent additions/removals.
    // 18 legacy (`LEGACY_READ_ONLY_TOOL_NAMES`) + 14 registry-derived carve-outs:
    // 4 operator, 5 marketplace, 3 connector, `mcp_list_server` from the
    // MCP-server-management domain, plus `list_capabilities` from the
    // self-description domain. A carve-out only counts when its tool reaches the
    // `external` server, which is what `readOnlyCarveOutToolNames` checks.
    expect(READ_ONLY_MCP_TOOL_NAMES.size).toBe(32);
  });

  it('every live tool with readOnlyHint === true is accounted for', async () => {
    // Direction A: a live read-only tool is either tokenless or DELIBERATELY
    // guarded — never merely absent. That is what keeps the two sets from
    // leaving a tool between them, now that read-only no longer implies
    // tokenless (the rooms history tools return other people's messages).
    const tools = await fetchLiveTools();
    const liveReadOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name);
    expect(liveReadOnly.length).toBeGreaterThan(0);
    for (const name of liveReadOnly) {
      expect(
        READ_ONLY_MCP_TOOL_NAMES.has(name) || GUARDED_READ_ONLY_TOOL_NAMES.has(name),
        `${name} is read-only but neither in the carve-out nor deliberately guarded`
      ).toBe(true);
    }
  });

  it('names a deliberately guarded tool only when that tool is live and read-only', async () => {
    // The exclusion list is not a place to park a name. Every entry has to be a
    // real read-only tool on this server, or it is documenting a decision about
    // something that does not exist.
    const tools = await fetchLiveTools();
    const liveReadOnly = new Set(
      tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name)
    );
    for (const name of GUARDED_READ_ONLY_TOOL_NAMES) {
      expect(liveReadOnly.has(name), `${name} is not a live read-only tool`).toBe(true);
    }
    // And the two sets are disjoint — a tool cannot be both tokenless and held back.
    for (const name of GUARDED_READ_ONLY_TOOL_NAMES) {
      expect(READ_ONLY_MCP_TOOL_NAMES.has(name), `${name} is in both sets`).toBe(false);
    }
  });

  it('keeps the rooms history tools out of the tokenless surface', async () => {
    // Named rather than left to the general rule, because this is the security
    // decision the general rule exists to protect: an unauthenticated local
    // caller may run a health check, and may not read somebody's conversations.
    const tools = await fetchLiveTools();
    const roomReads = tools
      .filter((t) => t.name === 'read_room_history' || t.name === 'search_room_history')
      .map((t) => t.name)
      .sort();

    expect(roomReads, 'both tools are live on the external server').toEqual([
      'read_room_history',
      'search_room_history',
    ]);
    for (const name of roomReads) {
      expect(READ_ONLY_MCP_TOOL_NAMES.has(name)).toBe(false);
    }
  });

  it('every name in the constant is a live tool with readOnlyHint === true', async () => {
    // Direction B: the carve-out may not name a tool that is not live read-only.
    const tools = await fetchLiveTools();
    const liveReadOnly = new Set(
      tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name)
    );
    for (const name of READ_ONLY_MCP_TOOL_NAMES) {
      expect(liveReadOnly.has(name)).toBe(true);
    }
  });

  it('the two sets together equal the live read-only set exactly', async () => {
    // The single equality that catches any drift the directions above might
    // individually pass — same membership, same size, across both sets. It is a
    // union rather than the carve-out alone because a read-only tool may be
    // deliberately guarded; what may never happen is a read-only tool belonging
    // to neither, or either set naming something that is not live.
    const tools = await fetchLiveTools();
    const liveReadOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    const accounted = [...READ_ONLY_MCP_TOOL_NAMES, ...GUARDED_READ_ONLY_TOOL_NAMES].sort();
    expect(liveReadOnly).toEqual(accounted);
  });

  it("the migrated tools' carve-out is a registry derivation, not a hand list", async () => {
    // The operator + marketplace carve-out is DERIVED from each capability's
    // `readOnlyCarveOut` flag — there is no second place to keep in sync. Assert
    // the derivation equals exactly the live read-only tools among the migrated
    // set (so a flag flip on either side is caught).
    const migratedCapabilities = [
      ...operatorDomain.capabilities,
      ...marketplaceDomain.capabilities,
      ...connectorDomain.capabilities,
      ...mcpDomain.capabilities,
      ...roomsDomain.capabilities,
      ...capabilitiesDomain.capabilities,
    ];
    const derived = readOnlyCarveOutToolNames(migratedCapabilities);
    const migratedToolNames = new Set(
      migratedCapabilities
        .map((c) => c.surfaces.mcp?.toolName)
        .filter((n): n is string => n !== undefined)
    );

    const tools = await fetchLiveTools();
    const liveMigratedReadOnly = tools
      .filter(
        (t) =>
          t.annotations?.readOnlyHint === true &&
          migratedToolNames.has(t.name) &&
          // A read-only tool a domain deliberately kept out of the carve-out is
          // not a derivation failure — it is the derivation working. The set of
          // such tools is itself pinned, two tests above.
          !GUARDED_READ_ONLY_TOOL_NAMES.has(t.name)
      )
      .map((t) => t.name)
      .sort();

    expect([...derived].sort()).toEqual(liveMigratedReadOnly);
    // And every derived name is admitted to the exported carve-out constant.
    for (const name of derived) {
      expect(READ_ONLY_MCP_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

// ── Response parsing (JSON or SSE) ───────────────────────────────────────────

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: { tools?: ToolListEntry[]; [key: string]: unknown };
  error?: { code: number; message: string };
}

function parseResponse(res: request.Response): JsonRpcMessage {
  const contentType = (res.headers['content-type'] as string) ?? '';
  if (contentType.includes('application/json')) {
    return res.body as JsonRpcMessage;
  }
  if (contentType.includes('text/event-stream')) {
    const messages = parseSseMessages(res.text);
    return messages[0];
  }
  return res.body as JsonRpcMessage;
}

function parseSseMessages(text: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        messages.push(JSON.parse(line.slice(6)) as JsonRpcMessage);
      } catch {
        // Skip non-JSON data lines (e.g. SSE comments).
      }
    }
  }
  return messages;
}

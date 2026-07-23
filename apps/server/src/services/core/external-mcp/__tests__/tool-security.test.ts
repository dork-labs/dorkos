/**
 * Drift-guard for the read-only carve-out SSOT (DOR-278).
 *
 * READ_ONLY_MCP_TOOL_NAMES must stay in exact lock-step with the tools the live
 * server advertises as `readOnlyHint: true`. This test stands up the real
 * `createExternalMcpServer` (with marketplace deps so all 27 read-only tools
 * register), issues a `tools/list`, and asserts the constant equals the live set
 * in BOTH directions — so the carve-out can never silently drift from the
 * annotations it mirrors.
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
import { READ_ONLY_MCP_TOOL_NAMES } from '../tool-security.js';
import { readOnlyCarveOutToolNames } from '../../capabilities/index.js';
import { operatorDomain } from '../../operator/operator-capabilities.js';
import { marketplaceDomain } from '../../../marketplace-mcp/marketplace-capabilities.js';
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
 * live count is 18, not 23 (see mcp-server.ts:88).
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
      const server = createExternalMcpServer(createMinimalDeps(), createMarketplaceDeps());
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
  it('has exactly 27 members (the audited read-only set)', () => {
    // A hard count anchors the constant against silent additions/removals.
    expect(READ_ONLY_MCP_TOOL_NAMES.size).toBe(27);
  });

  it('every live tool with readOnlyHint === true is in the constant', async () => {
    // Direction A: no live read-only tool may be missing from the carve-out.
    const tools = await fetchLiveTools();
    const liveReadOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name);
    expect(liveReadOnly.length).toBeGreaterThan(0);
    for (const name of liveReadOnly) {
      expect(READ_ONLY_MCP_TOOL_NAMES.has(name)).toBe(true);
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

  it('the constant equals the live read-only set exactly (both directions, sorted)', async () => {
    // The single equality that catches any drift the two directions above might
    // individually pass — same membership, same size.
    const tools = await fetchLiveTools();
    const liveReadOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true)
      .map((t) => t.name)
      .sort();
    const constant = [...READ_ONLY_MCP_TOOL_NAMES].sort();
    expect(liveReadOnly).toEqual(constant);
  });

  it("the migrated tools' carve-out is a registry derivation, not a hand list", async () => {
    // The operator + marketplace carve-out is DERIVED from each capability's
    // `readOnlyCarveOut` flag — there is no second place to keep in sync. Assert
    // the derivation equals exactly the live read-only tools among the migrated
    // set (so a flag flip on either side is caught).
    const derived = readOnlyCarveOutToolNames([
      ...operatorDomain.capabilities,
      ...marketplaceDomain.capabilities,
    ]);
    const migratedToolNames = new Set(
      [...operatorDomain.capabilities, ...marketplaceDomain.capabilities]
        .map((c) => c.surfaces.mcp?.toolName)
        .filter((n): n is string => n !== undefined)
    );

    const tools = await fetchLiveTools();
    const liveMigratedReadOnly = tools
      .filter((t) => t.annotations?.readOnlyHint === true && migratedToolNames.has(t.name))
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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock env before importing the middleware.
vi.mock('../../env.js', () => ({
  env: {
    MCP_API_KEY: undefined as string | undefined,
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn(),
  },
}));

// The shared credential verifier (session cookie → per-user Better Auth API key).
// Mocked here so these unit tests can drive the per-user path without a live auth
// instance; the real end-to-end path is covered in mcp-auth.integration.test.ts.
vi.mock('../../services/core/auth/index.js', () => ({
  verifyRequestAuth: vi.fn(),
}));

// The per-instance local token (DOR-278). Mocked to a known value/path so the
// local-token acceptor and the helpful 401 body can be driven deterministically.
vi.mock('../../services/core/auth/mcp-local-token.js', () => ({
  getMcpLocalToken: vi.fn(),
  getMcpLocalTokenPath: vi.fn(),
}));

import { createMcpAuth } from '../mcp-auth.js';
import { env } from '../../env.js';
import { configManager } from '../../services/core/config-manager.js';
import { verifyRequestAuth } from '../../services/core/auth/index.js';
import {
  getMcpLocalToken,
  getMcpLocalTokenPath,
} from '../../services/core/auth/mcp-local-token.js';

/** A valid local token (dork_mcp_local_ + 64 hex) the acceptor should accept. */
const LOCAL_TOKEN = `dork_mcp_local_${'a'.repeat(64)}`;
/** The resolved token file path the 401 body must name (never the value). */
const TOKEN_PATH = '/tmp/dork/mcp-local-token';

const mcpAuth = createMcpAuth({ surface: 'mcp' });
const a2aAuth = createMcpAuth({ surface: 'a2a' });

function createMockReq(
  opts: { authHeader?: string; body?: unknown; method?: string } = {}
): Partial<Request> {
  return {
    headers: opts.authHeader ? { authorization: opts.authHeader } : {},
    body: opts.body,
    method: opts.method ?? 'POST',
  };
}

function createMockRes(): Partial<Response> & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn().mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response['status'];
  res.json = vi.fn().mockImplementation((data: unknown) => {
    res.body = data;
    return res;
  }) as unknown as Response['json'];
  return res;
}

/** Mock configManager.get keyed by the two keys the middleware reads. */
function mockConfig(opts: { mcpApiKey?: string | null; authEnabled?: boolean }): void {
  vi.mocked(configManager.get).mockImplementation((key: string) => {
    if (key === 'mcp') return { apiKey: opts.mcpApiKey ?? null } as never;
    if (key === 'auth') return { enabled: opts.authEnabled ?? false } as never;
    return undefined as never;
  });
}

/** A JSON-RPC message body for a given method (+ optional tools/call tool name). */
function rpc(method: string, toolName?: string): Record<string, unknown> {
  const msg: Record<string, unknown> = { jsonrpc: '2.0', method, id: 1 };
  if (method === 'tools/call' && toolName) msg.params = { name: toolName };
  return msg;
}

beforeEach(() => {
  (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = undefined;
  vi.mocked(configManager.get).mockReturnValue(undefined);
  // No identity by default — the per-user path is opt-in per test.
  vi.mocked(verifyRequestAuth).mockResolvedValue(null);
  // Login-off default: the local token exists and its path is known.
  vi.mocked(getMcpLocalToken).mockReturnValue(LOCAL_TOKEN);
  vi.mocked(getMcpLocalTokenPath).mockReturnValue(TOKEN_PATH);
});

describe('createMcpAuth — surface "mcp", login off', () => {
  const DISCOVERY = [
    'initialize',
    'ping',
    'tools/list',
    'resources/list',
    'resources/templates/list',
    'prompts/list',
    'notifications/initialized',
  ];

  it.each(DISCOVERY)('allows the discovery/handshake method %s tokenless', async (method) => {
    // Discovery + handshake stay tokenless so curl demos work with no config.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(createMockReq({ body: rpc(method) }) as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows a read-only tools/call (ping) tokenless', async () => {
    // A read-only tool in the carve-out needs no token.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'ping') }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('allows a read-only tools/call (marketplace_search) tokenless', async () => {
    // The marketplace read-only tools register only with marketplace deps but
    // are equally part of the carve-out.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'marketplace_search') }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('401s a mutating tools/call (create_extension) tokenless', async () => {
    // The RCE-adjacent extension tools must be gated.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'create_extension') }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('allows a mutating tools/call (create_extension) WITH the local token', async () => {
    // The local token unlocks the guarded tools.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: `Bearer ${LOCAL_TOKEN}`,
        body: rpc('tools/call', 'create_extension'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('401s a mutating tools/call (relay_send) tokenless', async () => {
    // The human-impersonating relay family must be gated.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'relay_send') }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s an unknown tools/call tokenless (fail-closed on unknown tools)', async () => {
    // A tool not in the read-only set defaults to guarded.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'some_new_tool') }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s resources/read tokenless (data reads are gated)', async () => {
    // Session/agent/skill data is fail-closed even though resources/list is open.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(createMockReq({ body: rpc('resources/read') }) as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s an unknown method tokenless (fail-closed)', async () => {
    // Any unrecognized method is guarded.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('completion/complete') }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s a mixed batch (read-only + mutating)', async () => {
    // A batch passes only if EVERY element passes; one guarded element sinks it.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        body: [rpc('tools/call', 'ping'), rpc('tools/call', 'create_extension')],
      }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('allows an all-read-only batch tokenless', async () => {
    // Every element is in the carve-out, so the whole batch passes.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        body: [rpc('tools/list'), rpc('tools/call', 'ping'), rpc('tools/call', 'get_server_info')],
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('401s an empty/undefined body (unparseable)', async () => {
    // A missing parsed body fails closed.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(createMockReq({ body: undefined }) as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s a non-object body (unparseable garbage)', async () => {
    // A stray string body is not a JSON-RPC message → fail closed.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(createMockReq({ body: 'not json' }) as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s an empty batch (fail-closed)', async () => {
    // An empty array is not a set of allowed messages.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(createMockReq({ body: [] }) as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('createMcpAuth — surface "mcp", login off, each acceptor authorizes a mutating call', () => {
  it('accepts the env MCP_API_KEY on a mutating call', async () => {
    // Acceptor 1: static env override.
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-key';
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: 'Bearer env-key',
        body: rpc('tools/call', 'create_extension'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('accepts a per-user identity on a mutating call', async () => {
    // Acceptor 2: shared verifier resolves an identity.
    mockConfig({ authEnabled: false });
    vi.mocked(verifyRequestAuth).mockResolvedValue({ userId: 'owner-1' });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'relay_send') }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('accepts the legacy config mcp.apiKey on a mutating call', async () => {
    // Acceptor 3: not-yet-seeded legacy compat key.
    mockConfig({ mcpApiKey: 'dork_mcp_legacy', authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: 'Bearer dork_mcp_legacy',
        body: rpc('tools/call', 'create_extension'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('accepts the local token on a mutating call', async () => {
    // Acceptor 4: the per-instance local token (the passthrough replacement).
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: `Bearer ${LOCAL_TOKEN}`,
        body: rpc('tools/call', 'relay_send'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('rejects a same-length wrong token (constant-time compare stays closed)', async () => {
    // A wrong token of the same length must not slip through.
    mockConfig({ authEnabled: false });
    const wrong = `dork_mcp_local_${'b'.repeat(64)}`;
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: `Bearer ${wrong}`,
        body: rpc('tools/call', 'create_extension'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

describe('createMcpAuth — helpful 401 body', () => {
  it('names the token file path and the Authorization: Bearer header, never the token value', async () => {
    // The 401 must be a dead-end that helps, without leaking the secret.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'create_extension') }) as Request,
      res as Response,
      next
    );
    expect(res.statusCode).toBe(401);
    const body = res.body as {
      jsonrpc: string;
      error: { code: number; message: string };
      id: null;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32001);
    expect(body.id).toBeNull();
    expect(body.error.message).toContain(TOKEN_PATH);
    expect(body.error.message).toContain('Authorization: Bearer');
    expect(body.error.message).not.toContain(LOCAL_TOKEN);
  });
});

describe('createMcpAuth — surface "a2a", login off', () => {
  it('allows an agent-card GET tokenless', async () => {
    // Card discovery is rate-limited public metadata, the tools/list analogue.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await a2aAuth(createMockReq({ method: 'GET' }) as Request, res as Response, next);
    expect(next).toHaveBeenCalled();
  });

  it('401s a JSON-RPC POST tokenless (execution is always gated)', async () => {
    // A2A execution has no read/write annotation to carve on, so it is gated.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await a2aAuth(
      createMockReq({ method: 'POST', body: rpc('message/send') }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('allows a JSON-RPC POST WITH the local token', async () => {
    // The same local token gates A2A execution too.
    mockConfig({ authEnabled: false });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await a2aAuth(
      createMockReq({
        method: 'POST',
        authHeader: `Bearer ${LOCAL_TOKEN}`,
        body: rpc('message/send'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });
});

describe('createMcpAuth — login ON (both surfaces)', () => {
  beforeEach(() => {
    // Login on: the local token is inactive (not resolved), so no path either.
    vi.mocked(getMcpLocalToken).mockReturnValue(null);
    vi.mocked(getMcpLocalTokenPath).mockReturnValue(null);
    mockConfig({ authEnabled: true });
  });

  it('401s an unauthenticated mcp request (no tokenless path)', async () => {
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ body: rpc('tools/call', 'ping') }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('401s an unauthenticated a2a GET (card discovery closed when login is on)', async () => {
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await a2aAuth(createMockReq({ method: 'GET' }) as Request, res as Response, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('does NOT accept the local token when login is on', async () => {
    // Even a valid-looking local token must be rejected in login-on mode.
    vi.mocked(getMcpLocalToken).mockReturnValue(LOCAL_TOKEN); // as if it existed
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: `Bearer ${LOCAL_TOKEN}`,
        body: rpc('tools/call', 'create_extension'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('accepts the env key when login is on', async () => {
    (env as { MCP_API_KEY: string | undefined }).MCP_API_KEY = 'env-key';
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ authHeader: 'Bearer env-key', body: rpc('tools/call', 'ping') }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('accepts a per-user identity when login is on', async () => {
    vi.mocked(verifyRequestAuth).mockResolvedValue({ userId: 'owner-1' });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({ authHeader: 'Bearer user-key', body: rpc('tools/call', 'ping') }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('accepts the legacy key when login is on', async () => {
    mockConfig({ mcpApiKey: 'dork_mcp_legacy', authEnabled: true });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await mcpAuth(
      createMockReq({
        authHeader: 'Bearer dork_mcp_legacy',
        body: rpc('tools/call', 'create_extension'),
      }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });

  it('accepts a per-user identity on an a2a POST when login is on', async () => {
    vi.mocked(verifyRequestAuth).mockResolvedValue({ userId: 'owner-1' });
    const next = vi.fn() as NextFunction;
    const res = createMockRes();
    await a2aAuth(
      createMockReq({ method: 'POST', body: rpc('message/send') }) as Request,
      res as Response,
      next
    );
    expect(next).toHaveBeenCalled();
  });
});

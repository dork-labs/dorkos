/**
 * The `tasks_*` operator-only field guard on the EXTERNAL `/mcp` server
 * (DOR-504).
 *
 * There are two MCP servers and one set of handlers, and "it is the same
 * function" is exactly the kind of claim that is true right up until somebody
 * registers a different handler on one of them. So this drives the real
 * `createExternalMcpServer` over HTTP with a real `tools/call`, against a real
 * `TaskStore`, and checks the store afterwards. Its in-session twin is
 * `runtimes/claude-code/mcp-tools/__tests__/task-tools.test.ts`.
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';

vi.mock('../../../../env.js', () => ({
  env: { DORKOS_PORT: 4242, MCP_API_KEY: undefined },
}));

vi.mock('../../../../lib/version.js', () => ({
  SERVER_VERSION: 'test',
  IS_DEV_BUILD: false,
}));

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));

import { createExternalMcpServer } from '../../mcp-server.js';
import { TaskStore } from '../../../tasks/task-store.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { Task } from '@dorkos/shared/schemas';

/** A JSON-RPC reply, narrowed to the parts this test reads. */
interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: {
    tools?: {
      name: string;
      inputSchema?: {
        properties?: Record<string, { description?: string }>;
        /** JSON Schema's own list of the arguments a caller must send. */
        required?: string[];
      };
    }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
    [key: string]: unknown;
  };
  error?: { code: number; message: string };
}

/** Read a JSON or SSE reply, the way the sibling external-MCP test does. */
function parseResponse(res: request.Response): JsonRpcMessage {
  const contentType = (res.headers['content-type'] as string) ?? '';
  if (contentType.includes('text/event-stream')) {
    for (const line of res.text.split('\n')) {
      if (line.startsWith('data: ')) return JSON.parse(line.slice(6)) as JsonRpcMessage;
    }
  }
  return res.body as JsonRpcMessage;
}

describe('tasks_* operator-only field guard (external /mcp server)', () => {
  let db: Db;
  let store: TaskStore;
  let app: express.Express;
  let existing: Task;

  beforeEach(() => {
    db = createTestDb();
    store = new TaskStore(db);
    existing = store.createTask({
      name: 'nightly',
      description: 'nightly',
      prompt: 'the prompt the person approved',
      cron: '0 2 * * *',
      filePath: '/tmp/tasks/nightly/SKILL.md',
    });

    const deps = {
      transcriptReader: { listSessions: vi.fn().mockResolvedValue([]) },
      defaultCwd: '/tmp/test',
      // Never written to here: every create in this suite is refused before the
      // file step. Present because `McpToolDeps` requires it (DOR-1568).
      dorkHome: '/tmp/dorkos-external-mcp-test',
      taskStore: store,
    } as unknown as McpToolDeps;

    // Stateless: a fresh server + transport per POST, the SDK's own pattern and
    // the shape `index.ts` mounts in production.
    app = express();
    app.use(express.json());
    app.post('/mcp', async (req, res) => {
      const server = createExternalMcpServer(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    });
  });

  afterEach(() => {
    store.close();
  });

  /** Issue one JSON-RPC call against the live external server. */
  async function rpc(method: string, params?: Record<string, unknown>) {
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', method, id: 1, ...(params && { params }) });
    expect(res.status).toBe(200);
    return parseResponse(res);
  }

  /** Call a tool and parse its single JSON content block. */
  async function callTool(name: string, args: Record<string, unknown>) {
    const body = await rpc('tools/call', { name, arguments: args });
    const text = body.result?.content?.[0]?.text ?? '{}';
    return {
      isError: body.result?.isError === true,
      payload: JSON.parse(text) as Record<string, unknown>,
    };
  }

  it('advertises permissionMode as a field it refuses, on both tools', async () => {
    const body = await rpc('tools/list');
    for (const name of ['tasks_create', 'tasks_update']) {
      const tool = body.result?.tools?.find((t) => t.name === name);
      expect(tool, `${name} must be registered on the external server`).toBeDefined();
      const described = tool!.inputSchema?.properties?.permissionMode?.description ?? '';
      expect(described, `${name} must still advertise permissionMode`).toContain('Not yours');
    }
  });

  it('will not create a schedule with no reason, and the schema says so (DOR-1394)', async () => {
    const body = await rpc('tools/list');
    const tool = body.result?.tools?.find((t) => t.name === 'tasks_create');
    // Required in the advertised schema, which is what the SDK enforces before
    // the handler is ever reached.
    expect(tool?.inputSchema?.required).toContain('reason');

    const before = store.getTasks().length;
    const res = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 1,
        params: {
          name: 'tasks_create',
          arguments: { name: 'reasonless', prompt: 'do a thing', cron: '0 3 * * *' },
        },
      });

    // Refused by the SDK's own schema parse, before the handler is reached — so
    // the reply is an error naming the missing argument, and nothing was
    // written, which is the part that counts.
    const parsed = parseResponse(res);
    expect(parsed.result?.isError).toBe(true);
    expect(parsed.result?.content?.[0]?.text ?? '').toContain('reason');
    expect(store.getTasks()).toHaveLength(before);
  });

  it('advertises status on both tools, so it is refused and not dropped', async () => {
    const body = await rpc('tools/list');
    for (const name of ['tasks_create', 'tasks_update']) {
      const tool = body.result?.tools?.find((t) => t.name === name);
      const described = tool?.inputSchema?.properties?.status?.description ?? '';
      expect(described, `${name} must advertise status`).toContain('Not yours');
    }
  });

  it('refuses status on create, through the real SDK parse', async () => {
    // This is the behavioral half: it goes over the wire, so it proves the field
    // survives the SDK's schema parse to reach the guard. The in-session twin
    // calls the handler directly and cannot show that.
    const before = store.getTasks().length;
    const { isError, payload } = await callTool('tasks_create', {
      name: 'self-approving',
      prompt: 'do a thing',
      cron: '0 3 * * *',
      target: 'global',
      // A reason is required, so the call has to carry one to even reach the
      // guard this test is about — a call missing it is refused by the SDK's
      // own schema parse, which proves something different.
      reason: 'It should run nightly.',
      status: 'active',
    });

    expect(isError).toBe(true);
    expect(payload.fields).toEqual(['status']);
    expect(store.getTasks()).toHaveLength(before);
  });

  it('refuses a status flip on this server too, and the rename does not land', async () => {
    store.updateTask(existing.id, { status: 'pending_approval' });
    const { isError, payload } = await callTool('tasks_update', {
      id: existing.id,
      name: 'renamed-via-status-call',
      status: 'active',
    });

    expect(isError).toBe(true);
    expect(payload.fields).toEqual(['status']);
    const after = store.getTask(existing.id)!;
    expect(after.status).toBe('pending_approval');
    expect(after.name).toBe('nightly');
  });

  it('refuses tasks_update permissionMode and writes NOTHING ELSE from the same call', async () => {
    const { isError, payload } = await callTool('tasks_update', {
      id: existing.id,
      prompt: 'a different prompt nobody approved',
      cron: '* * * * *',
      permissionMode: 'bypassPermissions',
    });

    expect(isError).toBe(true);
    expect(payload.code).toBe('operator_only_task_field');
    expect(payload.fields).toEqual(['permissionMode']);

    const after = store.getTask(existing.id)!;
    expect(after.permissionMode).toBe('acceptEdits');
    expect(after.prompt).toBe('the prompt the person approved');
    expect(after.cron).toBe('0 2 * * *');
    expect(after.updatedAt).toBe(existing.updatedAt);
  });

  it('refuses tasks_create permissionMode and creates no task', async () => {
    const before = store.getTasks().length;
    const { isError, payload } = await callTool('tasks_create', {
      name: 'sneaky',
      prompt: 'do a thing',
      cron: '0 3 * * *',
      target: 'global',
      reason: 'It should run nightly.',
      permissionMode: 'bypassPermissions',
    });

    expect(isError).toBe(true);
    expect(payload.fields).toEqual(['permissionMode']);
    expect(store.getTasks()).toHaveLength(before);
  });

  it('still applies the fields an agent may write', async () => {
    const { isError } = await callTool('tasks_update', {
      id: existing.id,
      prompt: 'an updated prompt',
      enabled: false,
    });
    expect(isError).toBe(false);

    const after = store.getTask(existing.id)!;
    expect(after.prompt).toBe('an updated prompt');
    expect(after.enabled).toBe(false);
    expect(after.permissionMode).toBe('acceptEdits');
  });
});

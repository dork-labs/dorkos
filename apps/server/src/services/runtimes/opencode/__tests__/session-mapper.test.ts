import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Session as OpenCodeSession,
  UserMessage,
  AssistantMessage,
  Part,
  OpencodeClient,
} from '@opencode-ai/sdk';
import { OpenCodeSessionMapper, type OpenCodeClientProvider } from '../session-mapper.js';

// SDK-only access guard (ADR-0308: OpenCode's store is opaque, runtime-owned).
// The mapper must reach session data exclusively through the SDK client — if it
// (or anything in its runtime import graph) ever imports the filesystem, these
// throwing factories fail the suite at module load.
vi.mock('node:fs', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});
vi.mock('node:fs/promises', () => {
  throw new Error('session-mapper must not touch the filesystem (ADR-0308)');
});

const PROJECT_DIR = '/work/project';
const DORKOS_ID = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CREATED_MS = 1_751_400_000_000; // epoch ms (OpenCode time.* — NOTES.md §Session shape)
const UPDATED_MS = 1_751_403_600_000;

function ocSession(overrides: Partial<OpenCodeSession> = {}): OpenCodeSession {
  return {
    id: 'ses_abc123',
    projectID: 'prj_1',
    directory: PROJECT_DIR,
    title: 'Fix the flaky test',
    version: '1.17.13',
    time: { created: CREATED_MS, updated: UPDATED_MS },
    ...overrides,
  };
}

function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'msg_user1',
    sessionID: 'ses_abc123',
    role: 'user',
    time: { created: CREATED_MS },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg_asst1',
    sessionID: 'ses_abc123',
    role: 'assistant',
    time: { created: CREATED_MS + 1_000, completed: CREATED_MS + 5_000 },
    parentID: 'msg_user1',
    modelID: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    mode: 'build',
    path: { cwd: PROJECT_DIR, root: PROJECT_DIR },
    cost: 0.01,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function textPart(text: string, overrides: Partial<Extract<Part, { type: 'text' }>> = {}): Part {
  return {
    id: `prt_${text.slice(0, 8)}`,
    sessionID: 'ses_abc123',
    messageID: 'msg_asst1',
    type: 'text',
    text,
    ...overrides,
  };
}

function toolPart(state: Extract<Part, { type: 'tool' }>['state']): Part {
  return {
    id: 'prt_tool1',
    sessionID: 'ses_abc123',
    messageID: 'msg_asst1',
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state,
  };
}

function createMockClient() {
  return {
    session: {
      list: vi.fn(),
      create: vi.fn(),
      messages: vi.fn(),
    },
  };
}

type MockClient = ReturnType<typeof createMockClient>;

function asClient(mock: MockClient): OpencodeClient {
  return mock as unknown as OpencodeClient;
}

function createProvider(client: MockClient | null): OpenCodeClientProvider & {
  getClient: ReturnType<typeof vi.fn>;
  peekClient: ReturnType<typeof vi.fn>;
} {
  return {
    getClient: vi.fn(async () => {
      if (!client) throw new Error('sidecar unavailable');
      return asClient(client);
    }),
    peekClient: vi.fn(() => (client ? asClient(client) : null)),
  };
}

describe('OpenCodeSessionMapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureSession', () => {
    it('creates the OpenCode session with the per-session cwd as directory', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_new' }) });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const openCodeId = await mapper.ensureSession(DORKOS_ID, {
        cwd: PROJECT_DIR,
        title: 'Hello',
      });

      expect(openCodeId).toBe('ses_new');
      expect(client.session.create).toHaveBeenCalledWith({
        body: { title: 'Hello' },
        query: { directory: PROJECT_DIR },
      });
      expect(mapper.getOpenCodeSessionId(DORKOS_ID)).toBe('ses_new');
    });

    it('resolves an existing binding without creating a second OpenCode session', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_new' }) });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const first = await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });
      const second = await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      expect(first).toBe('ses_new');
      expect(second).toBe('ses_new');
      expect(client.session.create).toHaveBeenCalledTimes(1);
    });

    it('throws when the SDK reports a create error', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({
        data: undefined,
        error: { data: {}, errors: [] },
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR })).rejects.toThrow(
        /session\.create failed/
      );
    });
  });

  describe('listSessions', () => {
    it('returns [] immediately without booting when no sidecar is running', async () => {
      const provider = createProvider(null);
      const mapper = new OpenCodeSessionMapper(provider);

      await expect(mapper.listSessions(PROJECT_DIR)).resolves.toEqual([]);
      // A cold sidecar must never block the aggregated session list.
      expect(provider.getClient).not.toHaveBeenCalled();
    });

    it('lists via the SDK and maps sessions tagged runtime "opencode"', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession()] });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(client.session.list).toHaveBeenCalledWith({ query: { directory: PROJECT_DIR } });
      expect(sessions).toHaveLength(1);
      const session = sessions[0]!;
      expect(session.runtime).toBe('opencode');
      expect(session.id).toMatch(UUID_RE);
      expect(session.title).toBe('Fix the flaky test');
      expect(session.createdAt).toBe(new Date(CREATED_MS).toISOString());
      expect(session.updatedAt).toBe(new Date(UPDATED_MS).toISOString());
      expect(session.cwd).toBe(PROJECT_DIR);
      expect(session.permissionMode).toBe('default');
    });

    it('keeps DorkOS ids stable across calls and distinct per OpenCode session (1:1)', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({
        data: [ocSession({ id: 'ses_a' }), ocSession({ id: 'ses_b' })],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const first = await mapper.listSessions(PROJECT_DIR);
      const second = await mapper.listSessions(PROJECT_DIR);

      expect(first.map((s) => s.id)).toEqual(second.map((s) => s.id));
      expect(new Set(first.map((s) => s.id)).size).toBe(2);
    });

    it('derives the same DorkOS id for the same OpenCode session across mapper instances', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_stable' })] });

      const [before] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );
      const [after] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );

      expect(after!.id).toBe(before!.id);
    });

    it('returns the bound DorkOS id for sessions created through ensureSession', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_new' }) });
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_new' })] });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });
      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions[0]!.id).toBe(DORKOS_ID);
    });

    it('excludes child (subtask) sessions', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({
        data: [ocSession({ id: 'ses_root' }), ocSession({ id: 'ses_kid', parentID: 'ses_root' })],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.title).toBe('Fix the flaky test');
    });

    it('throws when the SDK reports a list error (aggregation degrades it to a warning)', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: undefined, error: 'boom' });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/session\.list failed/);
    });
  });

  describe('getMessageHistory', () => {
    it('reads via the SDK and maps text, reasoning, and tool parts', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: userMessage(),
            parts: [textPart('Run the tests')],
          },
          {
            info: assistantMessage(),
            parts: [
              {
                id: 'prt_r1',
                sessionID: 'ses_hist',
                messageID: 'msg_asst1',
                type: 'reasoning',
                text: 'Let me think.',
                time: { start: CREATED_MS },
              },
              textPart('Running now.'),
              textPart('One moment.'),
              toolPart({
                status: 'completed',
                input: { command: 'pnpm test' },
                output: 'all green',
                title: 'pnpm test',
                metadata: {},
                time: { start: CREATED_MS, end: CREATED_MS + 100 },
              }),
              {
                id: 'prt_step',
                sessionID: 'ses_hist',
                messageID: 'msg_asst1',
                type: 'step-start',
              },
            ],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_hist' } });
      expect(history).toHaveLength(2);

      expect(history[0]).toMatchObject({
        id: 'msg_user1',
        role: 'user',
        content: 'Run the tests',
      });

      const assistant = history[1]!;
      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toBe('Running now.\nOne moment.');
      expect(assistant.timestamp).toBe(new Date(CREATED_MS + 1_000).toISOString());
      // Consecutive text parts merge; step-start has no projection.
      expect(assistant.parts?.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_call']);
      expect(assistant.parts?.[2]).toMatchObject({
        type: 'tool_call',
        toolCallId: 'call_1',
        toolName: 'bash',
        input: JSON.stringify({ command: 'pnpm test' }),
        result: 'all green',
        status: 'complete',
      });
      expect(assistant.toolCalls).toEqual([
        {
          toolCallId: 'call_1',
          toolName: 'bash',
          input: JSON.stringify({ command: 'pnpm test' }),
          result: 'all green',
          status: 'complete',
        },
      ]);
    });

    it('maps errored tools with the error text as result', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: assistantMessage(),
            parts: [
              toolPart({
                status: 'error',
                input: { command: 'exit 1' },
                error: 'command failed',
                time: { start: CREATED_MS, end: CREATED_MS + 100 },
              }),
            ],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(message!.parts?.[0]).toMatchObject({
        type: 'tool_call',
        status: 'error',
        result: 'command failed',
      });
      // HistoryToolCall.status is the literal 'complete'; finished-with-error
      // still records the call, carrying the error text as its result.
      expect(message!.toolCalls?.[0]).toMatchObject({
        status: 'complete',
        result: 'command failed',
      });
    });

    it('keeps in-flight tools in parts but out of toolCalls', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: assistantMessage(),
            parts: [
              toolPart({
                status: 'running',
                input: { command: 'sleep 60' },
                time: { start: CREATED_MS },
              }),
            ],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(message!.parts?.[0]).toMatchObject({ type: 'tool_call', status: 'running' });
      expect(message!.toolCalls).toBeUndefined();
    });

    it('skips messages with no mappable parts and SDK-synthetic user text', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: userMessage({ id: 'msg_synth' }),
            parts: [textPart('<injected expansion>', { synthetic: true })],
          },
          {
            info: userMessage({ id: 'msg_real' }),
            parts: [textPart('ignored context', { ignored: true }), textPart('actual question')],
          },
          {
            info: assistantMessage({ id: 'msg_steps' }),
            parts: [
              {
                id: 'prt_snap',
                sessionID: 'ses_hist',
                messageID: 'msg_steps',
                type: 'snapshot',
                snapshot: 'abc',
              },
            ],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ id: 'msg_real', content: 'actual question' });
    });

    it('re-lists to recover a derived binding in a fresh mapper (post-restart)', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_prev' })] });
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hello again')] }],
      });

      // First process: the session surfaces through list with a derived id.
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );

      // Second process: fresh in-memory map, same OpenCode server (source of truth).
      const fresh = new OpenCodeSessionMapper(createProvider(client));
      const history = await fresh.getMessageHistory(PROJECT_DIR, listed!.id);

      expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_prev' } });
      expect(history[0]!.content).toBe('hello again');
    });

    it('throws for a session id the OpenCode server does not know', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [] });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID)).rejects.toThrow(
        /No OpenCode session mapped/
      );
      expect(client.session.messages).not.toHaveBeenCalled();
    });
  });

  describe('durable id stability (DOR-251)', () => {
    /** In-memory OpenCodeSessionMapStore fake with the replace-on-either-key contract. */
    function createFakeStore() {
      const rows = new Map<string, string>(); // sessionId -> ocSessionId
      return {
        rows,
        bind: vi.fn((sessionId: string, ocSessionId: string) => {
          for (const [sid, oid] of [...rows]) {
            if (sid === sessionId || oid === ocSessionId) rows.delete(sid);
          }
          rows.set(sessionId, ocSessionId);
        }),
        listAll: vi.fn(() =>
          [...rows].map(([sessionId, ocSessionId]) => ({ sessionId, ocSessionId }))
        ),
      };
    }

    it('writes a created binding through to the durable store', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_new' }) });
      const store = createFakeStore();
      const mapper = new OpenCodeSessionMapper(createProvider(client), store);

      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      expect(store.bind).toHaveBeenCalledWith(DORKOS_ID, 'ses_new');
    });

    it('a restarted mapper re-lists the same OpenCode session under its ORIGINAL DorkOS id', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_abc123' })] });
      const store = createFakeStore();

      // Server lifetime 1: DorkOS-created session binds the client UUID.
      const mapper = new OpenCodeSessionMapper(createProvider(client), store);
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      // Server lifetime 2: fresh mapper hydrated from the durable store. The
      // pre-fix behavior minted a NEW derived (v5) UUID here, permanently
      // 404ing the original id (DOR-251).
      const restarted = new OpenCodeSessionMapper(createProvider(client), store);
      const sessions = await restarted.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.id)).toEqual([DORKOS_ID]);
      expect(restarted.getOpenCodeSessionId(DORKOS_ID)).toBe('ses_abc123');
    });

    it('serves history under the original id after a restart without a rebuild re-list', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hello again')] }],
      });
      const store = createFakeStore();

      const mapper = new OpenCodeSessionMapper(createProvider(client), store);
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const restarted = new OpenCodeSessionMapper(createProvider(client), store);
      const history = await restarted.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(client.session.messages).toHaveBeenCalledWith({ path: { id: 'ses_abc123' } });
      expect(history[0]!.content).toBe('hello again');
      // The hydrated binding resolved directly — no recovery re-list needed.
      expect(client.session.list).not.toHaveBeenCalled();
    });

    it('does not persist derived adoptions — they are deterministic by construction', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_tui' })] });
      const store = createFakeStore();
      const mapper = new OpenCodeSessionMapper(createProvider(client), store);

      await mapper.listSessions(PROJECT_DIR);

      expect(store.bind).not.toHaveBeenCalled();
    });
  });
});

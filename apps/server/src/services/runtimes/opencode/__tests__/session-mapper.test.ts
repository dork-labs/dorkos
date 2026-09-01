import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Session as OpenCodeSession,
  UserMessage,
  AssistantMessage,
  Part,
  OpencodeClient,
} from '@opencode-ai/sdk';
import { DIRECTORY_MEMBERSHIP_VECTORS } from '@dorkos/test-utils';
import { OpenCodeSessionMapper, type OpenCodeClientProvider } from '../session-mapper.js';
import { SESSION_LIST_LIMIT, SESSION_REBUILD_LIMIT } from '../runtime-constants.js';

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
      get: vi.fn(),
      messages: vi.fn(),
    },
  };
}

type MockClient = ReturnType<typeof createMockClient>;

/**
 * Serve `sessions` the way the real sidecar does — honouring `limit`, and
 * honouring `directory` as EXACT STRING EQUALITY unless `scope=project` widens
 * the read (both live-verified on 1.18.15; see NOTES.md §8).
 *
 * The directory half is what makes these tests able to fail: a mock that hands
 * back every session regardless of `directory` models a sidecar that does the
 * adapter's job for it, so the subfolder cases would pass with or without the
 * widening — which is the bug DOR-674 was. Tests that hand back a fixed array
 * regardless of `limit` model a sidecar that IGNORES it, which is precisely what
 * the probe is built to reject.
 */
function serveSessions(client: MockClient, sessions: OpenCodeSession[]): void {
  client.session.list.mockImplementation(
    ({ query }: { query: { limit: number; directory: string; scope?: 'project' } }) => {
      const visible =
        query.scope === 'project'
          ? sessions
          : sessions.filter((s) => s.directory === query.directory);
      return Promise.resolve({ data: visible.slice(0, query.limit) }) as never;
    }
  );
}

/**
 * A sidecar that drops `limit` and serves its own fixed page — the future
 * upgrade this guard exists for. `cap` is deliberately varied across tests:
 * pinning the check to any single value is the hole being closed.
 */
function serveWithCapIgnoringLimit(
  client: MockClient,
  sessions: OpenCodeSession[],
  cap: number
): void {
  client.session.list.mockImplementation(
    () => Promise.resolve({ data: sessions.slice(0, cap) }) as never
  );
}

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
      serveSessions(client, [ocSession()]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(client.session.list).toHaveBeenCalledWith({
        query: {
          directory: PROJECT_DIR,
          roots: true,
          limit: SESSION_LIST_LIMIT + 1,
          scope: 'project',
        },
      });
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

    it('lists a session started in a SUBFOLDER of the open project (DOR-674)', async () => {
      const client = createMockClient();
      // The bug: `opencode` run in a subfolder stores THAT folder on the
      // session, and the sidecar's `?directory=` filter is exact string
      // equality — so this session appeared in no project's list at all.
      serveSessions(client, [
        ocSession({ id: 'ses_root', title: 'at the top' }),
        ocSession({
          id: 'ses_sub',
          title: 'in a subfolder',
          directory: `${PROJECT_DIR}/packages/api`,
        }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.title)).toEqual(['at the top', 'in a subfolder']);
      // The row keeps its OWN folder, so it still says where it is running.
      expect(sessions[1]!.cwd).toBe(`${PROJECT_DIR}/packages/api`);
    });

    it('asks the sidecar to widen past the exact directory it matches on (DOR-674)', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession()]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await mapper.listSessions(PROJECT_DIR);

      // Filtering can only ever narrow what came back: a subfolder session the
      // sidecar never sent cannot be recovered client-side.
      expect(client.session.list.mock.calls[0]![0]!.query.scope).toBe('project');
    });

    it('keeps a sibling folder that merely shares a prefix out of the list (DOR-674)', async () => {
      const client = createMockClient();
      // `/work/project-2` starts with `/work/project` as a STRING but is a
      // different project — the exact trap a raw `startsWith` walks into.
      serveSessions(client, [
        ocSession({ id: 'ses_mine', title: 'mine' }),
        ocSession({ id: 'ses_sibling', title: 'sibling', directory: `${PROJECT_DIR}-2/src` }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.title)).toEqual(['mine']);
    });

    it('drops the unrelated projects the widened read hands back (DOR-674)', async () => {
      const client = createMockClient();
      // Live-verified on the pinned sidecar (1.18.15): every worktree reports
      // `projectID: "global"`, so `scope=project` is effectively machine-wide
      // and returns other projects' sessions. DorkOS owns the narrowing.
      serveSessions(client, [
        ocSession({ id: 'ses_mine', title: 'mine' }),
        ocSession({ id: 'ses_other', title: 'someone else', directory: '/work/other-project' }),
        ocSession({ id: 'ses_parent', title: 'a folder above', directory: '/work' }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.title)).toEqual(['mine']);
    });

    it('matches a project dir written with a trailing slash or a "." segment', async () => {
      const client = createMockClient();
      serveSessions(client, [
        ocSession({ id: 'ses_root', title: 'at the top' }),
        ocSession({ id: 'ses_sub', title: 'in a subfolder', directory: `${PROJECT_DIR}/api` }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      // Spelling differences that are the SAME path must not decide whether a
      // project has any sessions.
      await expect(mapper.listSessions(`${PROJECT_DIR}/`)).resolves.toHaveLength(2);
      await expect(mapper.listSessions(`${PROJECT_DIR}/./api/..`)).resolves.toHaveLength(2);
    });

    it('keeps DorkOS ids stable across calls and distinct per OpenCode session (1:1)', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession({ id: 'ses_a' }), ocSession({ id: 'ses_b' })]);
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

    it('asks for more than the sidecar default of 100, so session 101+ still list (DOR-673)', async () => {
      const client = createMockClient();
      // The live sidecar returns only the 100 most-recently-updated sessions
      // when no `limit` is sent — silently, with no error and no marker. The
      // request is the only place the adapter can prevent that.
      serveSessions(
        client,
        Array.from({ length: 150 }, (_, i) => ocSession({ id: `ses_${i}` }))
      );
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      const query = client.session.list.mock.calls[0]![0]!.query;
      expect(query.limit).toBe(SESSION_LIST_LIMIT + 1);
      expect(query.limit).toBeGreaterThan(100);
      expect(sessions).toHaveLength(150);
    });

    it('excludes child sessions server-side so the limit is not spent on them (DOR-673)', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession()]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await mapper.listSessions(PROJECT_DIR);

      // Filtering children only after the server truncated would let N child
      // sessions cost the user N visible ones.
      expect(client.session.list.mock.calls[0]![0]!.query.roots).toBe(true);
    });

    it('does not fail the whole list over one session with no directory at all', async () => {
      const client = createMockClient();
      // `Session.directory` is typed as a string, but it arrives off the wire.
      // A row that lost it must cost that row — a TypeError here would reject
      // the listing and blank OpenCode for the whole project (ADR-0310 turns
      // that into "this runtime is down", which would be a lie).
      serveSessions(client, [
        ocSession({ id: 'ses_ok' }),
        ocSession({ id: 'ses_broken', directory: undefined as unknown as string }),
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const sessions = await mapper.listSessions(PROJECT_DIR);

      expect(sessions.map((s) => s.cwd)).toEqual([PROJECT_DIR]);
    });

    it('refuses a project path that is not a full folder path, out loud', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession()]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      // The membership rule will not guess a working directory, so a relative
      // path would match nothing and read as "this project has no OpenCode
      // sessions". Aggregation turns the rejection into a warning that says so.
      await expect(mapper.listSessions('work/project')).rejects.toThrow(/full folder path/);
    });

    describe.each(DIRECTORY_MEMBERSHIP_VECTORS.filter((v) => v.root.startsWith('/')))(
      'membership vector: $name',
      ({ root, candidate, within }) => {
        it(`${within ? 'lists' : 'omits'} it`, async () => {
          // The adapter answers the SAME table as the server's per-agent
          // fan-out and the client's selector — one rule, three call sites
          // (DOR-674). Only POSIX-absolute roots run here: this call site
          // additionally REQUIRES an absolute path (covered just above), and
          // `C:\…` is not absolute to a POSIX `path.isAbsolute`. The Windows
          // spellings are driven where a Windows `cwd` actually crosses a
          // boundary — the predicate's own suite and the client selector's.
          const client = createMockClient();
          serveSessions(client, [ocSession({ id: 'ses_candidate', directory: candidate })]);
          const mapper = new OpenCodeSessionMapper(createProvider(client));

          const sessions = await mapper.listSessions(root);

          expect(sessions).toHaveLength(within ? 1 : 0);
        });
      }
    );

    it('rejects when the sentinel row proves sessions were left behind (DOR-673)', async () => {
      const client = createMockClient();
      // One MORE than the budget came back, which can only mean the read was
      // truncated. There is no offset cursor to fetch the remainder, so
      // aggregation turns the rejection into a per-runtime warning (ADR-0310)
      // instead of a plausible short list.
      client.session.list.mockResolvedValue({
        data: Array.from({ length: SESSION_LIST_LIMIT + 1 }, (_, i) =>
          ocSession({ id: `ses_${i}` })
        ),
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/could not read far enough/);
    });

    it('serves a project sitting exactly on the ceiling — nothing was truncated', async () => {
      const client = createMockClient();
      // The sentinel is what makes this distinguishable from an overflow:
      // asking for LIMIT+1 and receiving LIMIT proves that is all there is.
      // Rejecting here would strand a complete list and make the real ceiling
      // one lower than the constant says.
      serveSessions(
        client,
        Array.from({ length: SESSION_LIST_LIMIT }, (_, i) => ocSession({ id: `ses_${i}` }))
      );
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.listSessions(PROJECT_DIR)).resolves.toHaveLength(SESSION_LIST_LIMIT);
    });

    it('will not claim a 3-session project is complete when the MACHINE is saturated (DOR-674)', async () => {
      const client = createMockClient();
      // The budget is spent on the widened, machine-wide read now. A machine
      // holding more sessions than DorkOS can read past means the widened page
      // was cut off somewhere — and the cut could have landed on this project's
      // subfolder sessions, so a short list here would be a confident lie.
      const elsewhere = Array.from({ length: SESSION_LIST_LIMIT + 1 }, (_, i) =>
        ocSession({ id: `ses_other_${i}`, directory: `/somewhere/else/${i}` })
      );
      serveSessions(client, [
        ocSession({ id: 'ses_1' }),
        ocSession({ id: 'ses_2' }),
        ocSession({ id: 'ses_3' }),
        ...elsewhere,
      ]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      // Degrades to a per-runtime warning (ADR-0310), which is the honest
      // answer; it must NOT return the 3 rows it happened to see.
      await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/on this machine/);
    });

    // Any cap, not one blessed value: a sidecar that dropped `limit` AND moved
    // its default would walk straight through a check pinned to 100. 50 and
    // 120 are the caps such a check misses; 100 is today's.
    it.each([50, 100, 120])(
      'rejects a sidecar that ignores `limit` and re-caps at %i',
      async (cap) => {
        const client = createMockClient();
        const sessions = Array.from({ length: 150 }, (_, i) => ocSession({ id: `ses_${i}` }));
        serveWithCapIgnoringLimit(client, sessions, cap);
        const mapper = new OpenCodeSessionMapper(createProvider(client));

        await expect(mapper.listSessions(PROJECT_DIR)).rejects.toThrow(/ignored the session limit/);
        const probe = client.session.list.mock.calls[1]![0]!.query;
        expect(probe.limit).toBe(1);
        // The probe must ask the SAME question the real read asks. A sidecar
        // that honoured `limit` for a narrow read but dropped it for the
        // widened one would clear a probe that never widens — the exact
        // probe-drift the method's own TSDoc warns about.
        expect(probe.scope).toBe('project');
      }
    );

    it('serves a page the size of the old default once the probe clears it', async () => {
      const client = createMockClient();
      // An honouring sidecar holding exactly 100 sessions: the one-row probe
      // answers with one row, so this is real data, not a re-cap.
      serveSessions(
        client,
        Array.from({ length: 100 }, (_, i) => ocSession({ id: `ses_${i}` }))
      );
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await expect(mapper.listSessions(PROJECT_DIR)).resolves.toHaveLength(100);
    });

    it('probes once per mapper and re-probes in a fresh one', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession({ id: 'ses_a' }), ocSession({ id: 'ses_b' })]);
      const provider = createProvider(client);
      const mapper = new OpenCodeSessionMapper(provider);

      await mapper.listSessions(PROJECT_DIR);
      await mapper.listSessions(PROJECT_DIR);
      await mapper.listSessions(PROJECT_DIR);

      // Whether `limit` works is a property of the sidecar build, not of any
      // one listing: 3 listings + 1 probe, not 3 listings + 3 probes.
      const probes = client.session.list.mock.calls.filter((c) => c[0]!.query.limit === 1);
      expect(client.session.list).toHaveBeenCalledTimes(4);
      expect(probes).toHaveLength(1);

      // A fresh mapper has proven nothing and must ask again.
      await new OpenCodeSessionMapper(createProvider(client)).listSessions(PROJECT_DIR);
      expect(client.session.list.mock.calls.filter((c) => c[0]!.query.limit === 1)).toHaveLength(2);
    });

    it('does not probe an empty or single-session project', async () => {
      const client = createMockClient();
      serveSessions(client, [ocSession({ id: 'ses_only' })]);
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      await mapper.listSessions(PROJECT_DIR);

      // A one-row page is what an honouring sidecar gives the probe anyway, so
      // it can never discriminate — probing it would only cost a request.
      expect(client.session.list).toHaveBeenCalledTimes(1);
    });

    it('excludes child (subtask) sessions', async () => {
      const client = createMockClient();
      serveSessions(client, [
        ocSession({ id: 'ses_root' }),
        ocSession({ id: 'ses_kid', parentID: 'ses_root' }),
      ]);
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
      // Both shapes say the same thing. History's status used to be the literal
      // `'complete'`, so this half had to record a failure as a success and let
      // the error text in `result` carry the truth — a green check on a tool
      // that failed (DOR-1293).
      expect(message!.toolCalls?.[0]).toMatchObject({
        status: 'error',
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

    // A failed turn is recorded in OpenCode's store as an assistant message
    // carrying `error` — often with NO parts at all. Measured on this machine's
    // opencode.db: all six `APIError` rows have zero parts, and the message
    // below is one of them, copied verbatim. The parts-only reader dropped
    // them, so a reopened transcript showed the question and nothing after it
    // (DOR-1666).
    it('keeps a turn that failed with nothing said, as a typed error part', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          { info: userMessage(), parts: [textPart('Run the tests')] },
          {
            info: assistantMessage({
              id: 'msg_failed',
              error: {
                name: 'APIError',
                data: {
                  message:
                    'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 2809. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
                  statusCode: 402,
                  isRetryable: false,
                },
              },
            }),
            parts: [],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(history).toHaveLength(2);
      const failed = history[1]!;
      expect(failed).toMatchObject({ id: 'msg_failed', role: 'assistant' });
      // The provider's own words, link intact — that URL is the remedy.
      expect(failed.parts).toEqual([
        {
          type: 'error',
          message:
            'This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 2809. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
          category: 'execution_error',
          details: '[APIError]',
        },
      ]);
    });

    // CONSTRUCTED, not measured: this machine's store holds zero
    // `ProviderAuthError` rows, so the shape is built from the SDK's declared
    // type. It is the case the ticket exists for — the one that earns the
    // "Fix sign-in" affordance — so it is covered, labelled rather than
    // presented as evidence.
    it('carries auth_error through to history (constructed shape)', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: assistantMessage({
              id: 'msg_auth',
              error: {
                name: 'ProviderAuthError',
                data: { providerID: 'anthropic', message: 'OAuth token revoked' },
              },
            }),
            parts: [],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const [failed] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      // `auth_error` is what turns the block into a "Fix sign-in" affordance.
      expect(failed!.parts).toEqual([
        {
          type: 'error',
          message: 'OAuth token revoked',
          category: 'auth_error',
          details: '[ProviderAuthError]',
        },
      ]);
    });

    // The blast radius of a throw here is the whole conversation, not one
    // message: `getMessageHistory` throwing is caught by the runtime facade and
    // turned into the log-backed EventLog fallback, which for a session adopted
    // from the OpenCode TUI holds nothing at all. Before the payload was
    // Zod-parsed, `{name:'APIError'}` with no `data` threw a TypeError here and
    // blanked every message in the session. The sidecar is an unpinned external
    // binary whose generated types this adapter has already caught being wrong
    // (DOR-1147), so this is a shape that can really arrive.
    it('an off-type error costs its own part, never the rest of the transcript', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          { info: userMessage({ id: 'msg_ask' }), parts: [textPart('Run the tests')] },
          {
            info: assistantMessage({ id: 'msg_said' }),
            parts: [textPart('Here is the answer.')],
          },
          // Three shapes the declared type says are impossible.
          {
            // @ts-expect-error - `data` is required by the SDK type; the sidecar is not.
            info: assistantMessage({ id: 'msg_nodata', error: { name: 'APIError' } }),
            parts: [],
          },
          {
            // @ts-expect-error - `error` is never null in the declared type.
            info: assistantMessage({ id: 'msg_null', error: null }),
            parts: [textPart('Partial work survives.')],
          },
          {
            // @ts-expect-error - `data` is never null in the declared type.
            info: assistantMessage({ id: 'msg_datanull', error: { name: 'APIError', data: null } }),
            parts: [],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      // Every readable message survived — the conversation is intact.
      expect(history.map((m) => m.id)).toEqual([
        'msg_ask',
        'msg_said',
        'msg_nodata',
        'msg_null',
        'msg_datanull',
      ]);
      expect(history[1]!.content).toBe('Here is the answer.');
      // A nameable failure still names itself rather than disappearing.
      expect(history[2]!.parts).toEqual([
        { type: 'error', message: 'APIError', category: 'execution_error' },
      ]);
      // A null error is no error: the message keeps only its own text.
      expect(history[3]!.parts?.map((p) => p.type)).toEqual(['text']);
      expect(history[4]!.parts).toEqual([
        { type: 'error', message: 'APIError', category: 'execution_error' },
      ]);
    });

    it('appends the failure after whatever the agent managed to say', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: assistantMessage({
              error: { name: 'APIError', data: { message: 'upstream 500', isRetryable: true } },
            }),
            parts: [
              textPart('Starting now.'),
              toolPart({
                status: 'completed',
                input: { command: 'pnpm test' },
                output: 'all green',
                title: 'pnpm test',
                metadata: {},
                time: { start: CREATED_MS, end: CREATED_MS + 100 },
              }),
            ],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      expect(message!.parts?.map((p) => p.type)).toEqual(['text', 'tool_call', 'error']);
      // The error part is not text, so it never leaks into the message content.
      expect(message!.content).toBe('Starting now.');
      expect(message!.parts?.[2]).toMatchObject({
        type: 'error',
        message: 'upstream 500',
        category: 'execution_error',
      });
    });

    it('shows no error for an interrupted turn — an abort is not a failure', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
      client.session.messages.mockResolvedValue({
        data: [
          {
            info: assistantMessage({
              id: 'msg_partial',
              error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
            }),
            parts: [textPart('Half a thought')],
          },
          {
            info: assistantMessage({
              id: 'msg_silent',
              error: { name: 'MessageAbortedError', data: { message: 'Aborted' } },
            }),
            parts: [],
          },
        ],
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      // The partial answer survives on its own; the one that said nothing at
      // all still drops, because an interrupt with no output IS nothing.
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ id: 'msg_partial', content: 'Half a thought' });
      expect(history[0]!.parts?.map((p) => p.type)).toEqual(['text']);
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

    it('lifts the cap on the id-rebuild re-list, and keeps child sessions in it (DOR-673)', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_prev' })] });
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hello again')] }],
      });
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );
      client.session.list.mockClear();

      await new OpenCodeSessionMapper(createProvider(client)).getMessageHistory(
        PROJECT_DIR,
        listed!.id
      );

      // Capped at 100, a session older than the 100 most recent could not be
      // bound here at all and its history 404'd. `roots` must stay off: this
      // rebuild has to be able to bind a CHILD session's id too.
      const query = client.session.list.mock.calls[0]![0]!.query;
      expect(query.limit).toBe(SESSION_REBUILD_LIMIT + 1);
      expect(query.limit).toBeGreaterThan(100);
      expect(query.roots).toBeUndefined();
    });

    it('budgets for children so it reaches every root the list showed (DOR-673)', async () => {
      const client = createMockClient();
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_prev' })] });
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hi')] }],
      });
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );
      client.session.list.mockClear();

      await new OpenCodeSessionMapper(createProvider(client)).getMessageHistory(
        PROJECT_DIR,
        listed!.id
      );

      // This read counts roots AND children while the list's budget counts
      // roots only. An equal budget would run out at roughly half the root
      // count the list happily shows, so a visible session would fail to open.
      const query = client.session.list.mock.calls[0]![0]!.query;
      expect(query.limit).toBeGreaterThan(SESSION_LIST_LIMIT + 1);
    });

    it('rebinds a subfolder session after a restart, so a listed row still opens (DOR-674)', async () => {
      const client = createMockClient();
      const subDir = `${PROJECT_DIR}/packages/api`;
      // Directory-aware: with a mock that ignores `directory`, this rebuild
      // would resolve the id whether or not it asked the sidecar to widen.
      serveSessions(client, [ocSession({ id: 'ses_sub', directory: subDir })]);
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('hi')] }],
      });
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );

      // A FRESH mapper is the post-restart state: the derived id has to be
      // re-minted from a re-list. If that re-list were still scoped to the
      // exact project dir, the row the list just showed would fail to open.
      const history = await new OpenCodeSessionMapper(createProvider(client)).getMessageHistory(
        PROJECT_DIR,
        listed!.id
      );

      expect(history).toHaveLength(1);
    });

    it('says the search was cut short, not that the session is missing (DOR-673)', async () => {
      const client = createMockClient();
      // Truncated read that does NOT contain the wanted id. Absence here
      // proves nothing, so reporting "no such session" would blame the session
      // for the adapter having stopped reading.
      client.session.list.mockResolvedValue({
        data: Array.from({ length: SESSION_REBUILD_LIMIT + 1 }, (_, i) =>
          ocSession({ id: `ses_other_${i}` })
        ),
      });
      const mapper = new OpenCodeSessionMapper(createProvider(client));

      const history = mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

      await expect(history).rejects.toThrow(/not missing — the search was cut short/);
      await expect(history).rejects.not.toThrow(/No OpenCode session mapped/);
    });

    it('still binds from a truncated read when the wanted session is inside it', async () => {
      const client = createMockClient();
      client.session.messages.mockResolvedValue({
        data: [{ info: userMessage(), parts: [textPart('found me')] }],
      });
      client.session.list.mockResolvedValue({ data: [ocSession({ id: 'ses_prev' })] });
      const [listed] = await new OpenCodeSessionMapper(createProvider(client)).listSessions(
        PROJECT_DIR
      );
      // Same page, now overflowing: truncation only matters when the lookup
      // MISSES — a hit is a hit however much was left unread.
      client.session.list.mockResolvedValue({
        data: [
          ocSession({ id: 'ses_prev' }),
          ...Array.from({ length: SESSION_REBUILD_LIMIT }, (_, i) =>
            ocSession({ id: `ses_other_${i}` })
          ),
        ],
      });

      const history = await new OpenCodeSessionMapper(createProvider(client)).getMessageHistory(
        PROJECT_DIR,
        listed!.id
      );

      expect(history[0]!.content).toBe('found me');
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

    it('getSession resolves a known binding on a cold restart by booting the sidecar', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      client.session.get.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      const store = createFakeStore();

      const mapper = new OpenCodeSessionMapper(createProvider(client), store);
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const restarted = new OpenCodeSessionMapper(createProvider(client), store);
      const session = await restarted.getSession(PROJECT_DIR, DORKOS_ID);

      expect(client.session.get).toHaveBeenCalledWith({ path: { id: 'ses_abc123' } });
      expect(session?.id).toBe(DORKOS_ID);
      expect(session?.runtime).toBe('opencode');
    });

    it('getSession returns null for an unknown binding without booting', async () => {
      const client = createMockClient();
      const provider = createProvider(client);
      const mapper = new OpenCodeSessionMapper(provider, createFakeStore());

      await expect(mapper.getSession(PROJECT_DIR, DORKOS_ID)).resolves.toBeNull();
      expect(provider.getClient).not.toHaveBeenCalled();
    });

    it('getSession returns null (never throws) when the sidecar is unreachable', async () => {
      const client = createMockClient();
      client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_abc123' }) });
      const store = createFakeStore();
      const mapper = new OpenCodeSessionMapper(createProvider(client), store);
      await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

      const restarted = new OpenCodeSessionMapper(createProvider(null), store);
      await expect(restarted.getSession(PROJECT_DIR, DORKOS_ID)).resolves.toBeNull();
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

/**
 * History and images.
 *
 * The old mapper handled text, reasoning and tool parts and returned `null` for
 * a message that produced none — so a turn whose ONLY part was an image did not
 * merely lose its picture, it disappeared from the transcript entirely. These
 * cases pin both halves of the fix: the picture maps, and the turn survives.
 *
 * The store is faked in memory rather than being the real one, because this
 * module's import graph is filesystem-free by test guard (ADR-0308) — which is
 * also why the mapper takes the store as an injected port and imports only the
 * id derivation, which needs nothing but `node:crypto`.
 */
describe('getMessageHistory — images', () => {
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  /** An in-memory `SessionAttachmentStore`, honest about idempotency. */
  function createFakeAttachmentStore() {
    const files = new Map<string, { mediaType: string; size: number }>();
    return {
      files,
      put: vi.fn(
        async (sessionId: string, attachmentId: string, mediaType: string, bytes: Buffer) => {
          const record = { mediaType, size: bytes.byteLength };
          files.set(`${sessionId}/${attachmentId}`, record);
          return { url: `/api/sessions/${sessionId}/attachments/${attachmentId}.png`, ...record };
        }
      ),
      get: vi.fn(async () => null),
      peek: vi.fn(async (sessionId: string, attachmentId: string) => {
        const record = files.get(`${sessionId}/${attachmentId}`);
        if (!record) return null;
        return { url: `/api/sessions/${sessionId}/attachments/${attachmentId}.png`, ...record };
      }),
      touch: vi.fn(async () => {}),
      // Answers a URL whether or not the bytes are there — that is the whole
      // point of it, and what lets an unresolvable image still project a part.
      urlFor: vi.fn(
        (sessionId: string, attachmentId: string) =>
          `/api/sessions/${sessionId}/attachments/${attachmentId}.png`
      ),
    };
  }

  /** A `file` part in the shape OpenCode publishes. */
  function ocFilePart(id: string, overrides: Partial<Extract<Part, { type: 'file' }>> = {}): Part {
    return {
      id,
      sessionID: 'ses_abc123',
      messageID: 'msg_asst1',
      type: 'file',
      mime: 'image/png',
      url: TINY_PNG,
      ...overrides,
    } as Part;
  }

  /** Serve one assistant message with the given parts. */
  function serveAssistant(client: MockClient, parts: Part[]) {
    client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
    client.session.messages.mockResolvedValue({
      data: [{ info: assistantMessage(), parts }],
    });
  }

  it('a turn whose ONLY part is an image no longer vanishes — it comes back WITH the image', async () => {
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen01', { filename: 'banana.png' })]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      {
        type: 'image',
        attachmentId: expect.stringMatching(/^[0-9a-f]{32}$/),
        url: expect.stringContaining('/attachments/'),
        mediaType: 'image/png',
        size: expect.any(Number),
        alt: 'banana.png',
      },
    ]);
  });

  it('a turn whose only output is an UNSTORABLE image type survives as an honest placeholder (DOR-1671)', async () => {
    // SVG is refused by the store deliberately (serving it inline is a
    // stored-XSS vector). The fix is not to allow it — it is to keep the turn,
    // with a line saying an image DorkOS cannot show was made. The raw SVG
    // bytes must never ride along.
    const client = createMockClient();
    serveAssistant(client, [
      ocFilePart('prt_svg01', {
        mime: 'image/svg+xml',
        url: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        filename: 'diagram.svg',
      }),
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      { type: 'text', text: expect.stringContaining('image/svg+xml') },
    ]);
    expect(JSON.stringify(history[0]!.parts)).not.toContain('base64');
  });

  it('a mapper with no attachment store keeps an image-only turn as a placeholder, not a hole', async () => {
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen02', { filename: 'banana.png' })]);
    const mapper = new OpenCodeSessionMapper(createProvider(client));
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      { type: 'text', text: expect.stringContaining("can't show") },
    ]);
  });

  it('re-materializes an image a tool returned, from `attachments`', async () => {
    const client = createMockClient();
    serveAssistant(client, [
      {
        id: 'prt_tool1',
        sessionID: 'ses_abc123',
        messageID: 'msg_asst1',
        type: 'tool',
        callID: 'call_1',
        tool: 'screenshot',
        state: {
          status: 'completed',
          input: {},
          output: 'captured',
          title: 'screenshot',
          metadata: {},
          attachments: [ocFilePart('prt_f1', { filename: 'shot.png' })],
          time: { start: CREATED_MS, end: CREATED_MS + 100 },
        },
      } as Part,
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(message!.parts?.map((p) => p.type)).toEqual(['tool_call', 'image']);
  });

  it('writes once — a second read of the same transcript finds the first read’s file', async () => {
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen01')]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const first = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);
    const second = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(attachments.put).toHaveBeenCalledTimes(1);
    expect(second[0]!.parts).toEqual(first[0]!.parts);
  });

  it('shows no picture, and no crash, when no attachment store is wired', async () => {
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen01'), textPart('Here it is.')]);
    const mapper = new OpenCodeSessionMapper(createProvider(client));
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(message!.parts?.map((p) => p.type)).toEqual(['text']);
  });

  it('keeps the turn when the bytes are gone, showing an unavailable image rather than nothing', async () => {
    // The retention sweep can collect a `file://`-sourced image, and this
    // module may not read the disk (ADR-0308) so it cannot rebuild one. Before
    // the placeholder, that resolved to `null`, the message mapped to no parts,
    // and `mapHistoryMessage` dropped the WHOLE TURN — the exact defect this
    // change exists to fix, recreated by its own sweep.
    const client = createMockClient();
    serveAssistant(client, [
      ocFilePart('prt_gen01', { url: 'file:///tmp/swept-away.png', filename: 'banana.png' }),
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const history = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(history).toHaveLength(1);
    expect(history[0]!.parts).toEqual([
      {
        type: 'image',
        attachmentId: expect.stringMatching(/^[0-9a-f]{32}$/),
        url: expect.stringContaining('/attachments/'),
        mediaType: 'image/png',
        size: 0,
        alt: 'banana.png',
      },
    ]);
    // Nothing was written — the placeholder is a reference to bytes that are
    // not there, which is what makes the fetch 404 into the honest chip.
    expect(attachments.put).not.toHaveBeenCalled();
  });

  it('touches an image the transcript still references, so retention reads it as in use', async () => {
    // `peek` is a `stat` and deliberately skips the write, so mtime would never
    // move again after the first write and a transcript reopened every day for
    // ninety days would still lose its picture on day ninety.
    const client = createMockClient();
    serveAssistant(client, [ocFilePart('prt_gen01')]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID); // first read writes
    expect(attachments.touch).not.toHaveBeenCalled();
    await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID); // second read finds it

    expect(attachments.touch).toHaveBeenCalledWith(
      DORKOS_ID,
      expect.stringMatching(/^[0-9a-f]{32}$/),
      'png'
    );
  });

  it('skips a non-image file part rather than filing it as a picture', async () => {
    const client = createMockClient();
    serveAssistant(client, [
      ocFilePart('prt_txt', { mime: 'text/plain', url: 'data:text/plain;base64,aGk=' }),
      textPart('Attached.'),
    ]);
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(message!.parts?.map((p) => p.type)).toEqual(['text']);
    expect(attachments.put).not.toHaveBeenCalled();
  });

  it("does not project a USER's own attachment — that is the input direction, and it is not built", async () => {
    const client = createMockClient();
    client.session.create.mockResolvedValue({ data: ocSession({ id: 'ses_hist' }) });
    client.session.messages.mockResolvedValue({
      data: [{ info: userMessage(), parts: [ocFilePart('prt_up'), textPart('look at this')] }],
    });
    const attachments = createFakeAttachmentStore();
    const mapper = new OpenCodeSessionMapper(createProvider(client), undefined, attachments);
    await mapper.ensureSession(DORKOS_ID, { cwd: PROJECT_DIR });

    const [message] = await mapper.getMessageHistory(PROJECT_DIR, DORKOS_ID);

    expect(message!.role).toBe('user');
    expect(message!.parts).toBeUndefined();
    expect(attachments.put).not.toHaveBeenCalled();
  });
});

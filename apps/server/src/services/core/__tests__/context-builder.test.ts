import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
}));
vi.mock('../../../lib/version.js', () => ({
  SERVER_VERSION: '1.2.3',
  IS_DEV_BUILD: false,
}));
vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => true),
}));
vi.mock('../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn(() => true),
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => ({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    })),
  },
}));

// The agent-identity/env half of the append moved to `runtimes/shared/` so Codex
// and OpenCode get it too; the Claude adapter keeps only its tool documentation.
import { _buildAgentBlock } from '../../runtimes/shared/agent-context.js';
import {
  buildSystemPromptAppend,
  _buildChatToolsBlock,
  _buildMeshToolsBlock,
  _buildTasksToolsBlock,
} from '../../runtimes/claude-code/messaging/context-builder.js';
import { readManifest } from '@dorkos/shared/manifest';
import { isRelayEnabled } from '../../relay/relay-state.js';
import { isTasksEnabled } from '../../tasks/task-state.js';
import { configManager } from '../config-manager.js';
import { toolDocGates } from '../../runtimes/claude-code/messaging/tool-doc-gates.js';
import { IN_SESSION_TOOL_PREFIX } from '../../runtimes/claude-code/mcp-tools/tool-exposure.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
  testHome,
} from '../agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

const mockedReadManifest = vi.mocked(readManifest);

/** Global config with every tool family switched on. */
function allToolsOnInConfig(): void {
  vi.mocked(configManager.get).mockReturnValue({
    relayTools: true,
    meshTools: true,
    adapterTools: true,
    tasksTools: true,
  });
}

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id: '01JTEST000000000000000000',
    name: 'test-agent',
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-01-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    projectPath: '/test/dir',
    scanRoot: '/test',
    ...overrides,
  };
}

describe('buildSystemPromptAppend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockedReadManifest.mockResolvedValue(null);
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(isTasksEnabled).mockReturnValue(true);
    allToolsOnInConfig();
  });

  afterEach(() => {
    // `composeWithDocsBase` below stubs the environment and re-imports; undo
    // both so nothing leaks into the describes that follow.
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('names no internal subsystem: the agent repeats what it reads (DOR-4114)', async () => {
    // An agent's session, so `<dorkos_context>` is written too.
    mockedReadManifest.mockResolvedValue(makeManifest());
    const result = (await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir')).text;
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<adapter_tools>');
    expect(result).not.toMatch(/\b(Relay|Mesh)\b/);
    expect(result).toContain(
      "Schedules, chat connections and the agent directory aren't in the catalog: use their tools, whose names end in `tasks_*`, `relay_*`/`binding_*` and `mesh_*`."
    );
  });

  it('<env> contains all required fields', async () => {
    const result = (await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir')).text;
    expect(result).toContain('Working directory: /test/dir');
    for (const field of [
      'Product',
      'Version',
      'Port',
      'Platform',
      'OS Version',
      'Node.js',
      'Hostname',
    ]) {
      expect(result).toContain(`${field}: `);
    }
  });

  it('<env> shows the version of the process building it, never an earlier one', async () => {
    // Regression: a chat reported 0.126.2 after the server was on 0.126.3.
    const before = await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir');
    vi.resetModules();
    vi.doMock('../../../lib/version.js', () => ({ SERVER_VERSION: '1.2.4', IS_DEV_BUILD: false }));
    const fresh = await import('../../runtimes/claude-code/messaging/context-builder.js');
    const after = await fresh.buildSystemPromptAppend(testHome('/test/dir'), '/test/dir');
    vi.doUnmock('../../../lib/version.js');

    expect(before.stable).toContain('Version: 1.2.3');
    expect(after.stable).toContain('Version: 1.2.4');
    expect(after.stable).toContain('App: DorkOS dev checkout 1.2.4');
    expect(after.stable).not.toContain('1.2.3');
  });

  it('gracefully handles agent block failure', async () => {
    mockedReadManifest.mockRejectedValue(new Error('disk error'));
    const result = (await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir')).text;
    expect(result).toContain('<env>');
    expect(result).not.toContain('<agent_identity>');
  });

  it('places static tool blocks before semi-static agent/env blocks', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest({ name: 'test-agent' }));
    const result = (await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir')).text;
    const chatIdx = result.indexOf('<chat_tools>');
    const envIdx = result.indexOf('<env>');
    const agentIdx = result.indexOf('<agent_identity>');
    // Tool docs (static) should precede agent identity and env (semi-static)
    expect(chatIdx).toBeLessThan(agentIdx);
    expect(chatIdx).toBeLessThan(envIdx);
  });

  it('steers schedules that must outlive the chat to DorkOS Tasks, not durable CronCreate (DOR-2717)', async () => {
    // A durable CronCreate job only fires while a Claude Code process for this session is running,
    // and DorkOS ends idle processes; the session-only timers it does hold are not durable ones
    // (the Stop hook's `session_crons` lists only the in-memory store).
    vi.mocked(isTasksEnabled).mockReturnValue(true);
    const result = (await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir')).text;
    const tasksBlock = result.slice(
      result.indexOf('<tasks_tools>'),
      result.indexOf('</tasks_tools>')
    );
    expect(tasksBlock).toContain('durable: true');
    expect(tasksBlock).toMatch(/tasks_create.*must run on a schedule/s);
  });

  it('includes the marketplace tools block even when every other feature is off (DOR-529)', async () => {
    // Marketplace has no feature flag — only its permission area can take it
    // away, so it must survive every other block being switched off.
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    vi.mocked(isTasksEnabled).mockReturnValue(false);
    const result = (
      await buildSystemPromptAppend(
        testHome('/test/dir'),
        '/test/dir',
        toolDocGates(['agents', 'messages'])
      )
    ).text;
    expect(result).not.toContain('<chat_tools>');
    expect(result).not.toContain('<mesh_tools>');
    expect(result).not.toContain('<adapter_tools>');
    expect(result).not.toContain('<tasks_tools>');
    expect(result).toContain('<marketplace_tools>');
  });

  it('keeps the chat block but drops its Relay half and the adapter block when relay is disabled', async () => {
    // The chat tools ride no bus (spec `spin-off-chats` §7); only reaching the
    // person through `relay_notify_user` needs Relay.
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const result = (
      await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir', undefined, {
        agentSession: true,
      })
    ).text;
    expect(result).toContain('<env>');
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<chat_tools>');
    expect(result).not.toContain('Reaching the person:');
    expect(result).not.toContain('<adapter_tools>');
  });

  /**
   * Compose the whole append with `DORKOS_DOCS_BASE_URL` set to `value`
   * (`undefined` unsets it). `env.ts` snapshots `process.env` at module load, so
   * the builder has to be re-imported for a stub to reach it; the manifest mock
   * is re-fetched from the reset registry for the same reason, since
   * `<dorkos_context>` only rides along when the cwd hosts an agent.
   *
   * @param value - The docs base URL to run under, or `undefined` for none.
   */
  async function composeWithDocsBase(value: string | undefined): Promise<string> {
    vi.stubEnv('DORKOS_DOCS_BASE_URL', value as unknown as string);
    vi.resetModules();
    const { readManifest: freshReadManifest } = await import('@dorkos/shared/manifest');
    vi.mocked(freshReadManifest).mockResolvedValue(makeManifest());
    const { buildSystemPromptAppend: freshBuild } =
      await import('../../runtimes/claude-code/messaging/context-builder.js');
    return (await freshBuild('/test/dir')).text;
  }

  it('composes an overridden docs base, and no later block drops or rewrites it', async () => {
    const result = await composeWithDocsBase('http://localhost:6244');
    expect(result).toContain('Documentation: http://localhost:6244/llms.txt');
    expect(result).toContain('Full docs: http://localhost:6244/docs');
    expect(result).not.toContain('dorkos.ai');
    // It survives BESIDE the Claude-specific tool docs and the <env> block, in
    // the same append, rather than replacing either of them.
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<env>');
  });

  it('excludes every switchable tool block when every area it documents is Blocked', async () => {
    const gates = toolDocGates(['messages', 'agents', 'connections', 'tasks', 'packages']);
    const result = (await buildSystemPromptAppend(testHome('/test/dir'), '/test/dir', gates)).text;
    expect(result).toContain('<env>');
    expect(result).not.toContain('<chat_tools>');
    expect(result).not.toContain('<mesh_tools>');
    expect(result).not.toContain('<adapter_tools>');
    expect(result).not.toContain('<tasks_tools>');
    expect(result).not.toContain('<marketplace_tools>');
  });
});

describe('agent-aware block gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockedReadManifest.mockResolvedValue(null);
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(isTasksEnabled).mockReturnValue(true);
  });

  // DOR-2790: a plain session's chat answers NO_CHAT, so it is not taught the
  // chat tools, and no session is told they are loaded when Messages is Blocked.
  it('teaches the chat tools to an agent session only', async () => {
    const plain = (await buildSystemPromptAppend(testHome('/tmp/test'), '/tmp/test')).text;
    expect(plain).not.toContain('<chat_tools>');
    expect(plain).not.toContain('chat_send');
    const agent = (
      await buildSystemPromptAppend(testHome('/tmp/test'), '/tmp/test', undefined, {
        agentSession: true,
      })
    ).text;
    expect(agent).toContain('<chat_tools>');
  });

  it('never claims the chat tools are loaded when Messages is Blocked', async () => {
    const result = (
      await buildSystemPromptAppend(
        testHome('/tmp/test'),
        '/tmp/test',
        toolDocGates(['messages']),
        {
          agentSession: true,
        }
      )
    ).text;
    expect(result).not.toContain('<chat_tools>');
    expect(result).not.toContain('chat_send');
    expect(result).not.toContain('chat_read');
  });

  it('toolConfig bypasses global config checks', async () => {
    // Global config says all off, but toolConfig says all on
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: false,
      meshTools: false,
      adapterTools: false,
      tasksTools: false,
    });
    const result = (
      await buildSystemPromptAppend(
        testHome('/tmp/test'),
        '/tmp/test',
        { tasks: true, messages: true, relay: true, mesh: true, adapter: true },
        { agentSession: true }
      )
    ).text;
    expect(result).toContain('<chat_tools>');
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<adapter_tools>');
    expect(result).toContain('<tasks_tools>');
  });
});

describe('buildAgentBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadManifest.mockResolvedValue(null);
  });

  it('names the agent, and carries its manifest persona only while personaEnabled', async () => {
    const persona = 'You are a helpful backend expert.';
    mockedReadManifest.mockResolvedValue(makeManifest({ personaEnabled: true, persona }));
    const on = (await _buildAgentBlock(testHome('/test/dir'))).text;
    expect(on).toContain('Name: test-agent');
    expect(on).toContain('ID: 01JTEST000000000000000000');
    expect(on).toContain(`<agent_persona>\n${persona}\n</agent_persona>`);

    mockedReadManifest.mockResolvedValue(makeManifest({ personaEnabled: false, persona }));
    const off = (await _buildAgentBlock(testHome('/test/dir'))).text;
    expect(off).toContain('<agent_identity>');
    expect(off).not.toContain('<agent_persona>');
  });
});

describe('buildChatToolsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isRelayEnabled).mockReturnValue(true);
  });

  it('teaches the three chat tools and session_start', () => {
    const result = _buildChatToolsBlock(undefined, true);
    expect(result).toContain('<chat_tools>');
    for (const name of ['chat_send', 'chat_read', 'chat_stop', 'session_start']) {
      expect(result).toContain(`${IN_SESSION_TOOL_PREFIX}${name}`);
    }
    expect(result).toContain('</chat_tools>');
  });

  // DOR-1337 (F8) and DOR-2790: the chat tools answer NO_CHAT to a chat that is
  // not an agent's, so only an agent session is taught them, and that session
  // has them loaded.
  it('is written for an agent session only, which has the tools loaded', () => {
    expect(_buildChatToolsBlock(undefined, true)).toContain('already in your');
    expect(_buildChatToolsBlock(undefined, false)).toBe('');
    expect(_buildChatToolsBlock(undefined)).toBe('');
  });

  // DOR-4469: long work goes to one lead that coordinates by chat_send, and a room hears
  // three kinds of project update. A seat may send (the limit is on which chats a send may
  // target), and chat_send never posts into a room.
  it('teaches one project lead, direct coordination and no status relays (DOR-4469)', () => {
    const result = _buildChatToolsBlock(undefined, true).replace(/\s+/g, ' ');
    expect(result).toContain('LONG PROJECT WORK GETS ONE LEAD');
    expect(result).toContain(
      `It messages the one agent who must act with ${IN_SESSION_TOOL_PREFIX}chat_send`
    );
    expect(result).toContain('never start a second one to ask for status');
    expect(result).toContain('No status relays.');
    expect(result).toContain(
      'A room hears three things about project work: it started, it is blocked on a person, it shipped.'
    );
    expect(result).toContain('Never use cc as a status channel.');
    expect(result).toContain('Anyone who asks still gets a short answer.');
    expect(result).toContain('post only for one of those three, or to answer a question');
    expect(result).toContain(
      'A result somebody in a room asked for is owed there: post it when it comes back.'
    );
  });
});

describe('buildMeshToolsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allToolsOnInConfig();
  });

  // DOR-2790: chat_send refuses a chat that is not an agent's, so only an agent
  // session is told to message a peer with it.
  it('tells only an agent session how to message another agent', () => {
    const agent = _buildMeshToolsBlock(undefined, true);
    expect(agent).toContain('Message another agent:');
    expect(agent).toContain(`which ${IN_SESSION_TOOL_PREFIX}chat_send takes as its "to"`);
    const plain = _buildMeshToolsBlock(undefined, false);
    expect(plain).toContain('<mesh_tools>');
    expect(plain).not.toContain('chat_send');
    expect(_buildMeshToolsBlock(toolDocGates(['messages']), true)).not.toContain('chat_send');
  });
});

describe('buildTasksToolsBlock', () => {
  it('returns empty string when tasks disabled and no tool config is given', () => {
    vi.mocked(isTasksEnabled).mockReturnValue(false);
    expect(_buildTasksToolsBlock()).toBe('');
  });
});

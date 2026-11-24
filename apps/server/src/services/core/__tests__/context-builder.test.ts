import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

vi.mock('../git-status.js', () => ({
  getGitStatus: vi.fn(),
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(),
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
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
  renderContextEntry,
  _buildChatToolsBlock,
  _buildMeshToolsBlock,
  _buildTasksToolsBlock,
  _buildMarketplaceToolsBlock,
  _buildPeerAgentsBlock,
  _buildRelayConnectionsBlock,
} from '../../runtimes/claude-code/messaging/context-builder.js';
import type { GitStatusData } from '@dorkos/shared/additional-context';
import type { RelayContextDeps } from '../../runtimes/claude-code/messaging/context-builder.js';
import { getGitStatus } from '../git-status.js';
import { readManifest } from '@dorkos/shared/manifest';
import { isRelayEnabled } from '../../relay/relay-state.js';
import { isTasksEnabled } from '../../tasks/task-state.js';
import { configManager } from '../config-manager.js';
import { toolDocGates } from '../../runtimes/claude-code/messaging/tool-doc-gates.js';
import { IN_SESSION_TOOL_PREFIX } from '../../runtimes/claude-code/mcp-tools/tool-exposure.js';
import type { GitStatusResponse } from '@dorkos/shared/types';
// The real Zod input shapes the marketplace tools are registered with — imported
// (not re-typed) so the signature-pin test below diffs against the schema itself,
// not a second hand-written copy of it that could drift the same way the prose did.
import { SearchInputSchema } from '../../marketplace-mcp/tool-search.js';
import { GetInputSchema } from '../../marketplace-mcp/tool-get.js';
import { ListInstalledInputSchema } from '../../marketplace-mcp/tool-list-installed.js';
import { RecommendInputSchema } from '../../marketplace-mcp/tool-recommend.js';
import { InstallInputSchema } from '../../marketplace-mcp/tool-install.js';
import { UpdateInputSchema } from '../../marketplace-mcp/tool-update.js';
import { UninstallInputSchema } from '../../marketplace-mcp/tool-uninstall.js';
import { CreatePackageInputSchema } from '../../marketplace-mcp/tool-create-package.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
  testHome,
} from '../agent-identity/__tests__/agent-home-fixture.js';

// Every scratch folder counts as a registered home here, so this suite's
// mocked mesh decides who is an agent, as it did before homes (DOR-2355).
beforeEach(() => registerEveryFolderAsHome());
afterEach(() => clearTestHomes());

const mockedGetGitStatus = vi.mocked(getGitStatus);
const mockedReadManifest = vi.mocked(readManifest);

function makeGitStatus(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    conflicted: 0,
    clean: true,
    detached: false,
    tracking: 'origin/main',
    ...overrides,
  };
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
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
    mockedReadManifest.mockResolvedValue(null);
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(isTasksEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
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
    expect(result).toContain('Product: DorkOS');
    expect(result).toMatch(/Version: /);
    expect(result).toMatch(/Port: /);
    expect(result).toMatch(/Platform: /);
    expect(result).toMatch(/OS Version: /);
    expect(result).toMatch(/Node\.js: /);
    expect(result).toMatch(/Hostname: /);
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
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
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

describe('renderContextEntry', () => {
  function gitData(overrides: Partial<GitStatusData> = {}): GitStatusData {
    return {
      isRepo: true,
      branch: 'main',
      ahead: 0,
      behind: 0,
      detached: false,
      clean: true,
      modified: 0,
      staged: 0,
      untracked: 0,
      conflicted: 0,
      ...overrides,
    };
  }

  it('wraps git status in a <git_status> block with the repo line', () => {
    const result = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: gitData(),
    });
    expect(result).toContain('<git_status>');
    expect(result).toContain('Is git repo: true');
    expect(result).toContain('Main branch (use for PRs): main');
    expect(result).toContain('</git_status>');
  });

  it('renders ui_state as a pretty-printed <ui_state> JSON block', () => {
    // The shape a client really sends since the canvas moved to the server: no `canvas` key at all
    // (spec `canvas-agent-seat` §1.7).
    const uiState = {
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: true },
      agent: { id: null, cwd: null },
    };
    const result = renderContextEntry({ kind: 'ui_state', scope: 'per-turn', data: uiState });
    expect(result).toContain('<ui_state>');
    expect(result).not.toContain('"canvas"');
    expect(result).toContain('"sidebar"');
    expect(result).toContain('"open": true');
    expect(result).toContain('</ui_state>');
  });

  it('renders queue_note with the canonical prose inside the tag', () => {
    const result = renderContextEntry({
      kind: 'queue_note',
      scope: 'per-turn',
      data: { composedDuringPrevTurn: true },
    });
    expect(result).toBe(
      '<queue_note>composed while the agent was responding to the previous message</queue_note>'
    );
  });
});

describe('buildAgentBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadManifest.mockResolvedValue(null);
  });

  it('includes <agent_identity> with name and id when manifest exists', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest());
    const result = (await _buildAgentBlock(testHome('/test/dir'))).text;
    expect(result).toContain('<agent_identity>');
    expect(result).toContain('Name: test-agent');
    expect(result).toContain('ID: 01JTEST000000000000000000');
    expect(result).toContain('</agent_identity>');
  });

  it('includes <agent_persona> when personaEnabled is true and persona is non-empty', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ personaEnabled: true, persona: 'You are a helpful backend expert.' })
    );
    const result = (await _buildAgentBlock(testHome('/test/dir'))).text;
    expect(result).toContain('<agent_persona>');
    expect(result).toContain('You are a helpful backend expert.');
    expect(result).toContain('</agent_persona>');
  });

  it('excludes <agent_persona> when personaEnabled is false', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ personaEnabled: false, persona: 'You are a helpful backend expert.' })
    );
    const result = (await _buildAgentBlock(testHome('/test/dir'))).text;
    expect(result).not.toContain('<agent_persona>');
    expect(result).toContain('<agent_identity>');
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
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
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
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTasksEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
  });

  it('returns empty string when tasks disabled', () => {
    vi.mocked(isTasksEnabled).mockReturnValue(false);
    expect(_buildTasksToolsBlock()).toBe('');
  });
});

describe('buildMarketplaceToolsBlock', () => {
  it('documents the two-call confirmation protocol', () => {
    const result = _buildMarketplaceToolsBlock();
    expect(result).toContain('requires_confirmation');
    expect(result).toContain('STOP');
  });

  /**
   * Parse the parameter names documented for `toolName` out of a rendered
   * `<marketplace_tools>` block — reads the literal `toolName(a, b?, c?)` call
   * signature and returns bare names with the optional `?` stripped. `()`
   * yields `[]`.
   *
   * @param block - The rendered block text.
   * @param toolName - The tool whose documented signature to read.
   */
  function documentedParams(block: string, toolName: string): string[] {
    const match = new RegExp(`${toolName}\\(([^)]*)\\)`).exec(block);
    if (!match) throw new Error(`no "${toolName}(...)" signature found in the block`);
    const inner = match[1].trim();
    return inner === '' ? [] : inner.split(',').map((p) => p.trim().replace(/\?$/, ''));
  }

  it('documents every tool parameter the real Zod schema defines, and no others', () => {
    // A hardcoded `toContain('exact string')` check cannot catch schema drift: it was tried in an
    // earlier revision of this test and the reviewer's drill disproved it — adding an undocumented
    // field to a real InputSchema left it (and all 81 other tests) green, because a string literal
    // has no idea what the schema actually contains.
    const result = _buildMarketplaceToolsBlock();

    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['marketplace_search', SearchInputSchema],
      ['marketplace_get', GetInputSchema],
      ['marketplace_list_installed', ListInstalledInputSchema],
      ['marketplace_recommend', RecommendInputSchema],
      ['marketplace_install', InstallInputSchema],
      ['marketplace_update', UpdateInputSchema],
      ['marketplace_uninstall', UninstallInputSchema],
      ['marketplace_create_package', CreatePackageInputSchema],
    ];
    for (const [toolName, schema] of cases) {
      const documented = documentedParams(result, toolName).slice().sort();
      const real = Object.keys(schema).sort();
      expect(
        documented,
        `${toolName}: documented params vs. Object.keys(real InputSchema)`
      ).toEqual(real);
    }

    // marketplace_list_marketplaces has no InputSchema constant to import — its
    // capability is registered with a literal `z.object({})` inline in
    // marketplace-capabilities.ts — so it is asserted directly instead.
    expect(documentedParams(result, 'marketplace_list_marketplaces')).toEqual([]);
  });
});

describe('buildPeerAgentsBlock', () => {
  type MockMeshCore = Parameters<typeof _buildPeerAgentsBlock>[0];

  function makeMockMesh(
    listWithPaths: () => Array<{
      id: string;
      name: string;
      projectPath: string;
      icon?: string;
      color?: string;
    }>
  ): MockMeshCore {
    return { listWithPaths } as MockMeshCore;
  }

  it('returns formatted XML block with agents', async () => {
    const mockMesh = makeMockMesh(() => [
      { id: 'a1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#f00' },
      { id: 'a2', name: 'test-bot', projectPath: '/projects/test' },
    ]);
    const result = await _buildPeerAgentsBlock(mockMesh, true);
    expect(result).toContain('<peer_agents>');
    expect(result).toContain('api-bot (/projects/api)');
    expect(result).toContain('test-bot (/projects/test)');
    expect(result).toContain('chat_send(to=<their agent id>');
    expect(result).toContain('</peer_agents>');
  });

  // DOR-2790: chat_send refuses a chat that is not an agent's.
  it('tells only an agent session how to message a peer', async () => {
    const mockMesh = makeMockMesh(() => [{ id: 'a1', name: 'api-bot', projectPath: '/p' }]);
    const plain = await _buildPeerAgentsBlock(mockMesh, false);
    expect(plain).toContain('api-bot (/p)');
    expect(plain).not.toContain('chat_send');
  });

  it('introduces a colleague by the name a person reads, not its slug', async () => {
    // This block is an introduction, and `chat_send` to an id from `mesh_list` is how
    // a peer is actually reached — so the addressing slug buys nothing here and
    // misnames every agent that has a real name (DOR-1264).
    const mockMesh = makeMockMesh(() => [
      { id: 'a1', name: 'docs-writer', displayName: 'Docs Writer', projectPath: '/projects/docs' },
      { id: 'a2', name: 'test-bot', projectPath: '/projects/test' },
    ]);
    const result = await _buildPeerAgentsBlock(mockMesh);

    expect(result).toContain('Docs Writer (/projects/docs)');
    expect(result).not.toContain('docs-writer');
    // An agent whose manifest declares no display name is still called by its
    // slug, which is the only name it has.
    expect(result).toContain('test-bot (/projects/test)');
  });

  it('limits to 10 agents', async () => {
    const agents = Array.from({ length: 15 }, (_, i) => ({
      id: `a${i}`,
      name: `agent-${i}`,
      projectPath: `/projects/agent-${i}`,
    }));
    const mockMesh = makeMockMesh(() => agents);
    const result = await _buildPeerAgentsBlock(mockMesh);
    // Should only have 10 entries
    const matches = result.match(/^- /gm);
    expect(matches).toHaveLength(10);
  });
});

describe('buildRelayConnectionsBlock', () => {
  const AGENT_ID = '01JTEST000000000000000000';
  const OTHER_AGENT_ID = '01JTEST111111111111111111';

  function makeBinding(overrides: Record<string, unknown> = {}) {
    return {
      id: 'binding-uuid-1',
      adapterId: 'telegram-lifeos',
      agentId: AGENT_ID,
      sessionStrategy: 'per-chat' as const,
      label: '',
      permissionMode: 'acceptEdits' as const,
      canInitiate: false,
      canReply: true,
      canReceive: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  function makeAdapterEntry(overrides: Record<string, unknown> = {}) {
    const config = {
      id: 'telegram-lifeos',
      type: 'telegram',
      enabled: true,
      builtin: false,
      label: 'LifeOS Bot',
      config: {},
      ...(overrides.config as Record<string, unknown> | undefined),
    };
    const status = {
      state: 'connected' as const,
      messageCount: 0,
      errorCount: 0,
      ...(overrides.status as Record<string, unknown> | undefined),
    };
    return { config, status };
  }

  function makeRelayContext(overrides: Partial<RelayContextDeps> = {}): RelayContextDeps {
    return {
      agentId: AGENT_ID,
      bindingStore: {
        getAll: vi.fn(() => [makeBinding()]),
      } as unknown as RelayContextDeps['bindingStore'],
      bindingRouter: {
        getSessionsByBinding: vi.fn(() => []),
      } as unknown as RelayContextDeps['bindingRouter'],
      adapterManager: {
        listAdapters: vi.fn(() => [makeAdapterEntry()]),
      } as unknown as RelayContextDeps['adapterManager'],
      ...overrides,
    };
  }

  const allOnToolConfig = { tasks: true, messages: true, relay: true, mesh: true, adapter: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isRelayEnabled).mockReturnValue(true);
  });

  it('returns empty string when agent has no bindings (only other agents)', () => {
    const ctx = makeRelayContext({
      bindingStore: {
        getAll: vi.fn(() => [makeBinding({ agentId: OTHER_AGENT_ID })]),
      } as unknown as RelayContextDeps['bindingStore'],
    });
    const result = _buildRelayConnectionsBlock(ctx, allOnToolConfig);
    expect(result).toBe('');
  });

  it('includes adapter display name, label, and connection state', () => {
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx, allOnToolConfig);
    expect(result).toContain('telegram-lifeos');
    expect(result).toContain('telegram');
    expect(result).toContain('LifeOS Bot');
    expect(result).toContain('[connected]');
  });

  it('lists active chats by chatId without exposing a raw publishable subject (DOR-277)', () => {
    const ctx = makeRelayContext({
      bindingRouter: {
        getSessionsByBinding: vi.fn(() => [
          {
            key: 'binding-uuid-1:chat:817732118',
            scope: 'chat' as const,
            chatId: '817732118',
            sessionId: 'sess-1',
            lastActivityAt: 1,
          },
        ]),
      } as unknown as RelayContextDeps['bindingRouter'],
    });
    const result = _buildRelayConnectionsBlock(ctx, allOnToolConfig);
    expect(result).toContain('Active chats:');
    expect(result).toContain('817732118');
    // "chat", not "DM": the old line called every chat-scoped session a DM,
    // including group chats, and printed a per-user session's person id as
    // though it were a chat (DOR-789).
    expect(result).toContain('chat 817732118');
    // The raw relay.human.* subject is no longer advertised as a send target.
    expect(result).not.toContain('relay.human.telegram.telegram-lifeos.817732118');
    // Default binding is canInitiate:false — the permission is surfaced honestly.
    expect(result).toContain('Start-conversations permission: OFF');
  });

  it('falls back to isRelayEnabled when toolConfig is not provided', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx);
    expect(result).toBe('');
  });
});

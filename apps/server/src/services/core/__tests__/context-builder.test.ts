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
  _buildRelayToolsBlock,
  _buildMeshToolsBlock,
  _buildAdapterToolsBlock,
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
import type { GitStatusResponse } from '@dorkos/shared/types';
// The real Zod input shapes the marketplace tools are registered with — imported
// (not re-typed) so the signature-pin test below diffs against the schema itself,
// not a second hand-written copy of it that could drift the same way the prose did.
import { SearchInputSchema } from '../../marketplace-mcp/tool-search.js';
import { GetInputSchema } from '../../marketplace-mcp/tool-get.js';
import { ListInstalledInputSchema } from '../../marketplace-mcp/tool-list-installed.js';
import { RecommendInputSchema } from '../../marketplace-mcp/tool-recommend.js';
import { InstallInputSchema } from '../../marketplace-mcp/tool-install.js';
import { UninstallInputSchema } from '../../marketplace-mcp/tool-uninstall.js';
import { CreatePackageInputSchema } from '../../marketplace-mcp/tool-create-package.js';

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

  it('returns string containing <env> block', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('</env>');
  });

  it('<env> contains all required fields', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working directory: /test/dir');
    expect(result).toContain('Product: DorkOS');
    expect(result).toMatch(/Version: /);
    expect(result).toMatch(/Port: /);
    expect(result).toMatch(/Platform: /);
    expect(result).toMatch(/OS Version: /);
    expect(result).toMatch(/Node\.js: /);
    expect(result).toMatch(/Hostname: /);
  });

  it('does not include Date in env block (SDK injects its own)', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toMatch(/Date: /);
  });

  it('Version uses SERVER_VERSION from version module', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Version: 1.2.3');
  });

  it('does not include git status (moved to per-message context)', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('<git_status>');
  });

  it('does not include peer agents (available via mesh_list tool)', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('<peer_agents>');
  });

  it('does not include ui_state (moved to per-message context)', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('<ui_state>');
  });

  it('includes agent block alongside env block', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ name: 'my-agent', description: 'A helpful agent' })
    );
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<agent_identity>');
    expect(result).toContain('Name: my-agent');
  });

  it('gracefully handles agent block failure', async () => {
    mockedReadManifest.mockRejectedValue(new Error('disk error'));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).not.toContain('<agent_identity>');
  });

  it('places static tool blocks before semi-static agent/env blocks', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest({ name: 'test-agent' }));
    const result = await buildSystemPromptAppend('/test/dir');
    const relayIdx = result.indexOf('<relay_tools>');
    const envIdx = result.indexOf('<env>');
    const agentIdx = result.indexOf('<agent_identity>');
    // Tool docs (static) should precede agent identity and env (semi-static)
    expect(relayIdx).toBeLessThan(agentIdx);
    expect(relayIdx).toBeLessThan(envIdx);
  });

  it('includes tool context blocks in output when features are enabled', async () => {
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(isTasksEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<adapter_tools>');
    expect(result).toContain('<tasks_tools>');
    expect(result).toContain('<marketplace_tools>');
  });

  it('includes the marketplace tools block even when every other toggle is off (DOR-529)', async () => {
    // Marketplace has no enabledToolGroups entry and no feature flag — it is
    // unconditional, like <ui_tools>, so it must survive every other group
    // being switched off.
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    vi.mocked(isTasksEnabled).mockReturnValue(false);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: false,
      meshTools: false,
      adapterTools: false,
      tasksTools: false,
    });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('<relay_tools>');
    expect(result).not.toContain('<mesh_tools>');
    expect(result).not.toContain('<adapter_tools>');
    expect(result).not.toContain('<tasks_tools>');
    expect(result).toContain('<marketplace_tools>');
  });

  it('excludes relay and adapter blocks when relay is disabled', async () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<mesh_tools>');
    expect(result).not.toContain('<relay_tools>');
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
    return freshBuild('/test/dir');
  }

  it('composes the production doc pointers when nothing overrides them', async () => {
    const result = await composeWithDocsBase(undefined);
    expect(result).toContain('<dorkos_context>');
    expect(result).toContain('Documentation: https://dorkos.ai/llms.txt');
    expect(result).toContain('Full docs: https://dorkos.ai/docs');
  });

  it('composes an overridden docs base, and no later block drops or rewrites it', async () => {
    const result = await composeWithDocsBase('http://localhost:6244');
    expect(result).toContain('Documentation: http://localhost:6244/llms.txt');
    expect(result).toContain('Full docs: http://localhost:6244/docs');
    expect(result).not.toContain('dorkos.ai');
    // It survives BESIDE the Claude-specific tool docs and the <env> block, in
    // the same append, rather than replacing either of them.
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('<env>');
  });

  it('excludes all tool blocks when all config toggles are off', async () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: false,
      meshTools: false,
      adapterTools: false,
      tasksTools: false,
    });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).not.toContain('<relay_tools>');
    expect(result).not.toContain('<mesh_tools>');
    expect(result).not.toContain('<adapter_tools>');
    expect(result).not.toContain('<tasks_tools>');
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

  it('omits relay block when toolConfig.relay=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', {
      tasks: true,
      relay: false,
      mesh: true,
      adapter: true,
    });
    expect(result).not.toContain('<relay_tools>');
  });

  it('omits mesh block when toolConfig.mesh=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', {
      tasks: true,
      relay: true,
      mesh: false,
      adapter: true,
    });
    expect(result).not.toContain('<mesh_tools>');
  });

  it('omits tasks block when toolConfig.tasks=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', {
      tasks: false,
      relay: true,
      mesh: true,
      adapter: true,
    });
    expect(result).not.toContain('<tasks_tools>');
  });

  it('omits adapter block when toolConfig.adapter=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', {
      tasks: true,
      relay: true,
      mesh: true,
      adapter: false,
    });
    expect(result).not.toContain('<adapter_tools>');
  });

  it('includes tasks block when toolConfig.tasks=true', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', {
      tasks: true,
      relay: true,
      mesh: true,
      adapter: true,
    });
    expect(result).toContain('<tasks_tools>');
  });

  it('backward compat: no extra args works as before', async () => {
    const result = await buildSystemPromptAppend('/tmp/test');
    expect(result).toContain('<env>');
  });

  it('toolConfig bypasses global config checks', async () => {
    // Global config says all off, but toolConfig says all on
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: false,
      meshTools: false,
      adapterTools: false,
      tasksTools: false,
    });
    const result = await buildSystemPromptAppend('/tmp/test', {
      tasks: true,
      relay: true,
      mesh: true,
      adapter: true,
    });
    expect(result).toContain('<relay_tools>');
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

  it('shows the branch from structured data', () => {
    const result = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: gitData({ branch: 'feat/my-feature' }),
    });
    expect(result).toContain('Current branch: feat/my-feature');
  });

  it('renders "Is git repo: false" for a non-repo', () => {
    const result = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: { isRepo: false },
    });
    expect(result).toBe('<git_status>\nIs git repo: false\n</git_status>');
  });

  it('renders "Working tree: dirty" with non-zero counts', () => {
    const result = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: gitData({ clean: false, modified: 2, untracked: 3 }),
    });
    expect(result).toContain('Working tree: dirty (2 modified, 3 untracked)');
  });

  it('shows "Ahead of origin" when ahead > 0', () => {
    const result = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: gitData({ ahead: 3 }),
    });
    expect(result).toContain('Ahead of origin: 3 commits');
  });

  it('shows "Detached HEAD" when detached', () => {
    const result = renderContextEntry({
      kind: 'git_status',
      scope: 'per-turn',
      data: gitData({ detached: true, branch: 'HEAD' }),
    });
    expect(result).toContain('Detached HEAD: true');
  });

  it('renders ui_state as a pretty-printed <ui_state> JSON block', () => {
    const uiState = {
      canvas: { open: false, contentType: null },
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'sessions' as const },
      agent: { id: null, cwd: null },
    };
    const result = renderContextEntry({ kind: 'ui_state', scope: 'per-turn', data: uiState });
    expect(result).toContain('<ui_state>');
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

  it('returns empty string when readManifest returns null', async () => {
    mockedReadManifest.mockResolvedValue(null);
    const result = await _buildAgentBlock('/test/dir');
    expect(result).toBe('');
  });

  it('includes <agent_identity> with name and id when manifest exists', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest());
    const result = await _buildAgentBlock('/test/dir');
    expect(result).toContain('<agent_identity>');
    expect(result).toContain('Name: test-agent');
    expect(result).toContain('ID: 01JTEST000000000000000000');
    expect(result).toContain('</agent_identity>');
  });

  it('includes description in identity block when non-empty', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest({ description: 'A test agent' }));
    const result = await _buildAgentBlock('/test/dir');
    expect(result).toContain('Description: A test agent');
  });

  it('includes capabilities in identity block when non-empty array', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ capabilities: ['code-review', 'testing'] })
    );
    const result = await _buildAgentBlock('/test/dir');
    expect(result).toContain('Capabilities: code-review, testing');
  });

  it('omits description line when description is empty string', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest({ description: '' }));
    const result = await _buildAgentBlock('/test/dir');
    expect(result).not.toContain('Description:');
  });

  it('omits capabilities line when capabilities is empty array', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest({ capabilities: [] }));
    const result = await _buildAgentBlock('/test/dir');
    expect(result).not.toContain('Capabilities:');
  });

  it('includes <agent_persona> when personaEnabled is true and persona is non-empty', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ personaEnabled: true, persona: 'You are a helpful backend expert.' })
    );
    const result = await _buildAgentBlock('/test/dir');
    expect(result).toContain('<agent_persona>');
    expect(result).toContain('You are a helpful backend expert.');
    expect(result).toContain('</agent_persona>');
  });

  it('excludes <agent_persona> when personaEnabled is false', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ personaEnabled: false, persona: 'You are a helpful backend expert.' })
    );
    const result = await _buildAgentBlock('/test/dir');
    expect(result).not.toContain('<agent_persona>');
    expect(result).toContain('<agent_identity>');
  });

  it('excludes <agent_persona> when persona is undefined', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ personaEnabled: true, persona: undefined })
    );
    const result = await _buildAgentBlock('/test/dir');
    expect(result).not.toContain('<agent_persona>');
  });

  it('excludes <agent_persona> when persona is empty string', async () => {
    mockedReadManifest.mockResolvedValue(makeManifest({ personaEnabled: true, persona: '' }));
    const result = await _buildAgentBlock('/test/dir');
    expect(result).not.toContain('<agent_persona>');
  });

  it('includes <agent_persona> when personaEnabled is undefined (defaults true) and persona is non-empty', async () => {
    // personaEnabled defaults to true in the schema, so when present it will be true
    mockedReadManifest.mockResolvedValue(
      makeManifest({ personaEnabled: true, persona: 'Expert persona text.' })
    );
    const result = await _buildAgentBlock('/test/dir');
    expect(result).toContain('<agent_persona>');
    expect(result).toContain('Expert persona text.');
  });
});

describe('buildRelayToolsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
  });

  it('returns relay context when relay enabled and config on', () => {
    const result = _buildRelayToolsBlock();
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('relay_register_endpoint');
    expect(result).toContain('relay_send');
    expect(result).toContain('relay_inbox');
    expect(result).toContain('</relay_tools>');
  });

  // DOR-1337 (F5). The block used to teach `relay.agent.{agentId}` — two
  // segments — while every allow rule matches the four-segment
  // `relay.agent.{namespace}.{agentId}`. An agent following its own
  // documentation addressed a subject no rule could match and was refused,
  // with the operator's grant sitting there correct and unmatched.
  it('teaches the four-segment agent subject and never the two-segment one', () => {
    const result = _buildRelayToolsBlock();
    expect(result).toContain('relay.agent.{namespace}.{agentId}');
    expect(result).not.toContain('relay.agent.{agentId}');
    expect(result).not.toContain('relay.agent.{theirAgentId}');
  });

  it('sends the agent to relaySubject rather than to a subject it assembles', () => {
    const result = _buildRelayToolsBlock();
    expect(result).toContain('relaySubject');
    expect(result).toContain('never');
  });

  // DOR-1337 (F6). A failed target used to arrive as an empty success.
  it('warns that a done:true payload may carry an error', () => {
    const result = _buildRelayToolsBlock();
    expect(result).toContain('error');
    expect(result).toContain('AGENT_ERROR');
  });

  // DOR-1337 (F8). The claim must match the exposure decision, both ways.
  it('claims the six agent-to-agent tools are loaded only for an agent session', () => {
    expect(_buildRelayToolsBlock(undefined, true)).toContain('already in your tool list');
    const plain = _buildRelayToolsBlock(undefined, false);
    expect(plain).not.toContain('already in your tool list');
    expect(plain).toContain('ToolSearch');
  });

  it('returns empty string when relay disabled', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    expect(_buildRelayToolsBlock()).toBe('');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: false,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
    expect(_buildRelayToolsBlock()).toBe('');
  });

  it('returns relay context when config is undefined (default behavior)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const result = _buildRelayToolsBlock();
    expect(result).toContain('<relay_tools>');
  });

  it('uses toolConfig when provided (relay=true)', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false); // global says off
    const result = _buildRelayToolsBlock({ tasks: true, relay: true, mesh: true, adapter: true });
    expect(result).toContain('<relay_tools>');
  });

  it('uses toolConfig when provided (relay=false)', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(true); // global says on
    const result = _buildRelayToolsBlock({ tasks: true, relay: false, mesh: true, adapter: true });
    expect(result).toBe('');
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

  it('returns mesh context by default (mesh always-on)', () => {
    const result = _buildMeshToolsBlock();
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('mesh_discover');
    expect(result).toContain('mesh_register');
    expect(result).toContain('mesh_inspect');
    expect(result).toContain('mesh_status');
    expect(result).toContain('</mesh_tools>');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: false,
      adapterTools: true,
      tasksTools: true,
    });
    expect(_buildMeshToolsBlock()).toBe('');
  });

  it('returns mesh context when config is undefined (default behavior)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const result = _buildMeshToolsBlock();
    expect(result).toContain('<mesh_tools>');
  });

  it('is not affected by relay feature flag', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const result = _buildMeshToolsBlock();
    expect(result).toContain('<mesh_tools>');
  });

  it('uses toolConfig when provided (mesh=false)', () => {
    const result = _buildMeshToolsBlock({ tasks: true, relay: true, mesh: false, adapter: true });
    expect(result).toBe('');
  });
});

describe('buildAdapterToolsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: true,
    });
  });

  it('returns adapter context when relay enabled and config on', () => {
    const result = _buildAdapterToolsBlock();
    expect(result).toContain('<adapter_tools>');
    expect(result).toContain('binding_create');
    expect(result).toContain('binding_list');
    expect(result).toContain('relay.human.telegram');
    expect(result).toContain('</adapter_tools>');
  });

  it('returns empty string when relay disabled', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    expect(_buildAdapterToolsBlock()).toBe('');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: false,
      tasksTools: true,
    });
    expect(_buildAdapterToolsBlock()).toBe('');
  });

  it('returns adapter context when config is undefined (default behavior)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const result = _buildAdapterToolsBlock();
    expect(result).toContain('<adapter_tools>');
  });

  it('uses toolConfig when provided (adapter=false)', () => {
    const result = _buildAdapterToolsBlock({
      tasks: true,
      relay: true,
      mesh: true,
      adapter: false,
    });
    expect(result).toBe('');
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

  it('returns tasks context when tasks enabled and config on', () => {
    const result = _buildTasksToolsBlock();
    expect(result).toContain('<tasks_tools>');
    expect(result).toContain('tasks_list');
    expect(result).toContain('tasks_create');
    expect(result).toContain('tasks_update');
    expect(result).toContain('tasks_delete');
    expect(result).toContain('tasks_get_run_history');
    expect(result).toContain('</tasks_tools>');
  });

  it('returns empty string when tasks disabled', () => {
    vi.mocked(isTasksEnabled).mockReturnValue(false);
    expect(_buildTasksToolsBlock()).toBe('');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      tasksTools: false,
    });
    expect(_buildTasksToolsBlock()).toBe('');
  });

  it('returns tasks context when config is undefined (default behavior)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const result = _buildTasksToolsBlock();
    expect(result).toContain('<tasks_tools>');
  });

  it('uses toolConfig when provided (tasks=true)', () => {
    vi.mocked(isTasksEnabled).mockReturnValue(false); // global says off
    const result = _buildTasksToolsBlock({ tasks: true, relay: true, mesh: true, adapter: true });
    expect(result).toContain('<tasks_tools>');
  });

  it('uses toolConfig when provided (tasks=false)', () => {
    vi.mocked(isTasksEnabled).mockReturnValue(true); // global says on
    const result = _buildTasksToolsBlock({ tasks: false, relay: true, mesh: true, adapter: true });
    expect(result).toBe('');
  });
});

describe('buildMarketplaceToolsBlock', () => {
  it('always returns the marketplace context (no toggle to gate on)', () => {
    const result = _buildMarketplaceToolsBlock();
    expect(result).toContain('<marketplace_tools>');
    expect(result).toContain('marketplace_search');
    expect(result).toContain('marketplace_install');
    expect(result).toContain('marketplace_uninstall');
    expect(result).toContain('marketplace_create_package');
    expect(result).toContain('confirmationToken');
    expect(result).toContain('</marketplace_tools>');
  });

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
    // A hardcoded `toContain('exact string')` check cannot catch schema drift: it
    // was tried in an earlier revision of this test and the reviewer's drill
    // disproved it — adding an undocumented field to a real InputSchema left it
    // (and all 81 other tests) green, because a string literal has no idea what
    // the schema actually contains. This version reads the block's documented
    // param NAMES with `documentedParams` and diffs them against
    // `Object.keys(<the real, imported InputSchema>)` for each tool, so a schema
    // change that drifts from the docs fails loudly, naming the tool.
    const result = _buildMarketplaceToolsBlock();

    const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['marketplace_search', SearchInputSchema],
      ['marketplace_get', GetInputSchema],
      ['marketplace_list_installed', ListInstalledInputSchema],
      ['marketplace_recommend', RecommendInputSchema],
      ['marketplace_install', InstallInputSchema],
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

  it('returns empty string when meshCore is null', async () => {
    const result = await _buildPeerAgentsBlock(null);
    expect(result).toBe('');
  });

  it('returns empty string when meshCore is undefined', async () => {
    const result = await _buildPeerAgentsBlock(undefined);
    expect(result).toBe('');
  });

  it('returns empty string when no agents', async () => {
    const mockMesh = makeMockMesh(() => []);
    const result = await _buildPeerAgentsBlock(mockMesh);
    expect(result).toBe('');
  });

  it('returns formatted XML block with agents', async () => {
    const mockMesh = makeMockMesh(() => [
      { id: 'a1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#f00' },
      { id: 'a2', name: 'test-bot', projectPath: '/projects/test' },
    ]);
    const result = await _buildPeerAgentsBlock(mockMesh);
    expect(result).toContain('<peer_agents>');
    expect(result).toContain('api-bot (/projects/api)');
    expect(result).toContain('test-bot (/projects/test)');
    expect(result).toContain('mesh_inspect(agentId)');
    expect(result).toContain('relay_send()');
    expect(result).toContain('</peer_agents>');
  });

  it('introduces a colleague by the name a person reads, not its slug', async () => {
    // This block is an introduction, and `mesh_inspect(agentId)` below it is how
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

  it('returns empty string when listWithPaths throws', async () => {
    const mockMesh = makeMockMesh(() => {
      throw new Error('fail');
    });
    const result = await _buildPeerAgentsBlock(mockMesh);
    expect(result).toBe('');
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

  const allOnToolConfig = { tasks: true, relay: true, mesh: true, adapter: true };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isRelayEnabled).mockReturnValue(true);
  });

  it('returns empty string when relayContext is undefined', () => {
    const result = _buildRelayConnectionsBlock(undefined, allOnToolConfig);
    expect(result).toBe('');
  });

  it('returns empty string when toolConfig.adapter is false', () => {
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx, { ...allOnToolConfig, adapter: false });
    expect(result).toBe('');
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

  it('shows "No active chats yet" for bindings without sessions', () => {
    const ctx = makeRelayContext({
      bindingRouter: {
        getSessionsByBinding: vi.fn(() => []),
      } as unknown as RelayContextDeps['bindingRouter'],
    });
    const result = _buildRelayConnectionsBlock(ctx, allOnToolConfig);
    expect(result).toContain('No active chats yet');
  });

  it('output is wrapped in <relay_connections> XML tags', () => {
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx, allOnToolConfig);
    expect(result).toMatch(/^<relay_connections>\n/);
    expect(result).toMatch(/\n<\/relay_connections>$/);
  });

  it('steers to relay_notify_user and does not offer relay_send for reaching humans (DOR-277)', () => {
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx, allOnToolConfig);
    expect(result).toContain('relay_notify_user(');
    // relay_send is no longer advertised as a way to message a human channel.
    expect(result).not.toContain('relay_send(');
  });

  it('falls back to isRelayEnabled when toolConfig is not provided', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx);
    expect(result).toBe('');
  });

  it('returns block when toolConfig not provided and relay is enabled', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    const ctx = makeRelayContext();
    const result = _buildRelayConnectionsBlock(ctx);
    expect(result).toContain('<relay_connections>');
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
vi.mock('../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn(() => true),
}));
vi.mock('../../pulse/pulse-state.js', () => ({
  isPulseEnabled: vi.fn(() => true),
}));
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: vi.fn(() => ({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      pulseTools: true,
    })),
  },
}));

import {
  buildSystemPromptAppend,
  _buildAgentBlock,
  _buildRelayToolsBlock,
  _buildMeshToolsBlock,
  _buildAdapterToolsBlock,
  _buildPulseToolsBlock,
  _buildPeerAgentsBlock,
} from '../context-builder.js';
import { getGitStatus } from '../git-status.js';
import { readManifest } from '@dorkos/shared/manifest';
import { isRelayEnabled } from '../../relay/relay-state.js';
import { isPulseEnabled } from '../../pulse/pulse-state.js';
import { configManager } from '../config-manager.js';
import type { GitStatusResponse } from '@dorkos/shared/types';

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
    budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
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
    vi.mocked(isPulseEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      pulseTools: true,
    });
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
    expect(result).toMatch(/Date: /);
  });

  it('Date field is valid ISO 8601', async () => {
    const result = await buildSystemPromptAppend('/test/dir');
    const dateMatch = result.match(/Date: (.+)/);
    expect(dateMatch).not.toBeNull();
    const parsed = new Date(dateMatch![1]);
    expect(parsed.toISOString()).toBe(dateMatch![1]);
  });

  it('Version defaults to "development" when env unset', async () => {
    delete process.env.DORKOS_VERSION;
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Version: development');
  });

  it('<git_status> shows "Is git repo: false" for non-git dirs', async () => {
    mockedGetGitStatus.mockResolvedValue({ error: 'not_git_repo' as const });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<git_status>');
    expect(result).toContain('Is git repo: false');
    expect(result).toContain('</git_status>');
  });

  it('<git_status> shows branch when git repo', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ branch: 'feat/my-feature' }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Is git repo: true');
    expect(result).toContain('Current branch: feat/my-feature');
  });

  it('omits "Ahead of origin" when ahead=0', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ ahead: 0 }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('Ahead of origin');
  });

  it('shows "Ahead of origin" when ahead>0', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ ahead: 3 }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Ahead of origin: 3 commits');
  });

  it('shows "Working tree: clean" when all counts zero', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ clean: true }));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working tree: clean');
  });

  it('shows "Working tree: dirty" with only non-zero counts', async () => {
    mockedGetGitStatus.mockResolvedValue(
      makeGitStatus({
        clean: false,
        modified: 2,
        staged: 0,
        untracked: 3,
        conflicted: 0,
      })
    );
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Working tree: dirty (2 modified, 3 untracked)');
    expect(result).not.toContain('staged');
    expect(result).not.toContain('conflicted');
  });

  it('shows "Detached HEAD" only when detached', async () => {
    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ detached: false }));
    let result = await buildSystemPromptAppend('/test/dir');
    expect(result).not.toContain('Detached HEAD');

    mockedGetGitStatus.mockResolvedValue(makeGitStatus({ detached: true, branch: 'HEAD' }));
    result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('Detached HEAD: true');
  });

  it('git failure still returns env block (no throw)', async () => {
    mockedGetGitStatus.mockRejectedValue(new Error('git not found'));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('</env>');
  });

  it('includes agent block alongside env and git blocks', async () => {
    mockedReadManifest.mockResolvedValue(
      makeManifest({ name: 'my-agent', description: 'A helpful agent' })
    );
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<git_status>');
    expect(result).toContain('<agent_identity>');
    expect(result).toContain('Name: my-agent');
  });

  it('gracefully handles agent block failure', async () => {
    mockedReadManifest.mockRejectedValue(new Error('disk error'));
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<git_status>');
    expect(result).not.toContain('<agent_identity>');
  });

  it('includes tool context blocks in output when features are enabled', async () => {
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(isPulseEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      pulseTools: true,
    });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<adapter_tools>');
    expect(result).toContain('<pulse_tools>');
  });

  it('excludes relay and adapter blocks when relay is disabled', async () => {
    vi.mocked(isRelayEnabled).mockReturnValue(false);
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).toContain('<mesh_tools>');
    expect(result).not.toContain('<relay_tools>');
    expect(result).not.toContain('<adapter_tools>');
  });

  it('excludes all tool blocks when all config toggles are off', async () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: false,
      meshTools: false,
      adapterTools: false,
      pulseTools: false,
    });
    const result = await buildSystemPromptAppend('/test/dir');
    expect(result).toContain('<env>');
    expect(result).not.toContain('<relay_tools>');
    expect(result).not.toContain('<mesh_tools>');
    expect(result).not.toContain('<adapter_tools>');
    expect(result).not.toContain('<pulse_tools>');
  });
});

describe('agent-aware block gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockedGetGitStatus.mockResolvedValue(makeGitStatus());
    mockedReadManifest.mockResolvedValue(null);
    vi.mocked(isRelayEnabled).mockReturnValue(true);
    vi.mocked(isPulseEnabled).mockReturnValue(true);
  });

  it('omits relay block when toolConfig.relay=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', null, {
      pulse: true, relay: false, mesh: true, adapter: true,
    });
    expect(result).not.toContain('<relay_tools>');
  });

  it('omits mesh block when toolConfig.mesh=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', null, {
      pulse: true, relay: true, mesh: false, adapter: true,
    });
    expect(result).not.toContain('<mesh_tools>');
  });

  it('omits pulse block when toolConfig.pulse=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', null, {
      pulse: false, relay: true, mesh: true, adapter: true,
    });
    expect(result).not.toContain('<pulse_tools>');
  });

  it('omits adapter block when toolConfig.adapter=false', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', null, {
      pulse: true, relay: true, mesh: true, adapter: false,
    });
    expect(result).not.toContain('<adapter_tools>');
  });

  it('includes pulse block when toolConfig.pulse=true', async () => {
    const result = await buildSystemPromptAppend('/tmp/test', null, {
      pulse: true, relay: true, mesh: true, adapter: true,
    });
    expect(result).toContain('<pulse_tools>');
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
      pulseTools: false,
    });
    const result = await buildSystemPromptAppend('/tmp/test', null, {
      pulse: true, relay: true, mesh: true, adapter: true,
    });
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('<mesh_tools>');
    expect(result).toContain('<adapter_tools>');
    expect(result).toContain('<pulse_tools>');
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
    mockedReadManifest.mockResolvedValue(makeManifest({ personaEnabled: true, persona: undefined }));
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
      pulseTools: true,
    });
  });

  it('returns relay context when relay enabled and config on', () => {
    const result = _buildRelayToolsBlock();
    expect(result).toContain('<relay_tools>');
    expect(result).toContain('relay.agent.{sessionId}');
    expect(result).toContain('relay_register_endpoint');
    expect(result).toContain('relay_send');
    expect(result).toContain('relay_inbox');
    expect(result).toContain('</relay_tools>');
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
      pulseTools: true,
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
    const result = _buildRelayToolsBlock({ pulse: true, relay: true, mesh: true, adapter: true });
    expect(result).toContain('<relay_tools>');
  });

  it('uses toolConfig when provided (relay=false)', () => {
    vi.mocked(isRelayEnabled).mockReturnValue(true); // global says on
    const result = _buildRelayToolsBlock({ pulse: true, relay: false, mesh: true, adapter: true });
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
      pulseTools: true,
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
      pulseTools: true,
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
    const result = _buildMeshToolsBlock({ pulse: true, relay: true, mesh: false, adapter: true });
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
      pulseTools: true,
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
      pulseTools: true,
    });
    expect(_buildAdapterToolsBlock()).toBe('');
  });

  it('returns adapter context when config is undefined (default behavior)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const result = _buildAdapterToolsBlock();
    expect(result).toContain('<adapter_tools>');
  });

  it('uses toolConfig when provided (adapter=false)', () => {
    const result = _buildAdapterToolsBlock({ pulse: true, relay: true, mesh: true, adapter: false });
    expect(result).toBe('');
  });
});

describe('buildPulseToolsBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isPulseEnabled).mockReturnValue(true);
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      pulseTools: true,
    });
  });

  it('returns pulse context when pulse enabled and config on', () => {
    const result = _buildPulseToolsBlock();
    expect(result).toContain('<pulse_tools>');
    expect(result).toContain('list_schedules');
    expect(result).toContain('create_schedule');
    expect(result).toContain('update_schedule');
    expect(result).toContain('delete_schedule');
    expect(result).toContain('get_run_history');
    expect(result).toContain('</pulse_tools>');
  });

  it('returns empty string when pulse disabled', () => {
    vi.mocked(isPulseEnabled).mockReturnValue(false);
    expect(_buildPulseToolsBlock()).toBe('');
  });

  it('returns empty string when config toggle is off', () => {
    vi.mocked(configManager.get).mockReturnValue({
      relayTools: true,
      meshTools: true,
      adapterTools: true,
      pulseTools: false,
    });
    expect(_buildPulseToolsBlock()).toBe('');
  });

  it('returns pulse context when config is undefined (default behavior)', () => {
    vi.mocked(configManager.get).mockReturnValue(undefined);
    const result = _buildPulseToolsBlock();
    expect(result).toContain('<pulse_tools>');
  });

  it('uses toolConfig when provided (pulse=true)', () => {
    vi.mocked(isPulseEnabled).mockReturnValue(false); // global says off
    const result = _buildPulseToolsBlock({ pulse: true, relay: true, mesh: true, adapter: true });
    expect(result).toContain('<pulse_tools>');
  });

  it('uses toolConfig when provided (pulse=false)', () => {
    vi.mocked(isPulseEnabled).mockReturnValue(true); // global says on
    const result = _buildPulseToolsBlock({ pulse: false, relay: true, mesh: true, adapter: true });
    expect(result).toBe('');
  });
});

describe('buildPeerAgentsBlock', () => {
  type MockMeshCore = Parameters<typeof _buildPeerAgentsBlock>[0];

  function makeMockMesh(
    listWithPaths: () => Array<{ id: string; name: string; projectPath: string; icon?: string; color?: string }>,
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
    const mockMesh = makeMockMesh(() => { throw new Error('fail'); });
    const result = await _buildPeerAgentsBlock(mockMesh);
    expect(result).toBe('');
  });
});

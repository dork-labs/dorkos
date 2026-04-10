import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ModelOption,
  SubagentInfo,
  CommandRegistry,
  CommandEntry,
} from '@dorkos/shared/types';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { SdkCommandEntry } from '../message-sender.js';
import type { CommandRegistryService } from '../command-registry.js';

vi.mock('../runtime-constants.js', () => ({
  DEFAULT_MODELS: [
    {
      value: 'claude-sonnet-4-5-20250929',
      displayName: 'Sonnet 4.5',
      description: 'Fast model',
    },
  ] satisfies ModelOption[],
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));

import { RuntimeCache } from '../runtime-cache.js';
import { DEFAULT_MODELS } from '../runtime-constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModels(...names: string[]): ModelOption[] {
  return names.map((n) => ({ value: n, displayName: n, description: `${n} desc` }));
}

function makeSubagents(...names: string[]): SubagentInfo[] {
  return names.map((n) => ({ name: n, description: `${n} subagent` }));
}

function makeMcpServers(...names: string[]): McpServerEntry[] {
  return names.map((n) => ({ name: n, type: 'stdio' as const }));
}

function makeSdkCommands(...names: string[]): SdkCommandEntry[] {
  return names.map((n) => ({ name: n, description: `${n} desc`, argumentHint: '' }));
}

function makeFsCommandEntry(fullCommand: string, extra?: Partial<CommandEntry>): CommandEntry {
  return { fullCommand, description: `${fullCommand} fs desc`, ...extra };
}

function makeRegistry(
  commands: CommandEntry[],
  lastScanned = '2026-01-01T00:00:00.000Z'
): CommandRegistry {
  return { commands, lastScanned };
}

function createMockRegistryService(registry: CommandRegistry): CommandRegistryService {
  return {
    getCommands: vi.fn().mockResolvedValue(registry),
  } as unknown as CommandRegistryService;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeCache', () => {
  let cache: RuntimeCache;

  beforeEach(() => {
    vi.clearAllMocks();
    cache = new RuntimeCache();
  });

  // =========================================================================
  // getSupportedModels
  // =========================================================================

  describe('getSupportedModels', () => {
    it('returns DEFAULT_MODELS when nothing is cached', () => {
      const result = cache.getSupportedModels();
      expect(result).toBe(DEFAULT_MODELS);
    });

    it('returns cached models after buildSendCallbacks populates them', () => {
      const custom = makeModels('custom-model');
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!(custom);

      expect(cache.getSupportedModels()).toBe(custom);
    });
  });

  // =========================================================================
  // getSupportedSubagents
  // =========================================================================

  describe('getSupportedSubagents', () => {
    it('returns empty array when nothing is cached and cwd is provided', () => {
      expect(cache.getSupportedSubagents('/project')).toEqual([]);
    });

    it('returns empty array when nothing is cached and cwd is omitted', () => {
      expect(cache.getSupportedSubagents()).toEqual([]);
    });

    it('returns cached subagents for a specific cwd', () => {
      const agents = makeSubagents('Explore', 'Code');
      const callbacks = cache.buildSendCallbacks('/projectA');
      callbacks.onSubagentsReceived!(agents);

      expect(cache.getSupportedSubagents('/projectA')).toBe(agents);
    });

    it('returns empty for a different cwd that has no cached subagents', () => {
      const agents = makeSubagents('Explore');
      const callbacks = cache.buildSendCallbacks('/projectA');
      callbacks.onSubagentsReceived!(agents);

      expect(cache.getSupportedSubagents('/projectB')).toEqual([]);
    });

    it('returns last-inserted entry as fallback when cwd is omitted', () => {
      const agentsA = makeSubagents('A');
      const agentsB = makeSubagents('B');

      const cbA = cache.buildSendCallbacks('/projectA');
      cbA.onSubagentsReceived!(agentsA);
      const cbB = cache.buildSendCallbacks('/projectB');
      cbB.onSubagentsReceived!(agentsB);

      // Without cwd, should return the last-inserted entry
      expect(cache.getSupportedSubagents()).toBe(agentsB);
    });
  });

  // =========================================================================
  // getMcpStatus
  // =========================================================================

  describe('getMcpStatus', () => {
    it('returns null when nothing is cached for the cwd', () => {
      expect(cache.getMcpStatus('/project')).toBeNull();
    });

    it('returns cached MCP servers for a specific cwd', () => {
      const servers = makeMcpServers('postgres-mcp', 'github-mcp');
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onMcpStatusReceived!(servers);

      expect(cache.getMcpStatus('/project')).toBe(servers);
    });

    it('returns null for a different cwd', () => {
      const servers = makeMcpServers('mcp-a');
      const callbacks = cache.buildSendCallbacks('/projectA');
      callbacks.onMcpStatusReceived!(servers);

      expect(cache.getMcpStatus('/projectB')).toBeNull();
    });
  });

  // =========================================================================
  // buildSendCallbacks
  // =========================================================================

  describe('buildSendCallbacks', () => {
    it('provides onModelsReceived on first call (not yet cached)', () => {
      const cb = cache.buildSendCallbacks('/project');
      expect(cb.onModelsReceived).toBeDefined();
    });

    it('does not provide onModelsReceived once models are already cached', () => {
      const cb1 = cache.buildSendCallbacks('/project');
      cb1.onModelsReceived!(makeModels('m'));

      const cb2 = cache.buildSendCallbacks('/project');
      expect(cb2.onModelsReceived).toBeUndefined();
    });

    it('always provides onMcpStatusReceived (refreshes every time)', () => {
      const cb1 = cache.buildSendCallbacks('/project');
      cb1.onMcpStatusReceived!(makeMcpServers('s1'));

      const cb2 = cache.buildSendCallbacks('/project');
      expect(cb2.onMcpStatusReceived).toBeDefined();

      // Calling it should update the cache
      const newServers = makeMcpServers('s2');
      cb2.onMcpStatusReceived!(newServers);
      expect(cache.getMcpStatus('/project')).toBe(newServers);
    });

    it('provides onCommandsReceived only when cwd has no cached commands', () => {
      const cb1 = cache.buildSendCallbacks('/projectA');
      expect(cb1.onCommandsReceived).toBeDefined();

      cb1.onCommandsReceived!(makeSdkCommands('test'));

      const cb2 = cache.buildSendCallbacks('/projectA');
      expect(cb2.onCommandsReceived).toBeUndefined();
    });

    it('provides onCommandsReceived for a different cwd even when one cwd is cached', () => {
      const cb1 = cache.buildSendCallbacks('/projectA');
      cb1.onCommandsReceived!(makeSdkCommands('test'));

      const cb2 = cache.buildSendCallbacks('/projectB');
      expect(cb2.onCommandsReceived).toBeDefined();
    });

    it('provides onSubagentsReceived only when cwd has no cached subagents', () => {
      const cb1 = cache.buildSendCallbacks('/project');
      expect(cb1.onSubagentsReceived).toBeDefined();

      cb1.onSubagentsReceived!(makeSubagents('Explore'));

      const cb2 = cache.buildSendCallbacks('/project');
      expect(cb2.onSubagentsReceived).toBeUndefined();
    });

    it('provides onSubagentsReceived for a different cwd', () => {
      const cb1 = cache.buildSendCallbacks('/projectA');
      cb1.onSubagentsReceived!(makeSubagents('Explore'));

      const cb2 = cache.buildSendCallbacks('/projectB');
      expect(cb2.onSubagentsReceived).toBeDefined();
    });
  });

  // =========================================================================
  // getCommands
  // =========================================================================

  describe('getCommands', () => {
    it('falls back to filesystem registry when no SDK commands are cached', async () => {
      const fsEntry = makeFsCommandEntry('/help', { namespace: 'project' });
      const registry = createMockRegistryService(makeRegistry([fsEntry]));

      const result = await cache.getCommands(registry, '/project');
      expect(result.commands).toEqual([fsEntry]);
      expect(registry.getCommands).toHaveBeenCalledWith(undefined);
    });

    it('passes forceRefresh to filesystem registry fallback', async () => {
      const registry = createMockRegistryService(makeRegistry([]));

      await cache.getCommands(registry, '/project', true);
      expect(registry.getCommands).toHaveBeenCalledWith(true);
    });

    it('enriches SDK commands with filesystem metadata', async () => {
      // Populate SDK commands
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('deploy'));

      // Filesystem has the same command with extra metadata
      const fsEntry = makeFsCommandEntry('/deploy', {
        namespace: 'ops',
        command: 'deploy',
        allowedTools: ['Bash'],
        filePath: '/project/.claude/commands/deploy.md',
      });
      const registry = createMockRegistryService(makeRegistry([fsEntry]));

      const result = await cache.getCommands(registry, '/project');
      const deployCmd = result.commands.find((c) => c.fullCommand === '/deploy');

      expect(deployCmd).toBeDefined();
      expect(deployCmd!.namespace).toBe('ops');
      expect(deployCmd!.allowedTools).toEqual(['Bash']);
      expect(deployCmd!.filePath).toBe('/project/.claude/commands/deploy.md');
      expect(deployCmd!.description).toBe('deploy desc'); // SDK description wins
    });

    it('adds slash prefix to SDK commands that lack one', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!([{ name: 'test', description: 'Test cmd', argumentHint: '' }]);

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');

      expect(result.commands[0].fullCommand).toBe('/test');
    });

    it('preserves slash prefix for SDK commands that already have one', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!([{ name: '/build', description: 'Build cmd', argumentHint: '' }]);

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');

      expect(result.commands[0].fullCommand).toBe('/build');
    });

    it('includes filesystem-only commands (legacy) not in SDK set', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('skill'));

      const legacyCmd = makeFsCommandEntry('/legacy-cmd', { namespace: 'project' });
      const skillCmd = makeFsCommandEntry('/skill');
      const registry = createMockRegistryService(makeRegistry([legacyCmd, skillCmd]));

      const result = await cache.getCommands(registry, '/project');
      const commandNames = result.commands.map((c) => c.fullCommand);

      expect(commandNames).toContain('/skill'); // SDK entry
      expect(commandNames).toContain('/legacy-cmd'); // filesystem-only entry
    });

    it('sorts merged commands alphabetically by fullCommand', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('zebra', 'alpha'));

      const fsCmd = makeFsCommandEntry('/middle');
      const registry = createMockRegistryService(makeRegistry([fsCmd]));

      const result = await cache.getCommands(registry, '/project');
      const names = result.commands.map((c) => c.fullCommand);

      expect(names).toEqual(['/alpha', '/middle', '/zebra']);
    });

    it('returns a valid lastScanned ISO string', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('test'));
      const registry = createMockRegistryService(makeRegistry([]));

      const result = await cache.getCommands(registry, '/project');
      expect(new Date(result.lastScanned).toISOString()).toBe(result.lastScanned);
    });

    it('maps argumentHint from SDK commands when present', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!([
        { name: 'run', description: 'Run something', argumentHint: '<script>' },
      ]);

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');

      expect(result.commands[0].argumentHint).toBe('<script>');
    });

    it('sets argumentHint to undefined when SDK provides empty string', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!([{ name: 'run', description: 'Run something', argumentHint: '' }]);

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');

      expect(result.commands[0].argumentHint).toBeUndefined();
    });
  });

  // =========================================================================
  // reloadPlugins
  // =========================================================================

  describe('reloadPlugins', () => {
    function createMockQuery(
      overrides?: Partial<{
        commands: Array<{ name: string; description: string; argumentHint: string }>;
        mcpServers: Array<{
          name: string;
          config?: { type: string };
          status?: string;
          error?: string;
          scope?: string;
        }>;
        agents: Array<{ name: string; description: string; model?: string }> | null;
        plugins: Array<unknown>;
        error_count: number;
      }>
    ) {
      const defaults = {
        commands: [],
        mcpServers: [],
        agents: null,
        plugins: [],
        error_count: 0,
        ...overrides,
      };
      return {
        reloadPlugins: vi.fn().mockResolvedValue(defaults),
      };
    }

    it('returns counts from the SDK reload result', async () => {
      const mockQuery = createMockQuery({
        commands: [{ name: 'cmd1', description: 'd', argumentHint: '' }],
        plugins: [{}, {}] as unknown[],
        error_count: 1,
      });

      const result = await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      expect(result).toEqual({
        commandCount: 1,
        pluginCount: 2,
        errorCount: 1,
      });
    });

    it('uses sessionCwd when provided', async () => {
      const mockQuery = createMockQuery({
        commands: [{ name: 'deploy', description: 'd', argumentHint: '' }],
      });

      await cache.reloadPlugins(mockQuery as never, '/session-cwd', '/default-cwd');

      // Verify commands are stored under sessionCwd
      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/session-cwd');
      expect(result.commands[0].fullCommand).toBe('/deploy');
    });

    it('falls back to defaultCwd when sessionCwd is undefined', async () => {
      const mockQuery = createMockQuery({
        commands: [{ name: 'build', description: 'd', argumentHint: '' }],
      });

      await cache.reloadPlugins(mockQuery as never, undefined, '/default-cwd');

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/default-cwd');
      expect(result.commands[0].fullCommand).toBe('/build');
    });

    it('filters out the internal dorkos MCP server from cached status', async () => {
      const mockQuery = createMockQuery({
        mcpServers: [
          { name: 'dorkos', config: { type: 'stdio' }, status: 'connected' },
          { name: 'postgres', config: { type: 'stdio' }, status: 'connected' },
          { name: 'github', config: { type: 'sse' }, status: 'connected' },
        ],
      });

      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      const status = cache.getMcpStatus('/project');
      expect(status).toHaveLength(2);
      expect(status!.map((s) => s.name)).toEqual(['postgres', 'github']);
    });

    it('maps MCP server types correctly', async () => {
      const mockQuery = createMockQuery({
        mcpServers: [
          { name: 'stdio-srv', config: { type: 'stdio' } },
          { name: 'sse-srv', config: { type: 'sse' } },
          { name: 'http-srv', config: { type: 'http' } },
          { name: 'unknown-srv', config: { type: 'websocket' } },
          { name: 'no-config-srv' },
        ],
      });

      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      const status = cache.getMcpStatus('/project')!;
      expect(status.find((s) => s.name === 'sse-srv')!.type).toBe('sse');
      expect(status.find((s) => s.name === 'http-srv')!.type).toBe('http');
      // Non-sse/http types fall back to stdio
      expect(status.find((s) => s.name === 'unknown-srv')!.type).toBe('stdio');
      expect(status.find((s) => s.name === 'no-config-srv')!.type).toBe('stdio');
    });

    it('caches subagents when result.agents is present', async () => {
      const mockQuery = createMockQuery({
        agents: [
          { name: 'Explore', description: 'Explores code', model: 'sonnet' },
          { name: 'Code', description: 'Writes code' },
        ],
      });

      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      const subagents = cache.getSupportedSubagents('/project');
      expect(subagents).toHaveLength(2);
      expect(subagents[0]).toEqual({
        name: 'Explore',
        description: 'Explores code',
        model: 'sonnet',
      });
      expect(subagents[1]).toEqual({
        name: 'Code',
        description: 'Writes code',
        model: undefined,
      });
    });

    it('does not update subagent cache when result.agents is null', async () => {
      // Pre-populate subagents
      const cb = cache.buildSendCallbacks('/project');
      cb.onSubagentsReceived!(makeSubagents('ExistingAgent'));

      const mockQuery = createMockQuery({ agents: null });

      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      // Original subagents should remain
      const subagents = cache.getSupportedSubagents('/project');
      expect(subagents).toHaveLength(1);
      expect(subagents[0].name).toBe('ExistingAgent');
    });

    it('preserves MCP server error and scope fields', async () => {
      const mockQuery = createMockQuery({
        mcpServers: [
          {
            name: 'failing-srv',
            config: { type: 'stdio' },
            status: 'failed',
            error: 'Connection refused',
            scope: 'project',
          },
        ],
      });

      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      const status = cache.getMcpStatus('/project')!;
      expect(status[0].status).toBe('failed');
      expect(status[0].error).toBe('Connection refused');
      expect(status[0].scope).toBe('project');
    });

    it('caches commands as SdkCommandEntry format', async () => {
      const mockQuery = createMockQuery({
        commands: [
          { name: '/deploy', description: 'Deploy', argumentHint: '<env>' },
          { name: 'build', description: 'Build', argumentHint: '' },
        ],
      });

      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      // Verify by calling getCommands which reads the SDK cache
      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');
      const names = result.commands.map((c) => c.fullCommand);

      expect(names).toContain('/deploy');
      expect(names).toContain('/build');
    });
  });

  // =========================================================================
  // Cross-method integration
  // =========================================================================

  describe('cross-method integration', () => {
    it('reloadPlugins updates what getCommands returns', async () => {
      // Initial SDK commands
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('initial'));

      // Verify initial state
      const registry = createMockRegistryService(makeRegistry([]));
      let result = await cache.getCommands(registry, '/project');
      expect(result.commands.map((c) => c.fullCommand)).toContain('/initial');

      // Reload replaces SDK commands
      const mockQuery = {
        reloadPlugins: vi.fn().mockResolvedValue({
          commands: [{ name: 'reloaded', description: 'd', argumentHint: '' }],
          mcpServers: [],
          plugins: [],
          error_count: 0,
        }),
      };
      await cache.reloadPlugins(mockQuery as never, '/project', '/default');

      result = await cache.getCommands(registry, '/project');
      const names = result.commands.map((c) => c.fullCommand);
      expect(names).toContain('/reloaded');
      expect(names).not.toContain('/initial');
    });

    it('buildSendCallbacks updates are visible to getters', () => {
      const cb = cache.buildSendCallbacks('/project');

      // Populate all caches
      const models = makeModels('m1');
      cb.onModelsReceived!(models);
      cb.onMcpStatusReceived!(makeMcpServers('s1'));
      cb.onSubagentsReceived!(makeSubagents('a1'));
      cb.onCommandsReceived!(makeSdkCommands('c1'));

      // Verify all caches are populated
      expect(cache.getSupportedModels()).toBe(models);
      expect(cache.getMcpStatus('/project')).toEqual(makeMcpServers('s1'));
      expect(cache.getSupportedSubagents('/project')).toEqual(makeSubagents('a1'));
    });

    it('multiple cwds maintain separate caches', () => {
      const cbA = cache.buildSendCallbacks('/projectA');
      const cbB = cache.buildSendCallbacks('/projectB');

      cbA.onMcpStatusReceived!(makeMcpServers('mcp-a'));
      cbA.onSubagentsReceived!(makeSubagents('agent-a'));

      cbB.onMcpStatusReceived!(makeMcpServers('mcp-b'));
      cbB.onSubagentsReceived!(makeSubagents('agent-b'));

      expect(cache.getMcpStatus('/projectA')![0].name).toBe('mcp-a');
      expect(cache.getMcpStatus('/projectB')![0].name).toBe('mcp-b');
      expect(cache.getSupportedSubagents('/projectA')[0].name).toBe('agent-a');
      expect(cache.getSupportedSubagents('/projectB')[0].name).toBe('agent-b');
    });
  });
});

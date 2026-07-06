import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ModelOption,
  SubagentInfo,
  CommandRegistry,
  CommandEntry,
} from '@dorkos/shared/types';
import type { McpServerEntry } from '@dorkos/shared/transport';
import type { SdkCommandEntry } from '../messaging/message-sender.js';
import type { CommandRegistryService } from '../tooling/command-registry.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
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

import { RuntimeCache, mapSdkModelToModelOption } from '../messaging/runtime-cache.js';

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
    cache = new RuntimeCache(
      `/tmp/dorkos-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
  });

  // =========================================================================
  // getSupportedModels
  // =========================================================================

  describe('getSupportedModels', () => {
    it('returns empty array when nothing is cached', async () => {
      const result = await cache.getSupportedModels();
      expect(result).toEqual([]);
    });

    it('returns cached models after buildSendCallbacks populates them', async () => {
      const custom = makeModels('custom-model');
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!(custom);

      const result = await cache.getSupportedModels();
      expect(result).toHaveLength(1);
      // buildSendCallbacks now maps through mapSdkModelToModelOption, adding provider/family/tier
      expect(result[0]).toMatchObject({ value: 'custom-model', provider: 'anthropic' });
    });
  });

  // =========================================================================
  // mapSdkModelToModelOption
  // =========================================================================

  describe('mapSdkModelToModelOption', () => {
    it.each([
      ['claude-fable-5', 'flagship'],
      ['claude-opus-4-8', 'flagship'],
      ['claude-sonnet-4-6', 'balanced'],
      ['claude-haiku-4-5-20251001', 'fast'],
    ] as const)('infers tier for %s as %s', (value, tier) => {
      const option = mapSdkModelToModelOption({ value, displayName: value, description: '' });
      expect(option.tier).toBe(tier);
    });

    it('leaves tier undefined for unrecognized model names', () => {
      const option = mapSdkModelToModelOption({
        value: 'mystery-model',
        displayName: 'Mystery',
        description: '',
      });
      expect(option.tier).toBeUndefined();
    });
  });

  // =========================================================================
  // getCachedModel
  // =========================================================================

  describe('getCachedModel', () => {
    it('returns undefined when the value is undefined', () => {
      expect(cache.getCachedModel(undefined)).toBeUndefined();
    });

    it('returns undefined when nothing is cached', () => {
      expect(cache.getCachedModel('claude-opus-4-8')).toBeUndefined();
    });

    it('returns the matching cached model with its capability flags', () => {
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!([
        { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'd' },
        {
          value: 'claude-haiku-4-5',
          displayName: 'Haiku 4.5',
          description: 'd',
          supportsAdaptiveThinking: false,
        },
      ]);

      const opus = cache.getCachedModel('claude-opus-4-8');
      expect(opus).toMatchObject({ value: 'claude-opus-4-8' });
      expect(cache.getCachedModel('claude-haiku-4-5')).toMatchObject({
        value: 'claude-haiku-4-5',
        supportsAdaptiveThinking: false,
      });
    });

    it('returns undefined for an unknown model value', () => {
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!([
        { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'd' },
      ]);

      expect(cache.getCachedModel('claude-sonnet-4-6')).toBeUndefined();
    });
  });

  // =========================================================================
  // resolveModelCapability
  // =========================================================================

  describe('resolveModelCapability', () => {
    beforeEach(() => {
      // The SDK reports capabilities on alias entries, not full IDs.
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!([
        {
          value: 'default',
          displayName: 'Default',
          description: 'd',
          supportsAdaptiveThinking: true,
        },
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: 'd',
          supportsAdaptiveThinking: true,
        },
        {
          value: 'haiku',
          displayName: 'Haiku',
          description: 'd',
          supportsAdaptiveThinking: false,
        },
      ]);
    });

    it('resolves an unset model to the "default" alias (covers the common Opus 4.8 case)', () => {
      // Purpose: an unset selection runs the default model (Opus 4.8 here), which needs
      // the omitted-thinking fix — so capability must resolve to the default alias.
      expect(cache.resolveModelCapability(undefined)).toMatchObject({
        value: 'default',
        supportsAdaptiveThinking: true,
      });
    });

    it('resolves an explicitly-selected alias to its own entry', () => {
      expect(cache.resolveModelCapability('haiku')).toMatchObject({
        value: 'haiku',
        supportsAdaptiveThinking: false,
      });
    });

    it('returns undefined for an explicitly-set unknown model (no default borrowing)', () => {
      // Purpose: borrowing the default's adaptive=true for an unknown/non-adaptive
      // model would risk forcing adaptive thinking and a 400 — stay conservative.
      expect(cache.resolveModelCapability('claude-opus-4-5')).toBeUndefined();
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

    it('always provides onModelsReceived (refreshes every time)', () => {
      const cb1 = cache.buildSendCallbacks('/project');
      cb1.onModelsReceived!(makeModels('m'));

      const cb2 = cache.buildSendCallbacks('/project');
      expect(cb2.onModelsReceived).toBeDefined();
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

    // Palette dedupe (ADR 260706-192819): a project-scoped plugin command reaches
    // the SDK cache (global install) AND the filesystem scan (projected wrapper).
    // The merge must collapse them to ONE entry with the SDK entry winning.
    it('dedupes a namespaced command present in BOTH the SDK cache and the filesystem (SDK wins)', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('flow:capture'));

      // The projected wrapper shows up in the filesystem scan at the same name.
      const wrapper = makeFsCommandEntry('/flow:capture', {
        namespace: 'flow',
        command: 'capture',
        filePath: '.claude/commands/flow/capture.md',
      });
      const registry = createMockRegistryService(makeRegistry([wrapper]));

      const result = await cache.getCommands(registry, '/project');
      const matches = result.commands.filter((c) => c.fullCommand === '/flow:capture');

      expect(matches).toHaveLength(1); // not duplicated
      expect(matches[0].description).toBe('flow:capture desc'); // SDK entry won
      expect(matches[0].namespace).toBe('flow'); // enriched with filesystem metadata
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

    it('propagates SDK command aliases into the merged CommandEntry (DOR-108)', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!([
        { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost', 'stats'] },
      ]);

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');
      const usageCmd = result.commands.find((c) => c.fullCommand === '/usage');

      expect(usageCmd?.aliases).toEqual(['cost', 'stats']);
    });

    it('omits the aliases field when the SDK command has none', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('plain'));

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');

      expect(result.commands[0]).not.toHaveProperty('aliases');
    });

    it('preserves aliases through filesystem-metadata enrichment', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!([
        { name: 'usage', description: 'Show usage', argumentHint: '', aliases: ['cost'] },
      ]);

      const fsEntry = makeFsCommandEntry('/usage', {
        namespace: 'builtin',
        filePath: '/project/.claude/commands/usage.md',
      });
      const registry = createMockRegistryService(makeRegistry([fsEntry]));

      const result = await cache.getCommands(registry, '/project');
      const usageCmd = result.commands.find((c) => c.fullCommand === '/usage');

      expect(usageCmd?.aliases).toEqual(['cost']); // alias survives the fs merge
      expect(usageCmd?.namespace).toBe('builtin'); // and fs metadata still attaches
    });
  });

  // =========================================================================
  // replaceSdkCommands / commands_changed (DOR-108)
  // =========================================================================

  describe('replaceSdkCommands', () => {
    it('marks a cwd as having SDK commands once replaced', () => {
      expect(cache.hasSdkCommands('/project')).toBe(false);
      cache.replaceSdkCommands('/project', makeSdkCommands('one'));
      expect(cache.hasSdkCommands('/project')).toBe(true);
    });

    it('replaces the cached list wholesale (not merge) so /api/commands stays fresh', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('old-a', 'old-b'));

      cache.replaceSdkCommands('/project', makeSdkCommands('new-only'));

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');
      const names = result.commands.map((c) => c.fullCommand);

      expect(names).toEqual(['/new-only']); // old entries gone, replaced wholesale
    });

    it('exposes onCommandsChanged that replaces the cache on every call (unguarded)', async () => {
      const cb = cache.buildSendCallbacks('/project');
      expect(cb.onCommandsChanged).toBeDefined();

      cb.onCommandsChanged!(makeSdkCommands('first'));
      cb.onCommandsChanged!([
        { name: 'second', description: 'Second', argumentHint: '', aliases: ['two'] },
      ]);

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');

      expect(result.commands.map((c) => c.fullCommand)).toEqual(['/second']);
      expect(result.commands[0].aliases).toEqual(['two']);
    });
  });

  // =========================================================================
  // Provisional (warm-probe) command cache (finding #4)
  // =========================================================================

  describe('provisional SDK commands (warm-probe cache)', () => {
    it('marks a cwd provisional when replaced with { provisional: true }', () => {
      expect(cache.isSdkCommandsProvisional('/project')).toBe(false);
      cache.replaceSdkCommands('/project', makeSdkCommands('flow:capture'), { provisional: true });
      // Populated for the palette immediately, but flagged as not authoritative.
      expect(cache.hasSdkCommands('/project')).toBe(true);
      expect(cache.isSdkCommandsProvisional('/project')).toBe(true);
    });

    it('still fires onCommandsReceived on the first real message after a warm write', () => {
      // Warm probe populated a partial (MCP-less) list…
      cache.replaceSdkCommands('/project', makeSdkCommands('flow:capture'), { provisional: true });

      // …so the guard must NOT suppress the authoritative fetch: onCommandsReceived
      // fires even though hasSdkCommands() is already true.
      const cb = cache.buildSendCallbacks('/project');
      expect(cb.onCommandsReceived).toBeDefined();
    });

    it('a real onCommandsReceived write clears the provisional flag and stops re-fetching', async () => {
      cache.replaceSdkCommands('/project', makeSdkCommands('flow:capture'), { provisional: true });

      // First real message overwrites with the full (MCP-inclusive) set.
      const cb1 = cache.buildSendCallbacks('/project');
      cb1.onCommandsReceived!([
        { name: '/flow:capture', description: 'Capture', argumentHint: '' },
        { name: '/mcp__dorkos__ping', description: 'Ping', argumentHint: '' },
      ]);

      // Provisional flag is cleared…
      expect(cache.isSdkCommandsProvisional('/project')).toBe(false);
      // …the MCP command is now present…
      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');
      expect(result.commands.map((c) => c.fullCommand)).toContain('/mcp__dorkos__ping');
      // …and a subsequent message does NOT re-fetch (guard is closed again).
      const cb2 = cache.buildSendCallbacks('/project');
      expect(cb2.onCommandsReceived).toBeUndefined();
    });

    it('an authoritative replace (no opts) also clears a prior provisional flag', () => {
      cache.replaceSdkCommands('/project', makeSdkCommands('flow:capture'), { provisional: true });
      expect(cache.isSdkCommandsProvisional('/project')).toBe(true);

      // e.g. a commands_changed push (onCommandsChanged) is authoritative.
      cache.replaceSdkCommands('/project', makeSdkCommands('flow:capture', 'flow:triage'));
      expect(cache.isSdkCommandsProvisional('/project')).toBe(false);
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

    it('buildSendCallbacks updates are visible to getters', async () => {
      const cb = cache.buildSendCallbacks('/project');

      // Populate all caches
      const models = makeModels('m1');
      cb.onModelsReceived!(models);
      cb.onMcpStatusReceived!(makeMcpServers('s1'));
      cb.onSubagentsReceived!(makeSubagents('a1'));
      cb.onCommandsReceived!(makeSdkCommands('c1'));

      // Verify all caches are populated
      expect(await cache.getSupportedModels()).toHaveLength(1);
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

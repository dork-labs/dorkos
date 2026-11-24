import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelOption, CommandRegistry, CommandEntry } from '@dorkos/shared/types';
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
import { CLAUDE_SDK_VERSION } from '../tooling/provision.js';
import {
  ControlRequestTimeoutError,
  LAUNCH_PROBE_ACK_TIMEOUT_MS,
  PLUGIN_RELOAD_ACK_TIMEOUT_MS,
} from '../sessions/bounded-control.js';

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

  it('projects explicit auth/privacy env for a warmup with no Connections', async () => {
    vi.stubEnv('MCP_API_KEY', 'synthetic-server-token');
    vi.stubEnv('NANGO_ENCRYPTION_KEY', 'synthetic-nango-key');
    vi.stubEnv('DO_NOT_TRACK', '1');
    const close = vi.fn();
    vi.mocked(query).mockReturnValue({ supportedModels: async () => [], close } as never);
    try {
      await cache.warmup('/synthetic/project');
      const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
      expect(options?.env).toBeDefined();
      expect(options?.env?.DO_NOT_TRACK).toBe('1');
      expect(options?.env).not.toHaveProperty('MCP_API_KEY');
      expect(options?.env).not.toHaveProperty('NANGO_ENCRYPTION_KEY');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('warms up on the person’s own settings, never the default folder’s project ones (DOR-4409)', async () => {
    // A repo's settings, hooks and `.mcp.json` servers wait for a person's
    // review before they run (DOR-3298). The model-list probe starts the CLI in
    // the default folder with no such check, so it may load only user settings.
    vi.mocked(query).mockReturnValue({ supportedModels: async () => [], close: vi.fn() } as never);
    await cache.warmup('/synthetic/kestrel-project');
    const options = vi.mocked(query).mock.calls.at(-1)?.[0].options;
    expect(options?.cwd).toBe('/synthetic/kestrel-project');
    expect(options?.settingSources).toEqual(['user']);
  });

  // =========================================================================
  // Disk cache — the SDK re-pin gate (DOR-1672)
  // =========================================================================

  describe('disk cache', () => {
    let dorkHome: string;

    /** Where the constructor puts a claude-code cache under a dork home. */
    const cacheFileIn = (home: string) =>
      path.join(home, 'cache', 'runtimes', 'claude-code', 'models.json');

    /**
     * One persisted row, carrying the capability claims that make this gate
     * necessary — `supportsVision` is DorkOS's assertion about a model line,
     * not an SDK echo, so a row written under one pin can outlive the pin that
     * justified it.
     */
    const OPUS: ModelOption = {
      value: 'claude-opus-4-8',
      displayName: 'Opus',
      description: 'the big one',
      supportsToolUse: true,
      supportsVision: true,
    };

    /** Write a disk cache by hand, so each test differs by exactly one field. */
    function writeDiskCache(fields: { sdkVersion: string; fetchedAt: string }): void {
      const file = cacheFileIn(dorkHome);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          models: [OPUS],
          fetchedAt: fields.fetchedAt,
          sdkVersion: fields.sdkVersion,
          version: 1,
        }),
        'utf-8'
      );
    }

    beforeEach(() => {
      dorkHome = mkdtempSync(path.join(tmpdir(), 'dorkos-runtime-cache-'));
    });

    afterEach(() => {
      rmSync(dorkHome, { recursive: true, force: true });
    });

    it('serves a cache written by the SDK pin it is running, inside the TTL', async () => {
      writeDiskCache({ sdkVersion: CLAUDE_SDK_VERSION, fetchedAt: new Date().toISOString() });

      const cold = new RuntimeCache(dorkHome);

      expect(await cold.getSupportedModels()).toEqual([OPUS]);
      expect(cold.getCachedModel('claude-opus-4-8')?.supportsVision).toBe(true);
    });

    it('refuses a cache written by a different SDK pin, however fresh it is', async () => {
      // Same fixture as the test above but for the version string, so what is
      // measured here is the version match and nothing else. Without it, a
      // re-pin that corrects a capability claim would keep serving the old
      // claim for up to a TTL (DOR-1672 review).
      writeDiskCache({ sdkVersion: '0.3.100', fetchedAt: new Date().toISOString() });

      const cold = new RuntimeCache(dorkHome);

      // No default cwd is set, so there is no lazy warm-up to fall through to:
      // anything returned here could only have come off disk.
      expect(await cold.getSupportedModels()).toEqual([]);
      expect(cold.getCachedModel('claude-opus-4-8')).toBeUndefined();
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

    // ---- Capability flags are DorkOS's claims, not the SDK's (DOR-1672) ----

    it('states what every Claude model can do, in real booleans', () => {
      // `ModelInfo` reports nothing capability-shaped, so these three are static
      // claims the mapper makes: the Agent SDK only lists models it can drive
      // through a tool loop, and the Messages API has no image-output modality.
      // Deleting `...CLAUDE_MODEL_CAPABILITIES` from the mapper makes this red.
      const option = mapSdkModelToModelOption({
        value: 'claude-opus-4-8',
        displayName: 'Opus',
        description: '',
      });
      expect(option.supportsToolUse).toBe(true);
      expect(option.supportsVision).toBe(true);
      expect(option.supportsImageOutput).toBe(false);
    });

    it('claims vision only for a family DorkOS has verified, never for a stranger id', () => {
      // The tool-use and image-output claims are structural (true of anything
      // this SDK can drive); vision is a claim about verified model LINES. An
      // id outside the inferTier vocabulary — a future line the SDK starts
      // listing — must get the honest absence, not an inherited true
      // (DOR-1672 review).
      const option = mapSdkModelToModelOption({
        value: 'claude-mythos-preview',
        displayName: 'Mythos',
        description: '',
      });
      expect(option.supportsToolUse).toBe(true);
      expect(option.supportsImageOutput).toBe(false);
      expect(option.supportsVision).toBeUndefined();
    });

    it('invents no context window the SDK never reported', () => {
      // The other half of the same honesty rule, and the half that is easier to
      // get wrong later: `ModelInfo` carries neither `contextWindow` nor
      // `maxOutputTokens`, and DorkOS has no defensible static value for either
      // (they differ per model and per account tier), so the mapper says
      // nothing rather than guessing. Every consumer reads absent as unknown —
      // `useSessionStatus` falls back to `null`, the picker hides its badge.
      //
      // If a future SDK starts reporting them, READ them here and delete this
      // test. Do not satisfy it with a hardcoded number.
      const option = mapSdkModelToModelOption({
        value: 'claude-opus-4-8',
        displayName: 'Opus',
        description: '',
      });
      expect(option.contextWindow).toBeUndefined();
      expect(option.maxOutputTokens).toBeUndefined();
    });
  });

  // =========================================================================
  // getCachedModel
  // =========================================================================

  describe('getCachedModel', () => {
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

    it('finds the alias row a persisted wire id expands to, via resolvedModel', () => {
      // Purpose: the SDK reports capabilities on ALIAS rows only. A session that
      // persisted the wire id `claude-sonnet-5` matched no row before 0.3.224 and
      // fell back to SDK defaults. Dropping the `resolvedModel` fallback in
      // `getCachedModel` makes this red.
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!([
        {
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-5',
          displayName: 'Sonnet',
          description: 'd',
          supportsAdaptiveThinking: true,
        },
      ]);

      expect(cache.getCachedModel('claude-sonnet-5')).toMatchObject({
        value: 'sonnet',
        supportsAdaptiveThinking: true,
      });
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

    it('resolves an explicit wire id to the alias row that expands to it', () => {
      // Purpose: `haiku` here reports adaptive=false. A session pinned to the wire
      // id must inherit THAT, not fall through to undefined and then to SDK
      // defaults which would allow adaptive thinking on a model without it.
      const callbacks = cache.buildSendCallbacks('/project');
      callbacks.onModelsReceived!([
        {
          value: 'haiku',
          resolvedModel: 'claude-haiku-5',
          displayName: 'Haiku',
          description: 'd',
          supportsAdaptiveThinking: false,
        },
      ]);

      expect(cache.resolveModelCapability('claude-haiku-5')).toMatchObject({
        value: 'haiku',
        supportsAdaptiveThinking: false,
      });
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
  });

  // =========================================================================
  // replaceSdkCommands / commands_changed (DOR-108)
  // =========================================================================

  describe('replaceSdkCommands', () => {
    it('replaces the cached list wholesale (not merge) so /api/commands stays fresh', async () => {
      const cb = cache.buildSendCallbacks('/project');
      cb.onCommandsReceived!(makeSdkCommands('old-a', 'old-b'));

      cache.replaceSdkCommands('/project', makeSdkCommands('new-only'));

      const registry = createMockRegistryService(makeRegistry([]));
      const result = await cache.getCommands(registry, '/project');
      const names = result.commands.map((c) => c.fullCommand);

      expect(names).toEqual(['/new-only']); // old entries gone, replaced wholesale
    });
  });

  // =========================================================================
  // Provisional (warm-probe) command cache (finding #4)
  // =========================================================================

  describe('provisional SDK commands (warm-probe cache)', () => {
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
        // A reload that never asked what it would cost was never held.
        held: false,
      });
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
  });

  // =========================================================================
  // Asking what a reload would cost (spec `plugin-reload-cache-cost`)
  // =========================================================================

  describe('reloadPlugins asks before it spends', () => {
    /** The response shape the CLI sends when it refuses to disturb the cache. */
    const heldResponse = {
      commands: [{ name: 'old', description: 'd', argumentHint: '' }],
      agents: null,
      plugins: [{}],
      mcpServers: [],
      error_count: 0,
      held: true,
      cache_impact: {
        mcp_servers_added: ['plugin:flow:linear'],
        mcp_servers_removed: [],
        lsp_tool_change: 'may-add',
      },
    };

    it('reports the hold and what applying would change', async () => {
      const mockQuery = { reloadPlugins: vi.fn().mockResolvedValue(heldResponse) };

      const outcome = await cache.reloadPlugins(mockQuery as never, '/project', '/default', {
        holdOnCacheImpact: true,
      });

      expect(outcome.held).toBe(true);
      expect(outcome.cacheImpact).toEqual({
        mcpServersAdded: ['plugin:flow:linear'],
        mcpServersRemoved: [],
        lspToolChange: 'may-add',
      });
    });
  });

  // =========================================================================
  // Bounded control requests (DOR-1301)
  // =========================================================================

  describe('control requests are bounded (DOR-1301)', () => {
    /** A query that hears nothing — the SDK's answer on an ended stdin. */
    const deafQuery = () => ({
      reloadPlugins: vi.fn(() => new Promise<never>(() => {})),
      supportedModels: vi.fn(() => new Promise<never>(() => {})),
      close: vi.fn(),
    });

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives up on a plugin reload the CLI never answers, instead of waiting for ever', async () => {
      const mockQuery = deafQuery();

      const reloading = cache.reloadPlugins(mockQuery as never, '/project', '/default');
      const settled = reloading.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(PLUGIN_RELOAD_ACK_TIMEOUT_MS);

      expect(await settled).toBeInstanceOf(ControlRequestTimeoutError);
      // Nothing was learned, so nothing is cached as if it had been.
      expect(cache.getMcpStatus('/project')).toBeNull();
    });

    it('abandons a warm-up whose model probe never answers, closing the process it started', async () => {
      const mockQuery = deafQuery();
      vi.mocked(query).mockReturnValue(mockQuery as never);
      cache.setDefaultCwd('/project');

      const warming = cache.warmup('/project');
      await vi.advanceTimersByTimeAsync(LAUNCH_PROBE_ACK_TIMEOUT_MS);
      await expect(warming).resolves.toBeUndefined();

      expect(mockQuery.close).toHaveBeenCalledTimes(1);
    });
  });
});

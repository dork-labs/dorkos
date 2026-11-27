/**
 * The context builder's blocks that read no feature flag or config, tested
 * against the real modules (the gated blocks stay in `../context-builder.test.ts`,
 * which mocks the flags).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  renderContextEntry,
  _buildMarketplaceToolsBlock,
  _buildPeerAgentsBlock,
  _buildRelayConnectionsBlock,
} from '../../../runtimes/claude-code/messaging/context-builder.js';
import type { RelayContextDeps } from '../../../runtimes/claude-code/messaging/context-builder.js';
import type { GitStatusData } from '@dorkos/shared/additional-context';
import { PageQuerySchema } from '@dorkos/shared/paging';
import { setRelayEnabled } from '../../../relay/relay-state.js';
// The real Zod input shapes the marketplace tools are registered with — imported
// (not re-typed) so the signature-pin test below diffs against the schema itself,
// not a second hand-written copy of it that could drift the same way the prose did.
import { SearchInputSchema } from '../../../marketplace-mcp/tool-search.js';
import { GetInputSchema } from '../../../marketplace-mcp/tool-get.js';
import { ListInstalledInputSchema } from '../../../marketplace-mcp/tool-list-installed.js';
import { RecommendInputSchema } from '../../../marketplace-mcp/tool-recommend.js';
import { InstallInputSchema } from '../../../marketplace-mcp/tool-install.js';
import { UpdateInputSchema } from '../../../marketplace-mcp/tool-update.js';
import { UninstallInputSchema } from '../../../marketplace-mcp/tool-uninstall.js';
import { CreatePackageInputSchema } from '../../../marketplace-mcp/tool-create-package.js';

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

    // marketplace_list_marketplaces takes the shared page query (DOR-4982).
    expect(documentedParams(result, 'marketplace_list_marketplaces').sort()).toEqual(
      Object.keys(PageQuerySchema.shape).sort()
    );
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

  // DOR-2790: chat_send refuses a chat that is not an agent's.
  it('tells only an agent session how to message a peer', async () => {
    const mockMesh = makeMockMesh(() => [{ id: 'a1', name: 'api-bot', projectPath: '/p' }]);
    const plain = await _buildPeerAgentsBlock(mockMesh, false);
    expect(plain).toContain('<peer_agents>');
    expect(plain).toContain('api-bot (/p)');
    expect(plain).not.toContain('chat_send');
    expect(await _buildPeerAgentsBlock(mockMesh, true)).toContain('chat_send(to=<their agent id>');
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

  const allOnToolConfig = {
    tasks: true,
    messages: true,
    relay: true,
    mesh: true,
    adapter: true,
    packages: true,
  };

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
    setRelayEnabled(false);
    try {
      expect(_buildRelayConnectionsBlock(makeRelayContext())).toBe('');
    } finally {
      setRelayEnabled(true);
    }
  });
});

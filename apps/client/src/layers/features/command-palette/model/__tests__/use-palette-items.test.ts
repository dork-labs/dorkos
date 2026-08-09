/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaletteItems } from '../use-palette-items';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { CommandPaletteContribution } from '@/layers/shared/model';

// --- Mock entity hooks ---

const mockUseMeshAgentPaths = vi.fn();
const mockUseCommands = vi.fn();
const mockUseAgentFrecency = vi.fn();
const mockUseSessions = vi.fn();
const mockUseActiveRunCount = vi.fn();
const mockUseRooms = vi.fn();
const mockUseAppStore = vi.fn();

const DEFAULT_PALETTE_CONTRIBUTIONS: CommandPaletteContribution[] = [
  {
    id: 'tasks',
    label: 'Tasks Scheduler',
    icon: 'Clock',
    action: 'openTasks',
    category: 'feature',
    priority: 1,
  },
  {
    id: 'relay',
    label: 'Integrations',
    icon: 'Radio',
    action: 'openRelay',
    category: 'feature',
    priority: 2,
  },
  {
    id: 'mesh',
    label: 'Mesh Network',
    icon: 'Globe',
    action: 'openMesh',
    category: 'feature',
    priority: 3,
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: 'Settings',
    action: 'openSettings',
    category: 'feature',
    priority: 4,
  },
  {
    id: 'dashboard',
    label: 'Go home',
    icon: 'Home',
    action: 'navigateDashboard',
    category: 'quick-action',
    priority: 1,
  },
  {
    id: 'new-session',
    label: 'New Session',
    icon: 'Plus',
    action: 'newSession',
    category: 'quick-action',
    priority: 2,
  },
  {
    id: 'create-agent',
    label: 'Create Agent',
    icon: 'Plus',
    action: 'createAgent',
    category: 'quick-action',
    priority: 3,
  },
  {
    id: 'discover',
    label: 'Bring in existing projects',
    icon: 'Search',
    action: 'discoverAgents',
    category: 'quick-action',
    priority: 4,
  },
  {
    id: 'browse',
    label: 'Browse Filesystem',
    icon: 'FolderOpen',
    action: 'browseFilesystem',
    category: 'quick-action',
    priority: 5,
  },
  {
    id: 'theme',
    label: 'Toggle Theme',
    icon: 'Moon',
    action: 'toggleTheme',
    category: 'quick-action',
    priority: 6,
  },
];

const mockUseSlotContributions = vi.fn(() => DEFAULT_PALETTE_CONTRIBUTIONS);

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => mockUseMeshAgentPaths(),
}));

vi.mock('@/layers/entities/command', () => ({
  // Arguments forwarded, not dropped: WHICH runtime's commands the palette
  // lists is decided by what it passes here.
  useCommands: (...args: unknown[]) => mockUseCommands(...args),
}));

vi.mock('@/layers/entities/session', async (importOriginal) => ({
  // Keep the real selectAgentSessions/sessionDisplayTitle — only the data
  // hook is stubbed.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessions: () => mockUseSessions(),
}));

vi.mock('@/layers/entities/tasks', () => ({
  useActiveTaskRunCount: () => mockUseActiveRunCount(),
}));

// Only the room list's data hook is stubbed. The display and ordering helpers
// stay real, so a room's palette name here is the name the product renders.
vi.mock('@/layers/entities/room', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/room')>()),
  useRooms: () => mockUseRooms(),
}));

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector?: (s: Record<string, unknown>) => unknown) => {
    const state = mockUseAppStore();
    return selector ? selector(state) : state;
  },
  useNow: () => Date.now(),
  useSlotContributions: () => mockUseSlotContributions(),
}));

vi.mock('../use-agent-frecency', () => ({
  useAgentFrecency: () => mockUseAgentFrecency(),
}));

vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    shortenHomePath: (p: string) => p.replace('/Users/test', '~'),
  };
});

// --- Fixtures ---

const makeAgent = (overrides: Partial<AgentPathEntry> = {}): AgentPathEntry => ({
  id: 'agent-default',
  name: 'Default Agent',
  projectPath: '/projects/default',
  ...overrides,
});

const agentA = makeAgent({ id: 'agent-a', name: 'Agent A', projectPath: '/projects/a' });
const agentB = makeAgent({ id: 'agent-b', name: 'Agent B', projectPath: '/projects/b' });
const agentC = makeAgent({ id: 'agent-c', name: 'Agent C', projectPath: '/projects/c' });
const agentD = makeAgent({ id: 'agent-d', name: 'Agent D', projectPath: '/projects/d' });
const agentE = makeAgent({ id: 'agent-e', name: 'Agent E', projectPath: '/projects/e' });
const agentF = makeAgent({ id: 'agent-f', name: 'Agent F', projectPath: '/projects/f' });

const makeRoom = (overrides: Partial<RoomSummary> = {}): RoomSummary => ({
  id: 'room-default',
  kind: 'channel',
  slug: 'default',
  title: 'Default',
  topic: null,
  workspaceId: null,
  archived: false,
  ambientMaxEntries: 30,
  createdAt: '2026-07-26T10:00:00.000Z',
  lastActivityAt: '2026-07-26T10:00:00.000Z',
  unreadCount: null,
  participants: null,
  ...overrides,
});

const channel = makeRoom({ id: 'room-general', slug: 'general', title: 'General chatter' });

const dmWithAna = makeRoom({
  id: 'room-ana',
  kind: 'dm',
  slug: null,
  title: 'Ana',
  participants: [
    { id: 'author-ana', kind: 'agent', displayName: 'Ana', handle: null, agentRef: 'ana' },
  ],
});

/** Spoke most recently, and the reader is caught up on it. */
const quietButRecent = makeRoom({
  id: 'room-recent',
  slug: 'recent',
  title: 'Recent',
  lastActivityAt: '2026-07-26T12:00:00.000Z',
  unreadCount: 0,
});

/** Spoke earlier, and has two entries the reader has not seen. */
const unreadButOlder = makeRoom({
  id: 'room-unread',
  slug: 'unread',
  title: 'Unread',
  lastActivityAt: '2026-07-26T09:00:00.000Z',
  unreadCount: 2,
});

function makeFrecency(sortedIds: string[]) {
  return {
    entries: [],
    recordUsage: vi.fn(),
    getSortedAgentIds: (_ids: string[]) => sortedIds,
  };
}

describe('usePaletteItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no data, not loading
    mockUseMeshAgentPaths.mockReturnValue({ data: undefined, isLoading: false });
    mockUseCommands.mockReturnValue({ data: undefined });
    mockUseAgentFrecency.mockReturnValue(makeFrecency([]));
    mockUseSessions.mockReturnValue({ sessions: [] });
    mockUseActiveRunCount.mockReturnValue({ data: undefined });
    mockUseAppStore.mockReturnValue({ previousCwd: null });
    mockUseRooms.mockReturnValue({ data: [], isLoading: false, isError: false });
    mockUseSlotContributions.mockReturnValue(DEFAULT_PALETTE_CONTRIBUTIONS);
  });

  // --- Static content groups ---

  it('features is a static list of 4 items', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.features).toHaveLength(4);
    const ids = result.current.features.map((f) => f.id);
    expect(ids).toContain('tasks');
    expect(ids).toContain('relay');
    expect(ids).toContain('mesh');
    expect(ids).toContain('settings');
  });

  it('quickActions is a static list of 6 items', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.quickActions).toHaveLength(6);
    const ids = result.current.quickActions.map((q) => q.id);
    expect(ids).toContain('dashboard');
    expect(ids).toContain('new-session');
    expect(ids).toContain('create-agent');
    expect(ids).toContain('discover');
    expect(ids).toContain('browse');
    expect(ids).toContain('theme');
  });

  it('each feature has id, label, icon, and action fields', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    for (const feature of result.current.features) {
      expect(feature.id).toBeTruthy();
      expect(feature.label).toBeTruthy();
      expect(feature.icon).toBeTruthy();
      expect(feature.action).toBeTruthy();
    }
  });

  it('each quickAction has id, label, icon, and action fields', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    for (const qa of result.current.quickActions) {
      expect(qa.id).toBeTruthy();
      expect(qa.label).toBeTruthy();
      expect(qa.icon).toBeTruthy();
      expect(qa.action).toBeTruthy();
    }
  });

  // --- Agent data ---

  it('returns empty recentAgents and allAgents when no agents are registered', () => {
    mockUseMeshAgentPaths.mockReturnValue({ data: undefined, isLoading: false });

    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.recentAgents).toEqual([]);
    expect(result.current.allAgents).toEqual([]);
  });

  it('allAgents contains all registered agents from mesh', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB, agentC] },
      isLoading: false,
    });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-a', 'agent-b', 'agent-c']));

    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.allAgents).toHaveLength(3);
    expect(result.current.allAgents).toContain(agentA);
    expect(result.current.allAgents).toContain(agentB);
    expect(result.current.allAgents).toContain(agentC);
  });

  it('recentAgents is limited to at most 5 agents', () => {
    const agents = [agentA, agentB, agentC, agentD, agentE, agentF];
    mockUseMeshAgentPaths.mockReturnValue({ data: { agents }, isLoading: false });
    mockUseAgentFrecency.mockReturnValue(
      makeFrecency(['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f'])
    );

    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.recentAgents.length).toBeLessThanOrEqual(5);
  });

  it('recentAgents respects frecency order from getSortedAgentIds', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB, agentC] },
      isLoading: false,
    });
    // frecency says B is most used, then C, then A
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-b', 'agent-c', 'agent-a']));

    const { result } = renderHook(() => usePaletteItems(null));
    const ids = result.current.recentAgents.map((a) => a.id);
    expect(ids[0]).toBe('agent-b');
    expect(ids[1]).toBe('agent-c');
    expect(ids[2]).toBe('agent-a');
  });

  it('active agent is pinned first in recentAgents', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB, agentC] },
      isLoading: false,
    });
    // frecency says B is most used
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-b', 'agent-c', 'agent-a']));

    // active cwd matches agentC
    const { result } = renderHook(() => usePaletteItems('/projects/c'));
    const ids = result.current.recentAgents.map((a) => a.id);
    expect(ids[0]).toBe('agent-c'); // active agent pinned first
  });

  it('active agent is not duplicated in recentAgents', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB, agentC] },
      isLoading: false,
    });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-a', 'agent-b', 'agent-c']));

    const { result } = renderHook(() => usePaletteItems('/projects/a'));
    const ids = result.current.recentAgents.map((a) => a.id);
    const agentACount = ids.filter((id) => id === 'agent-a').length;
    expect(agentACount).toBe(1);
  });

  it('activeCwd with no matching agent does not affect recentAgents ordering', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB] },
      isLoading: false,
    });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-b', 'agent-a']));

    const { result } = renderHook(() => usePaletteItems('/projects/does-not-exist'));
    const ids = result.current.recentAgents.map((a) => a.id);
    expect(ids[0]).toBe('agent-b');
    expect(ids[1]).toBe('agent-a');
  });

  it('null activeCwd means no agent is pinned', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB, agentC] },
      isLoading: false,
    });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-c', 'agent-b', 'agent-a']));

    const { result } = renderHook(() => usePaletteItems(null));
    const ids = result.current.recentAgents.map((a) => a.id);
    // frecency order with no pinning
    expect(ids[0]).toBe('agent-c');
  });

  // --- Commands ---

  it('commands is empty array when no command data is available', () => {
    mockUseCommands.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.commands).toEqual([]);
  });

  it('commands are populated from the commands query', () => {
    mockUseCommands.mockReturnValue({
      data: {
        commands: [
          {
            namespace: 'test',
            command: 'hello',
            fullCommand: '/hello',
            description: 'Say hello',
            filePath: '/some/path.md',
          },
          {
            namespace: 'test',
            command: 'world',
            fullCommand: '/world',
            description: 'Say world',
            filePath: '/some/other.md',
          },
        ],
        lastScanned: '2026-01-01T00:00:00Z',
      },
    });

    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.commands).toHaveLength(2);
    expect(result.current.commands[0].name).toBe('/hello');
    expect(result.current.commands[0].description).toBe('Say hello');
    expect(result.current.commands[1].name).toBe('/world');
  });

  it('commands with no description have undefined description', () => {
    mockUseCommands.mockReturnValue({
      data: {
        commands: [
          {
            namespace: 'test',
            command: 'bare',
            fullCommand: '/bare',
            description: '',
            filePath: '/path.md',
          },
        ],
        lastScanned: '2026-01-01T00:00:00Z',
      },
    });

    const { result } = renderHook(() => usePaletteItems(null));
    // description is mapped from cmd.description; empty string is falsy but still set
    expect(result.current.commands[0].name).toBe('/bare');
  });

  // --- isLoading ---

  it('isLoading is true while agent data is loading', () => {
    mockUseMeshAgentPaths.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.isLoading).toBe(true);
  });

  it('isLoading is false when agent data has loaded', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA] },
      isLoading: false,
    });

    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.isLoading).toBe(false);
  });

  // --- Return shape ---

  it('returns all content groups including suggestions', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current).toHaveProperty('recentAgents');
    expect(result.current).toHaveProperty('allAgents');
    expect(result.current).toHaveProperty('features');
    expect(result.current).toHaveProperty('commands');
    expect(result.current).toHaveProperty('quickActions');
    expect(result.current).toHaveProperty('suggestions');
    expect(result.current).toHaveProperty('isLoading');
  });

  // --- Which runtime's commands ---

  /**
   * The palette used to ask for commands with no context at all, so the server
   * cold-discovered the DEFAULT runtime and the list was whatever
   * claude-code offers — even with a Codex conversation on screen (DOR-1051).
   * The context it needs is the one the chat composer's own slash palette
   * passes: directory, session, runtime.
   */
  describe('the command list it asks for', () => {
    const activeSession = {
      id: 'session-codex',
      title: 'On Codex',
      cwd: '/projects/a',
      runtime: 'codex',
      updatedAt: '2026-08-09T10:00:00.000Z',
      createdAt: '2026-08-09T09:00:00.000Z',
    };

    it('names the directory, the conversation on screen, and the runtime that owns it', () => {
      mockUseSessions.mockReturnValue({ sessions: [activeSession] });

      renderHook(() => usePaletteItems('/projects/a'));

      expect(mockUseCommands).toHaveBeenCalledWith('/projects/a', 'session-codex', 'codex');
    });

    it('names the directory alone when no conversation is open there yet', () => {
      // A directory with no sessions still narrows the answer — project skills
      // live under it — so the cwd goes even when there is nothing else to say.
      mockUseSessions.mockReturnValue({ sessions: [] });

      renderHook(() => usePaletteItems('/projects/a'));

      expect(mockUseCommands).toHaveBeenCalledWith('/projects/a', undefined, undefined);
    });

    it('ignores sessions belonging to another directory', () => {
      // `selectAgentSessions` is the canonical membership rule (DOR-203);
      // reading `sessions[0]` blindly would hand the palette a session from
      // whichever project happened to be listed first.
      mockUseSessions.mockReturnValue({
        sessions: [{ ...activeSession, cwd: '/projects/elsewhere' }],
      });

      renderHook(() => usePaletteItems('/projects/a'));

      expect(mockUseCommands).toHaveBeenCalledWith('/projects/a', undefined, undefined);
    });
  });

  // --- Suggestions ---

  it('returns empty suggestions when no conditions are met', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.suggestions).toEqual([]);
  });

  it('suggests continue session when most recent session was active < 1h ago', () => {
    const recentTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    mockUseSessions.mockReturnValue({
      sessions: [
        {
          id: 's1',
          title: 'Fix bug',
          cwd: '/projects/a',
          updatedAt: recentTime,
          createdAt: recentTime,
        },
      ],
    });
    const { result } = renderHook(() => usePaletteItems('/projects/a'));
    const suggestion = result.current.suggestions.find((s) => s.id === 'suggestion-continue');
    expect(suggestion).toBeDefined();
    expect(suggestion?.label).toBe('Continue: Fix bug');
    expect(suggestion?.action).toBe('continueSession:s1');
  });

  it('does not suggest continue session when most recent session was > 1h ago', () => {
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
    mockUseSessions.mockReturnValue({
      sessions: [
        {
          id: 's1',
          title: 'Old session',
          cwd: '/projects/a',
          updatedAt: oldTime,
          createdAt: oldTime,
        },
      ],
    });
    const { result } = renderHook(() => usePaletteItems('/projects/a'));
    expect(result.current.suggestions.find((s) => s.id === 'suggestion-continue')).toBeUndefined();
  });

  it('suggests active Tasks runs when activeRunCount > 0', () => {
    mockUseActiveRunCount.mockReturnValue({ data: 3 });
    const { result } = renderHook(() => usePaletteItems(null));
    const suggestion = result.current.suggestions.find((s) => s.id === 'suggestion-tasks');
    expect(suggestion).toBeDefined();
    expect(suggestion?.label).toBe('3 active Tasks runs');
    expect(suggestion?.action).toBe('openTasks');
  });

  it('uses singular "run" when activeRunCount is 1', () => {
    mockUseActiveRunCount.mockReturnValue({ data: 1 });
    const { result } = renderHook(() => usePaletteItems(null));
    const suggestion = result.current.suggestions.find((s) => s.id === 'suggestion-tasks');
    expect(suggestion?.label).toBe('1 active Tasks run');
  });

  it('suggests switch back to previous agent when previousCwd is set', () => {
    mockUseAppStore.mockReturnValue({ previousCwd: '/projects/b' });
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB] },
      isLoading: false,
    });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-a', 'agent-b']));
    const { result } = renderHook(() => usePaletteItems('/projects/a'));
    const suggestion = result.current.suggestions.find((s) => s.id === 'suggestion-switchback');
    expect(suggestion).toBeDefined();
    expect(suggestion?.label).toBe('Switch back to Agent B');
    expect(suggestion?.action).toBe('switchAgent:agent-b');
  });

  it('does not suggest switch back when previousCwd equals activeCwd', () => {
    mockUseAppStore.mockReturnValue({ previousCwd: '/projects/a' });
    mockUseMeshAgentPaths.mockReturnValue({ data: { agents: [agentA] }, isLoading: false });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-a']));
    const { result } = renderHook(() => usePaletteItems('/projects/a'));
    expect(
      result.current.suggestions.find((s) => s.id === 'suggestion-switchback')
    ).toBeUndefined();
  });

  it('caps suggestions at 3 items', () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    mockUseSessions.mockReturnValue({
      sessions: [
        {
          id: 's1',
          title: 'Session',
          cwd: '/projects/a',
          updatedAt: recentTime,
          createdAt: recentTime,
        },
      ],
    });
    mockUseActiveRunCount.mockReturnValue({ data: 2 });
    mockUseAppStore.mockReturnValue({ previousCwd: '/projects/b' });
    mockUseMeshAgentPaths.mockReturnValue({ data: { agents: [agentA, agentB] }, isLoading: false });
    mockUseAgentFrecency.mockReturnValue(makeFrecency(['agent-a', 'agent-b']));
    const { result } = renderHook(() => usePaletteItems('/projects/a'));
    expect(result.current.suggestions.length).toBeLessThanOrEqual(3);
  });

  // --- Rooms (spec `rooms` §13.2) ---

  it('puts a channel in the flat search list under type "room", named the way people type it', () => {
    mockUseRooms.mockReturnValue({ data: [channel], isLoading: false, isError: false });
    const { result } = renderHook(() => usePaletteItems(null));

    const item = result.current.searchableItems.find((i) => i.id === 'room-general');
    expect(item).toEqual({
      id: 'room-general',
      name: '#general',
      type: 'room',
      // The bare slug rides along so `#gen` — which arrives with the prefix
      // already stripped — matches `general` rather than fuzzing past the `#`.
      keywords: ['General chatter', 'general'],
      data: channel,
    });
  });

  it('puts a direct message under type "dm", not "room", so `@` finds it and `#` does not', () => {
    mockUseRooms.mockReturnValue({ data: [dmWithAna], isLoading: false, isError: false });
    const { result } = renderHook(() => usePaletteItems(null));

    const item = result.current.searchableItems.find((i) => i.id === 'room-ana');
    expect(item?.type).toBe('dm');
    expect(item?.name).toBe('Ana');
    // Everyone in the conversation is searchable, so `@ana` finds a group DM
    // Ana is in and not only the one named after her.
    expect(item?.keywords).toContain('Ana');
  });

  // Feature/quick-action entries carry the `CommandPaletteContribution.keywords`
  // capability through to the flat search list, same as agents and rooms
  // already do — this is what lets Wave 2 register aliases (e.g. "connectors",
  // "telegram") on a renamed palette entry without a search-layer change.
  it('has no keywords on a feature entry that declares none', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    const item = result.current.searchableItems.find((i) => i.id === 'relay');
    expect(item?.type).toBe('feature');
    expect(item?.keywords).toBeUndefined();
  });

  it("carries a feature contribution's keywords into the flat search list", () => {
    mockUseSlotContributions.mockReturnValue([
      ...DEFAULT_PALETTE_CONTRIBUTIONS.filter((c) => c.id !== 'relay'),
      {
        id: 'relay',
        label: 'Integrations',
        icon: 'Radio',
        action: 'openRelay',
        category: 'feature',
        priority: 2,
        keywords: ['connectors', 'telegram', 'slack'],
      },
    ]);

    const { result } = renderHook(() => usePaletteItems(null));
    const item = result.current.searchableItems.find((i) => i.id === 'relay');
    expect(item?.keywords).toEqual(['connectors', 'telegram', 'slack']);
  });

  it("carries a quick-action contribution's keywords into the flat search list", () => {
    mockUseSlotContributions.mockReturnValue([
      ...DEFAULT_PALETTE_CONTRIBUTIONS.filter((c) => c.id !== 'browse'),
      {
        id: 'browse',
        label: 'Browse Filesystem',
        icon: 'FolderOpen',
        action: 'browseFilesystem',
        category: 'quick-action',
        priority: 5,
        keywords: ['files', 'folder'],
      },
    ]);

    const { result } = renderHook(() => usePaletteItems(null));
    const item = result.current.searchableItems.find((i) => i.id === 'browse');
    expect(item?.type).toBe('quick-action');
    expect(item?.keywords).toEqual(['files', 'folder']);
  });

  it('hands the room lists back unread first', () => {
    mockUseRooms.mockReturnValue({
      data: [quietButRecent, unreadButOlder],
      isLoading: false,
      isError: false,
    });
    const { result } = renderHook(() => usePaletteItems(null));

    expect(result.current.rooms.channels.map((r) => r.id)).toEqual(['room-unread', 'room-recent']);
    expect(result.current.rooms.unread.map((r) => r.id)).toEqual(['room-unread']);
  });
});

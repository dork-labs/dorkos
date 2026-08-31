/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaletteItems } from '../use-palette-items';
import type {
  CommandItemData,
  FeatureItem,
  PaletteItems,
  QuickActionItem,
} from '../use-palette-items';
import type { SearchableItem } from '../use-palette-search';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { CommandPaletteContribution } from '@/layers/shared/model';

/**
 * The instant this hook reasons about time from — noon, local.
 *
 * Held still rather than read per render, so nothing below depends on the hour
 * the suite happens to run at. The only thing derived from it is the day
 * boundary a row's archived label is measured against, and that boundary is
 * 04:00 LOCAL — so a fixed UTC instant would land on either side of it
 * depending on the machine's timezone.
 */
const NOW = (() => {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  return noon.getTime();
})();

/** A local hour on NOW's own day, or `daysAgo` days before it, as an ISO string. */
function localAt(hour: number, daysAgo = 0): string {
  const at = new Date(NOW);
  at.setDate(at.getDate() - daysAgo);
  at.setHours(hour, 0, 0, 0);
  return at.toISOString();
}

// --- Mock entity hooks ---

const mockUseMeshAgentPaths = vi.fn();
const mockUseCommands = vi.fn();
const mockUseSessions = vi.fn();
const mockUseRecentSessions = vi.fn();
const mockSessionListState = vi.fn();
const mockUseRooms = vi.fn();
const mockUseAppStore = vi.fn();

const DEFAULT_PALETTE_CONTRIBUTIONS: CommandPaletteContribution[] = [
  {
    id: 'tasks',
    label: 'Scheduled tasks',
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
  // Keep the real selectAgentSessions/sessionDisplayTitle/partitionSessionsByOrigin
  // — only the data hooks are stubbed.
  ...(await importOriginal<typeof import('@/layers/entities/session')>()),
  useSessions: () => mockUseSessions(),
  useRecentSessions: () => mockUseRecentSessions(),
  // The fleet-wide live store, read through a selector exactly as the hook does.
  useSessionListStore: (selector: (s: unknown) => unknown) => selector(mockSessionListState()),
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

const makeRoom = (overrides: Partial<RoomSummary> = {}): RoomSummary => ({
  id: 'room-default',
  kind: 'channel',
  slug: 'default',
  title: 'Default',
  topic: null,
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

describe('usePaletteItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no data, not loading
    mockUseMeshAgentPaths.mockReturnValue({ data: undefined, isLoading: false });
    mockUseCommands.mockReturnValue({ data: undefined });
    mockUseSessions.mockReturnValue({ sessions: [] });
    mockUseRecentSessions.mockReturnValue({ data: undefined });
    mockSessionListState.mockReturnValue({ statuses: {}, sessions: {} });
    mockUseRooms.mockReturnValue({ data: [], isLoading: false, isError: false });
    mockUseSlotContributions.mockReturnValue(DEFAULT_PALETTE_CONTRIBUTIONS);
  });

  // --- Static content groups ---

  /**
   * Every registered contribution of one category, as the corpus carries it.
   *
   * Read off `searchableItems` rather than off a list of its own, because that
   * IS the list now: a typed query is one ranked list across types, so the
   * corpus is the only route an action has to the screen. Asserting a parallel
   * array would have gone on passing after the palette stopped reading it.
   */
  function corpusOf(items: PaletteItems, type: SearchableItem['type']) {
    return items.searchableItems.filter((item) => item.type === type);
  }

  it('offers every registered feature as a searchable row', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const ids = corpusOf(result.current, 'feature').map((f) => f.id);
    expect(ids).toHaveLength(4);
    expect(ids).toContain('tasks');
    expect(ids).toContain('relay');
    expect(ids).toContain('mesh');
    expect(ids).toContain('settings');
  });

  it('offers every registered quick action as a searchable row', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const ids = corpusOf(result.current, 'quick-action').map((q) => q.id);
    expect(ids).toHaveLength(6);
    expect(ids).toContain('dashboard');
    expect(ids).toContain('new-session');
    expect(ids).toContain('create-agent');
    expect(ids).toContain('discover');
    expect(ids).toContain('browse');
    expect(ids).toContain('theme');
  });

  it('gives every feature row a name and something to run', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    for (const row of corpusOf(result.current, 'feature')) {
      expect(row.name).toBeTruthy();
      const feature = row.data as FeatureItem;
      expect(feature.label).toBeTruthy();
      expect(feature.icon).toBeTruthy();
      expect(feature.action).toBeTruthy();
    }
  });

  it('gives every quick-action row a name and something to run', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    for (const row of corpusOf(result.current, 'quick-action')) {
      expect(row.name).toBeTruthy();
      const qa = row.data as QuickActionItem;
      expect(qa.label).toBeTruthy();
      expect(qa.icon).toBeTruthy();
      expect(qa.action).toBeTruthy();
    }
  });

  // --- Agent data ---

  it('returns an empty roster when no agents are registered', () => {
    mockUseMeshAgentPaths.mockReturnValue({ data: undefined, isLoading: false });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    expect(result.current.allAgents).toEqual([]);
  });

  it('allAgents contains all registered agents from mesh', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA, agentB, agentC] },
      isLoading: false,
    });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    expect(result.current.allAgents).toHaveLength(3);
    expect(result.current.allAgents).toContain(agentA);
    expect(result.current.allAgents).toContain(agentB);
    expect(result.current.allAgents).toContain(agentC);
  });

  // --- Commands ---

  it('commands is empty array when no command data is available', () => {
    mockUseCommands.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    expect(corpusOf(result.current, 'command')).toEqual([]);
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

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const rows = corpusOf(result.current, 'command');
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('/hello');
    expect((rows[0].data as CommandItemData).description).toBe('Say hello');
    expect(rows[1].name).toBe('/world');
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

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    // description is mapped from cmd.description; empty string is falsy, so the
    // row carries no keywords rather than an empty one.
    const rows = corpusOf(result.current, 'command');
    expect(rows[0].name).toBe('/bare');
    expect(rows[0].keywords).toBeUndefined();
  });

  // --- isLoading ---

  it('isLoading is true while agent data is loading', () => {
    mockUseMeshAgentPaths.mockReturnValue({ data: undefined, isLoading: true });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    expect(result.current.isLoading).toBe(true);
  });

  it('isLoading is false when agent data has loaded', () => {
    mockUseMeshAgentPaths.mockReturnValue({
      data: { agents: [agentA] },
      isLoading: false,
    });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    expect(result.current.isLoading).toBe(false);
  });

  // --- Return shape ---

  it('returns every content group the palette draws, and no list nothing reads', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    // Exact, not `toHaveProperty` one at a time: a list with no reader is dead
    // surface, and the three that went (`features`, `commands`, `quickActions`)
    // went because a typed query is one ranked list now and the corpus is their
    // only route to the screen.
    expect(Object.keys(result.current).sort()).toEqual([
      'allAgents',
      'continueRows',
      'isLoading',
      'newActions',
      'recent',
      'rooms',
      'searchableItems',
      'sessions',
    ]);
  });

  // --- The zero-query "New" group ---

  it('New holds the two creation actions, in their declared order', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    expect(result.current.newActions.map((a) => a.id)).toEqual(['new-session', 'create-agent']);
  });

  it('New leaves out every quick action that does not make something', () => {
    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const ids = result.current.newActions.map((a) => a.id);
    // These are real quick actions in the fixture above; none of them creates
    // anything, and none of them may take a seat in the four rows before typing.
    expect(ids).not.toContain('theme');
    expect(ids).not.toContain('dashboard');
    expect(ids).not.toContain('browse');
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

      renderHook(() => usePaletteItems('/projects/a', NOW));

      expect(mockUseCommands).toHaveBeenCalledWith('/projects/a', 'session-codex', 'codex');
    });

    it('names the directory alone when no conversation is open there yet', () => {
      // A directory with no sessions still narrows the answer — project skills
      // live under it — so the cwd goes even when there is nothing else to say.
      mockUseSessions.mockReturnValue({ sessions: [] });

      renderHook(() => usePaletteItems('/projects/a', NOW));

      expect(mockUseCommands).toHaveBeenCalledWith('/projects/a', undefined, undefined);
    });

    it('ignores sessions belonging to another directory', () => {
      // `selectAgentSessions` is the canonical membership rule (DOR-203);
      // reading `sessions[0]` blindly would hand the palette a session from
      // whichever project happened to be listed first.
      mockUseSessions.mockReturnValue({
        sessions: [{ ...activeSession, cwd: '/projects/elsewhere' }],
      });

      renderHook(() => usePaletteItems('/projects/a', NOW));

      expect(mockUseCommands).toHaveBeenCalledWith('/projects/a', undefined, undefined);
    });
  });

  // --- Conversations in the corpus (§15) ---

  const recentSession = {
    id: 'f1e2d3c4-0000-4000-8000-000000000001',
    title: 'Zanzibar migration',
    cwd: '/projects/a',
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    lastMessagePreview: 'the flaky retry loop is what breaks it',
  };

  it('puts a conversation in the flat search list under type "session", named by its title', () => {
    mockUseMeshAgentPaths.mockReturnValue({ data: { agents: [agentA] }, isLoading: false });
    mockUseRecentSessions.mockReturnValue({
      data: { sessions: [recentSession], agentActivity: {} },
    });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const item = result.current.searchableItems.find((i) => i.id === recentSession.id);

    expect(item?.type).toBe('session');
    expect(item?.name).toBe('Zanzibar migration');
    // The agent that owns it and the directory it lives in are both typeable.
    expect(item?.keywords).toEqual([recentSession.id, 'Agent A', '/projects/a']);
  });

  it('never puts a message body in the corpus — ⌘K finds things, not words', () => {
    mockUseMeshAgentPaths.mockReturnValue({ data: { agents: [agentA] }, isLoading: false });
    mockUseRecentSessions.mockReturnValue({
      data: { sessions: [recentSession], agentActivity: {} },
    });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const item = result.current.searchableItems.find((i) => i.id === recentSession.id);

    // The preview is right there on the session and would be one line to add.
    // Nothing searchable may carry it.
    const searchable = [item?.name, ...(item?.keywords ?? [])].join(' ');
    expect(recentSession.lastMessagePreview).toContain('flaky');
    expect(searchable).not.toContain('flaky');
  });

  it('labels a conversation from before the day turned over — and does NOT demote it', () => {
    // The whole difference between an archived room and an archived
    // conversation, in one assertion. `demoted` is a hard partition below every
    // live row of every kind; the room below earns it because somebody closed
    // it, and the conversation must not, or yesterday's work would sit under
    // today's slash commands.
    const yesterday = { ...recentSession, id: 'ses-yesterday', updatedAt: localAt(20, 1) };
    const thisMorning = { ...recentSession, id: 'ses-this-morning', updatedAt: localAt(11) };
    mockUseMeshAgentPaths.mockReturnValue({ data: { agents: [agentA] }, isLoading: false });
    mockUseRecentSessions.mockReturnValue({
      data: { sessions: [yesterday, thisMorning], agentActivity: {} },
    });
    mockUseRooms.mockReturnValue({
      data: [{ ...channel, id: 'room-shut', slug: 'shut', archived: true }],
      isLoading: false,
      isError: false,
    });

    const { result } = renderHook(() => usePaletteItems(null, NOW));
    const byId = new Map(result.current.sessions.map((s) => [s.id, s]));
    const corpus = new Map(result.current.searchableItems.map((i) => [i.id, i]));

    expect(byId.get('ses-yesterday')?.archived).toBe(true);
    expect(byId.get('ses-this-morning')?.archived).toBe(false);
    // Neither conversation is demoted…
    expect(corpus.get('ses-yesterday')?.demoted).toBe(false);
    expect(corpus.get('ses-this-morning')?.demoted).toBe(false);
    // …and the archived ROOM is, so this is `demoted` still working rather than
    // a field nothing sets any more.
    expect(corpus.get('room-shut')?.demoted).toBe(true);
  });

  // --- Rooms (spec `rooms` §13.2) ---

  it('puts a channel in the flat search list under type "room", named the way people type it', () => {
    mockUseRooms.mockReturnValue({ data: [channel], isLoading: false, isError: false });
    const { result } = renderHook(() => usePaletteItems(null, NOW));

    const item = result.current.searchableItems.find((i) => i.id === 'room-general');
    expect(item).toEqual({
      id: 'room-general',
      name: '#general',
      type: 'room',
      // The bare slug rides along so `#gen` — which arrives with the prefix
      // already stripped — matches `general` rather than fuzzing past the `#`.
      keywords: ['General chatter', 'general'],
      // What ranking reads. Asserted as part of the whole object rather than
      // spot-checked, so a row that stopped carrying them — and so silently
      // ranked as never-used, never-active and never-waiting — goes red here.
      usageKey: 'room:room-general',
      lastActivityAt: channel.lastActivityAt,
      waiting: false,
      demoted: false,
      // A channel is something you scope BY, so it belongs to no scope itself.
      scopes: [],
      data: channel,
    });
  });

  it('marks an unread channel as waiting, and an archived one as findable-not-live', () => {
    const unread = { ...channel, id: 'room-loud', slug: 'loud', unreadCount: 3 };
    const archived = { ...channel, id: 'room-old', slug: 'old', archived: true };
    mockUseRooms.mockReturnValue({ data: [unread, archived], isLoading: false, isError: false });
    const { result } = renderHook(() => usePaletteItems(null, NOW));

    const byId = new Map(result.current.searchableItems.map((i) => [i.id, i]));
    expect(byId.get('room-loud')?.waiting).toBe(true);
    expect(byId.get('room-loud')?.demoted).toBe(false);
    expect(byId.get('room-old')?.waiting).toBe(false);
    expect(byId.get('room-old')?.demoted).toBe(true);
  });

  it('puts a direct message under type "dm", not "room", so `@` finds it and `#` does not', () => {
    mockUseRooms.mockReturnValue({ data: [dmWithAna], isLoading: false, isError: false });
    const { result } = renderHook(() => usePaletteItems(null, NOW));

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
    const { result } = renderHook(() => usePaletteItems(null, NOW));
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

    const { result } = renderHook(() => usePaletteItems(null, NOW));
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

    const { result } = renderHook(() => usePaletteItems(null, NOW));
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
    const { result } = renderHook(() => usePaletteItems(null, NOW));

    expect(result.current.rooms.channels.map((r) => r.id)).toEqual(['room-unread', 'room-recent']);
    expect(result.current.rooms.unread.map((r) => r.id)).toEqual(['room-unread']);
  });
});

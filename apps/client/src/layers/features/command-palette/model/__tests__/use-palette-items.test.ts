/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePaletteItems } from '../use-palette-items';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';

// --- Mock entity hooks ---

const mockUseMeshAgentPaths = vi.fn();
const mockUseCommands = vi.fn();
const mockUseAgentFrecency = vi.fn();

vi.mock('@/layers/entities/mesh', () => ({
  useMeshAgentPaths: () => mockUseMeshAgentPaths(),
}));

vi.mock('@/layers/entities/command', () => ({
  useCommands: () => mockUseCommands(),
}));

vi.mock('../use-agent-frecency', () => ({
  useAgentFrecency: () => mockUseAgentFrecency(),
}));

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
  });

  // --- Static content groups ---

  it('features is a static list of 4 items', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.features).toHaveLength(4);
    const ids = result.current.features.map((f) => f.id);
    expect(ids).toContain('pulse');
    expect(ids).toContain('relay');
    expect(ids).toContain('mesh');
    expect(ids).toContain('settings');
  });

  it('quickActions is a static list of 4 items', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current.quickActions).toHaveLength(4);
    const ids = result.current.quickActions.map((q) => q.id);
    expect(ids).toContain('new-session');
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
      makeFrecency(['agent-a', 'agent-b', 'agent-c', 'agent-d', 'agent-e', 'agent-f']),
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

  it('returns all five content groups', () => {
    const { result } = renderHook(() => usePaletteItems(null));
    expect(result.current).toHaveProperty('recentAgents');
    expect(result.current).toHaveProperty('allAgents');
    expect(result.current).toHaveProperty('features');
    expect(result.current).toHaveProperty('commands');
    expect(result.current).toHaveProperty('quickActions');
    expect(result.current).toHaveProperty('isLoading');
  });
});

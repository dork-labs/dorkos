/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useConnectionsStatus } from '../model/use-connections-status';
import type { AgentToolStatus } from '@/layers/entities/agent';
import type { AdapterListItem } from '@dorkos/shared/transport';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Mocks — match the barrel imports used by useConnectionsStatus
// ---------------------------------------------------------------------------

const mockToolStatus = vi.fn<() => AgentToolStatus>(() => ({
  pulse: 'enabled',
  relay: 'enabled',
  mesh: 'enabled',
  adapter: 'enabled',
}));
vi.mock('@/layers/entities/agent', () => ({
  useAgentToolStatus: () => mockToolStatus(),
}));

const mockRelayAdapters = vi.fn<() => { data: AdapterListItem[] | undefined }>(() => ({
  data: undefined,
}));
vi.mock('@/layers/entities/relay', () => ({
  useRelayAdapters: () => mockRelayAdapters(),
}));

const mockRegisteredAgents = vi.fn<() => { data: { agents: AgentManifest[] } | undefined }>(() => ({
  data: undefined,
}));
vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => mockRegisteredAgents(),
}));

// ---------------------------------------------------------------------------
// Helpers — build minimal mock objects matching real schema shapes
// ---------------------------------------------------------------------------

function makeAdapter(
  id: string,
  state: 'connected' | 'disconnected' | 'error' | 'starting' | 'stopping'
): AdapterListItem {
  return {
    config: {
      id,
      type: 'telegram',
      enabled: true,
      config: { token: 'test-token', mode: 'polling' },
    },
    status: {
      id,
      type: 'telegram',
      displayName: id,
      state,
      messageCount: { inbound: 0, outbound: 0 },
      errorCount: 0,
    },
  } satisfies AdapterListItem;
}

function makeAgent(id: string, name: string): AgentManifest {
  return { id, name } as AgentManifest;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useConnectionsStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToolStatus.mockReturnValue({
      pulse: 'enabled',
      relay: 'enabled',
      mesh: 'enabled',
      adapter: 'enabled',
    });
    mockRelayAdapters.mockReturnValue({ data: undefined });
    mockRegisteredAgents.mockReturnValue({ data: undefined });
  });

  // --- 'none' status ---

  it('returns none when data is undefined (loading state)', () => {
    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('none');
  });

  it('returns none when no adapters and no agents exist', () => {
    mockRelayAdapters.mockReturnValue({ data: [] });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('none');
  });

  it('returns none when adapters are empty and agents data is undefined', () => {
    mockRelayAdapters.mockReturnValue({ data: [] });
    mockRegisteredAgents.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('none');
  });

  it('returns none when adapters data is undefined and agents list is empty', () => {
    mockRelayAdapters.mockReturnValue({ data: undefined });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('none');
  });

  // --- 'ok' status ---

  it('returns ok when all adapters are connected and agents exist', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'connected'), makeAdapter('slack-1', 'connected')],
    });
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Deployer')] },
    });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('ok');
  });

  it('returns ok when all adapters are connected and no agents exist', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'connected')],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('ok');
  });

  it('returns ok when only agents exist (no adapters)', () => {
    mockRelayAdapters.mockReturnValue({ data: [] });
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Agent 1'), makeAgent('ag2', 'Agent 2')] },
    });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    // With agents but no adapters, length > 0 so not 'none'.
    // No adapters to error. every() on empty array returns true -> 'ok'.
    expect(result.current).toBe('ok');
  });

  it('returns ok with a single connected adapter', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'connected')],
    });
    mockRegisteredAgents.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('ok');
  });

  // --- 'partial' status ---

  it('returns partial when some adapters are disconnected', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'connected'), makeAdapter('slack-1', 'disconnected')],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('partial');
  });

  it('returns partial when an adapter is starting', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'starting')],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('partial');
  });

  it('returns partial when an adapter is stopping', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'stopping')],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('partial');
  });

  it('returns partial when all adapters are disconnected', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'disconnected'), makeAdapter('slack-1', 'disconnected')],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('partial');
  });

  // --- 'error' status ---

  it('returns error when any adapter has error state', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'connected'), makeAdapter('slack-1', 'error')],
    });
    mockRegisteredAgents.mockReturnValue({
      data: { agents: [makeAgent('ag1', 'Agent 1')] },
    });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('error');
  });

  it('returns error when the sole adapter has error state', () => {
    mockRelayAdapters.mockReturnValue({
      data: [makeAdapter('tg-1', 'error')],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('error');
  });

  it('error takes precedence over partial', () => {
    mockRelayAdapters.mockReturnValue({
      data: [
        makeAdapter('tg-1', 'error'),
        makeAdapter('slack-1', 'disconnected'),
        makeAdapter('wh-1', 'connected'),
      ],
    });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('error');
  });

  // --- projectPath edge case ---

  it('accepts null projectPath without error', () => {
    mockRelayAdapters.mockReturnValue({ data: [] });
    mockRegisteredAgents.mockReturnValue({ data: { agents: [] } });

    const { result } = renderHook(() => useConnectionsStatus(null));
    expect(result.current).toBe('none');
  });

  // --- Feature flag interactions ---

  it('returns none when relay and mesh are disabled by server (no data fetched)', () => {
    mockToolStatus.mockReturnValue({
      pulse: 'enabled',
      relay: 'disabled-by-server',
      mesh: 'disabled-by-server',
      adapter: 'disabled-by-server',
    });
    // When disabled, queries return undefined
    mockRelayAdapters.mockReturnValue({ data: undefined });
    mockRegisteredAgents.mockReturnValue({ data: undefined });

    const { result } = renderHook(() => useConnectionsStatus('/test'));
    expect(result.current).toBe('none');
  });
});

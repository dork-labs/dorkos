import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const mockLoadRightPanelForAgent = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ loadRightPanelForAgent: mockLoadRightPanelForAgent }),
}));

// Mutable per-test resolution of the agent context. `isPending` mirrors the
// TanStack Query flag: true while the per-cwd agent lookup is cold/in flight.
let mockCwd: string | null = null;
let mockAgent: AgentManifest | null = null;
let mockIsPending = false;
vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => [mockCwd, vi.fn()],
}));
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: mockAgent, isPending: mockIsPending }),
}));

import { useRightPanelLayoutPersistence } from '../model/use-right-panel-persistence';

/** Minimal AgentManifest stub — only the id is read by the hook. */
function agentWithId(id: string): AgentManifest {
  return { id } as AgentManifest;
}

describe('useRightPanelLayoutPersistence', () => {
  beforeEach(() => {
    mockLoadRightPanelForAgent.mockClear();
    mockCwd = null;
    mockAgent = null;
    mockIsPending = false;
  });

  afterEach(() => cleanup());

  it('keys by the agent id when an agent is registered', () => {
    mockCwd = '/Users/dev/proj';
    mockAgent = agentWithId('agent-01H');
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('agent-01H');
  });

  it('falls back to the cwd once the lookup settles to no registered agent', () => {
    mockCwd = '/Users/dev/untracked';
    mockAgent = null;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('/Users/dev/untracked');
  });

  it('defers binding entirely while the agent lookup is pending (cold cache)', () => {
    // Binding by cwd and then flipping to agent.id would hydrate twice —
    // flapping the panel and discarding user changes in the window (DOR-227).
    mockCwd = '/Users/dev/proj';
    mockAgent = null;
    mockIsPending = true;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).not.toHaveBeenCalled();
  });

  it('binds exactly once, with the agent id, when a pending lookup settles to an agent', () => {
    mockCwd = '/Users/dev/proj';
    mockIsPending = true;
    const { rerender } = renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).not.toHaveBeenCalled();

    // Query settles: agent registered at this cwd.
    mockIsPending = false;
    mockAgent = agentWithId('agent-01H');
    rerender();

    expect(mockLoadRightPanelForAgent).toHaveBeenCalledTimes(1);
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('agent-01H');
  });

  it('binds the cwd when a pending lookup settles to null (no agent registered)', () => {
    mockCwd = '/Users/dev/untracked';
    mockIsPending = true;
    const { rerender } = renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).not.toHaveBeenCalled();

    mockIsPending = false;
    mockAgent = null;
    rerender();

    expect(mockLoadRightPanelForAgent).toHaveBeenCalledTimes(1);
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('/Users/dev/untracked');
  });

  it('detaches to the global layout (null key) when no cwd resolves', () => {
    // A disabled query reports pending forever — the no-cwd detach must win.
    mockCwd = null;
    mockIsPending = true;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith(null);
  });

  it('detaches to the global layout (null key) on unmount', () => {
    mockCwd = '/Users/dev/proj';
    mockAgent = agentWithId('agent-01H');
    const { unmount } = renderHook(() => useRightPanelLayoutPersistence());
    mockLoadRightPanelForAgent.mockClear();
    unmount();
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith(null);
  });
});

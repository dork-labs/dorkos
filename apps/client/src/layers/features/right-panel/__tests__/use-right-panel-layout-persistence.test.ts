import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const mockLoadRightPanelForAgent = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ loadRightPanelForAgent: mockLoadRightPanelForAgent }),
}));

// Mutable per-test resolution of the agent context.
let mockCwd: string | null = null;
let mockAgent: AgentManifest | null = null;
vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => [mockCwd, vi.fn()],
}));
vi.mock('@/layers/entities/agent', () => ({
  useCurrentAgent: () => ({ data: mockAgent }),
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
  });

  afterEach(() => cleanup());

  it('keys by the agent id when an agent is registered', () => {
    mockCwd = '/Users/dev/proj';
    mockAgent = agentWithId('agent-01H');
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('agent-01H');
  });

  it('falls back to the cwd when no agent is registered at the directory', () => {
    mockCwd = '/Users/dev/untracked';
    mockAgent = null;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('/Users/dev/untracked');
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

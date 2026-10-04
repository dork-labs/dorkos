import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

const mockLoadRightPanelForAgent = vi.fn();
const mockLoadRightPanelState = vi.fn();
let mockBelowDesktop = false;
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      loadRightPanelForAgent: mockLoadRightPanelForAgent,
      loadRightPanelState: mockLoadRightPanelState,
    }),
  useIsBelowDesktop: () => mockBelowDesktop,
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

import {
  useRightPanelLayoutPersistence,
  useRightPanelPersistence,
} from '../model/use-right-panel-persistence';

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
    mockBelowDesktop = false;
  });

  afterEach(() => cleanup());

  it('keys by the agent id when an agent is registered', () => {
    mockCwd = '/Users/dev/proj';
    mockAgent = agentWithId('agent-01H');
    renderHook(() => useRightPanelLayoutPersistence());
    // The directory travels with the key: a pending deep link named a DIRECTORY,
    // and the key may be an agent id, so the store cannot tell on its own
    // whether that link was about the agent binding now (DOR-227 leak).
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('agent-01H', '/Users/dev/proj', {
      inherit: true,
    });
  });

  it('falls back to the cwd once the lookup settles to no registered agent', () => {
    mockCwd = '/Users/dev/untracked';
    mockAgent = null;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith(
      '/Users/dev/untracked',
      '/Users/dev/untracked',
      {
        inherit: true,
      }
    );
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
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('agent-01H', '/Users/dev/proj', {
      inherit: true,
    });
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
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith(
      '/Users/dev/untracked',
      '/Users/dev/untracked',
      {
        inherit: true,
      }
    );
  });

  it('detaches to the global layout (null key) when no cwd resolves', () => {
    // A disabled query reports pending forever — the no-cwd detach must win.
    mockCwd = null;
    mockIsPending = true;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith(null, null, { inherit: true });
  });

  it('asks for no inheritance below desktop width, where the panel covers the chat', () => {
    mockCwd = '/Users/dev/proj';
    mockAgent = agentWithId('agent-01H');
    mockBelowDesktop = true;
    renderHook(() => useRightPanelLayoutPersistence());
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledWith('agent-01H', '/Users/dev/proj', {
      inherit: false,
    });
  });

  it('does not re-bind when the window crosses the desktop breakpoint', () => {
    mockCwd = '/Users/dev/proj';
    mockAgent = agentWithId('agent-01H');
    const { rerender } = renderHook(() => useRightPanelLayoutPersistence());
    mockBelowDesktop = true;
    rerender();
    expect(mockLoadRightPanelForAgent).toHaveBeenCalledTimes(1);
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

describe('useRightPanelPersistence', () => {
  beforeEach(() => {
    mockLoadRightPanelState.mockClear();
    mockBelowDesktop = false;
  });

  afterEach(() => cleanup());

  it('restores the open state on desktop', () => {
    renderHook(() => useRightPanelPersistence());
    expect(mockLoadRightPanelState).toHaveBeenCalledWith({ restoreOpen: true });
  });

  it('restores the tab only below desktop width, so a reload never opens the sheet', () => {
    mockBelowDesktop = true;
    renderHook(() => useRightPanelPersistence());
    expect(mockLoadRightPanelState).toHaveBeenCalledWith({ restoreOpen: false });
  });

  it('hydrates once: crossing the breakpoint later does not hydrate again', () => {
    const { rerender } = renderHook(() => useRightPanelPersistence());
    mockBelowDesktop = true;
    rerender();
    expect(mockLoadRightPanelState).toHaveBeenCalledTimes(1);
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentHubStore } from '../model/agent-hub-store';

// Reset store state between tests to prevent cross-test contamination.
beforeEach(() => {
  useAgentHubStore.setState({ activeTab: 'sessions', agentPath: null });
});

describe('useAgentHubStore', () => {
  it('initializes with sessions tab and null agentPath', () => {
    const { result } = renderHook(() => useAgentHubStore());
    expect(result.current.activeTab).toBe('sessions');
    expect(result.current.agentPath).toBeNull();
  });

  it('setActiveTab updates activeTab', () => {
    const { result } = renderHook(() => useAgentHubStore());

    act(() => {
      result.current.setActiveTab('config');
    });

    expect(result.current.activeTab).toBe('config');
  });

  it('setAgentPath updates agentPath', () => {
    const { result } = renderHook(() => useAgentHubStore());

    act(() => {
      result.current.setAgentPath('/agents/my-agent');
    });

    expect(result.current.agentPath).toBe('/agents/my-agent');
  });

  it('setAgentPath accepts null to clear the path', () => {
    const { result } = renderHook(() => useAgentHubStore());

    act(() => {
      result.current.setAgentPath('/agents/my-agent');
    });
    act(() => {
      result.current.setAgentPath(null);
    });

    expect(result.current.agentPath).toBeNull();
  });

  it('openHub sets both agentPath and activeTab', () => {
    const { result } = renderHook(() => useAgentHubStore());

    act(() => {
      result.current.openHub('/agents/some-agent', 'sessions');
    });

    expect(result.current.agentPath).toBe('/agents/some-agent');
    expect(result.current.activeTab).toBe('sessions');
  });

  it('openHub defaults to sessions tab when no tab specified', () => {
    const { result } = renderHook(() => useAgentHubStore());

    // Set a non-default tab first to confirm it gets reset.
    act(() => {
      result.current.setActiveTab('config');
    });
    act(() => {
      result.current.openHub('/agents/another-agent');
    });

    expect(result.current.agentPath).toBe('/agents/another-agent');
    expect(result.current.activeTab).toBe('sessions');
  });
});

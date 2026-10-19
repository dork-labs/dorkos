// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { useAppStore } from '@/layers/shared/model';

const route = vi.hoisted(() => ({
  pathname: '/session',
  search: {} as Record<string, string>,
  sessionId: 'dorkbot-chat' as string | null,
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useSafePathname: () => route.pathname,
  useSafeSearch: () => route.search,
}));
vi.mock('@/layers/entities/session', () => ({
  useSessionId: () => [route.sessionId, vi.fn()],
}));
vi.mock('@/layers/entities/mesh', () => ({ useMeshMemberId: () => undefined }));

import { useDockedAgentPath, useScopeProfilePickToChat } from '../model/use-docked-agent';

const DORKBOT = '/agents/dorkbot';
const CLOUD = '/agents/dorkos-cloud';

/** The shell's hook and the dock's read, mounted together as the app does. */
function useShellAndDock() {
  useScopeProfilePickToChat();
  return useDockedAgentPath();
}

beforeEach(() => {
  route.pathname = '/team';
  route.search = {};
  route.sessionId = 'dorkbot-chat';
  useAppStore.setState({ selectedCwd: DORKBOT, explicitAgentPath: null });
});
afterEach(cleanup);

describe('the docked profile in a 1:1 chat (FB-60)', () => {
  it('shows the chat’s own agent, not a profile opened earlier somewhere else', () => {
    const { result, rerender } = renderHook(useShellAndDock);
    // Dorian opens DorkOS Cloud's profile from the team page…
    useAppStore.setState({ explicitAgentPath: CLOUD });
    rerender();
    expect(result.current).toBe(CLOUD);
    // …then opens his chat with DorkBot.
    route.pathname = '/session';
    rerender();
    expect(result.current).toBe(DORKBOT);
    expect(useAppStore.getState().explicitAgentPath).toBeNull();
  });

  it('always shows the chat’s own agent while you are in it, whatever was picked', () => {
    route.pathname = '/session';
    const { result, rerender } = renderHook(useShellAndDock);
    useAppStore.setState({ explicitAgentPath: CLOUD });
    rerender();
    expect(result.current).toBe(DORKBOT);
  });

  it('follows every switch between chats', () => {
    route.pathname = '/session';
    const { result, rerender } = renderHook(useShellAndDock);
    route.sessionId = 'cloud-chat';
    useAppStore.setState({ selectedCwd: CLOUD });
    rerender();
    expect(result.current).toBe(CLOUD);
    route.sessionId = 'dorkbot-chat';
    useAppStore.setState({ selectedCwd: DORKBOT });
    rerender();
    expect(result.current).toBe(DORKBOT);
  });
});

describe('a profile opened in a room (FB-60)', () => {
  it('stays while you are in that room and resets when you switch rooms', () => {
    route.pathname = '/channels';
    route.search = { id: 'room-a' };
    const { result, rerender } = renderHook(useShellAndDock);
    useAppStore.setState({ explicitAgentPath: CLOUD });
    rerender();
    expect(result.current).toBe(CLOUD);
    route.search = { id: 'room-b' };
    rerender();
    expect(useAppStore.getState().explicitAgentPath).toBeNull();
    expect(result.current).toBeNull();
  });

  it('keeps a pick that the link itself names', () => {
    route.pathname = '/channels';
    route.search = { id: 'room-a' };
    const { result, rerender } = renderHook(useShellAndDock);
    useAppStore.setState({ explicitAgentPath: CLOUD });
    route.search = { id: 'room-b', agentPath: CLOUD };
    rerender();
    expect(result.current).toBe(CLOUD);
  });
});

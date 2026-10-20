// @vitest-environment jsdom
/**
 * How the chat on screen is drawn (DOR-3074): as a session, exactly as before,
 * or as a DM with one agent, and what the empty composer says either way.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { useSessionSurface } from '../model/use-session-surface';

const state = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'dm' | 'session',
  name: null as string | null,
  displayName: null as string | null,
}));

vi.mock('@/layers/features/direct-message', () => ({
  useDirectMessageView: () => ({
    mode: state.mode,
    chat:
      state.mode === 'off'
        ? null
        : { sessionId: 's', sessionIds: ['s'], roomId: 'dm', agentPath: '/agents/scout' },
  }),
  useDirectMessageAgent: (agentPath: string | null) =>
    agentPath === null || state.name === null
      ? { id: null, name: null, visual: null, role: null, member: undefined }
      : {
          id: 'scout-manifest',
          name: state.name,
          visual: { emoji: '🦊', color: 'hsl(20 80% 50%)' },
          role: null,
          member: undefined,
        },
}));
vi.mock('@/layers/entities/config', () => ({
  useConfig: () => ({ data: { profile: { displayName: state.displayName } } }),
}));

afterEach(() => {
  cleanup();
  state.mode = 'off';
  state.name = null;
  state.displayName = null;
});

const AT_FOLDER = { id: 'm', name: 'scout', displayName: 'Scout' } as unknown as AgentManifest;

describe('useSessionSurface', () => {
  it('is a session with today’s placeholder while the chat is not a DM', () => {
    const { result } = renderHook(() => useSessionSurface('s', AT_FOLDER));
    expect(result.current).toEqual({ directMessage: null, placeholder: 'Message Scout…' });

    const bare = renderHook(() => useSessionSurface('s', null));
    expect(bare.result.current.placeholder).toBe('Send a message…');
  });

  it('is a session too on the session view behind a DM', () => {
    state.mode = 'session';
    state.name = 'Scout';
    const { result } = renderHook(() => useSessionSurface('s', AT_FOLDER));
    expect(result.current.directMessage).toBeNull();
    expect(result.current.placeholder).toBe('Message Scout…');
  });

  it('draws a DM: the agent and the person, and the room’s placeholder', () => {
    state.mode = 'dm';
    state.name = 'Scout';
    state.displayName = 'Dorian';
    const { result } = renderHook(() => useSessionSurface('s', null));
    expect(result.current).toEqual({
      directMessage: {
        agent: {
          id: 'scout-manifest',
          displayName: 'Scout',
          emoji: '🦊',
          color: 'hsl(20 80% 50%)',
        },
        humanName: 'Dorian',
      },
      placeholder: 'Message Scout',
    });
  });

  it('keeps one DM object while nothing it says changes', () => {
    // The transcript keys its author resolver on it: a fresh one per render
    // would lay the whole conversation out again on every streamed word.
    state.mode = 'dm';
    state.name = 'Scout';
    const { result, rerender } = renderHook(() => useSessionSurface('s', null));
    const first = result.current.directMessage;
    rerender();
    expect(result.current.directMessage).toBe(first);
  });
});

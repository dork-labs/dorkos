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
  mode: 'off' as 'off' | 'dm' | 'session' | 'pending',
  showSessions: false,
  name: null as string | null,
  displayName: null as string | null,
  noManifest: false,
  unknown: false,
  lookupFailed: false,
  keptName: null as string | null,
}));

vi.mock('@/layers/features/direct-message', () => ({
  useDirectMessageView: () => ({
    lookupFailed: state.lookupFailed,
    mode: state.mode,
    chat:
      state.mode === 'off' || state.mode === 'pending'
        ? null
        : { sessionId: 's', sessionIds: ['s'], roomId: 'dm', agentPath: '/agents/scout' },
  }),
  useDirectMessageAgent: (agentPath: string | null) =>
    agentPath === null || state.name === null
      ? {
          id: null,
          name: null,
          keptName: agentPath === null ? null : state.keptName,
          visual: null,
          role: null,
          member: undefined,
        }
      : {
          id: state.noManifest ? null : 'scout-manifest',
          name: state.name,
          unknown: state.unknown,
          visual: state.noManifest ? null : { emoji: '🦊', color: 'hsl(20 80% 50%)' },
          role: null,
          member: undefined,
        },
}));
vi.mock('@/layers/entities/config', () => ({
  useConfig: () => ({ data: { profile: { displayName: state.displayName } } }),
  useShowSessions: () => state.showSessions,
}));

afterEach(() => {
  cleanup();
  state.mode = 'off';
  state.name = null;
  state.displayName = null;
  state.showSessions = false;
  state.noManifest = false;
  state.unknown = false;
  state.lookupFailed = false;
  state.keptName = null;
});

const AT_FOLDER = { id: 'm', name: 'scout', displayName: 'Scout' } as unknown as AgentManifest;

describe('useSessionSurface', () => {
  it('is a session with today’s placeholder while the chat is not a DM', () => {
    const { result } = renderHook(() => useSessionSurface('s', AT_FOLDER));
    expect(result.current).toEqual({
      directMessage: null,
      humanName: null,
      transcriptNames: { directMessage: null, humanName: null },
      placeholder: 'Message Scout…',
      quietTurnNumbers: false,
    });

    const bare = renderHook(() => useSessionSurface('s', null));
    expect(bare.result.current.placeholder).toBe('Send a message…');
  });

  it('names the person in a chat that is not a DM, too (FB-38/55)', () => {
    state.displayName = '  Dorian ';
    const { result } = renderHook(() => useSessionSurface('s', AT_FOLDER));
    expect(result.current.directMessage).toBeNull();
    expect(result.current.humanName).toBe('Dorian');
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
        settled: true,
      },
      humanName: 'Dorian',
      transcriptNames: {
        directMessage: result.current.directMessage,
        humanName: 'Dorian',
      },
      placeholder: 'Message Scout',
      quietTurnNumbers: true,
    });
  });

  it('faces a DM whose manifest is gone by name alone, and leaves the runtime out', () => {
    state.mode = 'dm';
    state.name = 'Tern';
    state.noManifest = true;
    const { result } = renderHook(() => useSessionSurface('s', null));
    expect(result.current.directMessage?.agent).toEqual({
      id: 'unknown-agent:/agents/scout',
      displayName: 'Tern',
    });
    expect(result.current.placeholder).toBe('Message Tern');
  });

  it('does not ask you to message "Unknown agent", or the agent at the folder', () => {
    state.mode = 'dm';
    state.name = 'Unknown agent';
    state.noManifest = true;
    state.unknown = true;
    const { result } = renderHook(() => useSessionSurface('s', AT_FOLDER));
    expect(result.current.directMessage?.agent?.displayName).toBe('Unknown agent');
    expect(result.current.placeholder).toBe('Send a message…');
  });

  it('gives the rows the kept name while the manifest is still out', () => {
    state.mode = 'dm';
    state.keptName = 'Tern';
    const { result } = renderHook(() => useSessionSurface('s', null));
    expect(result.current.directMessage?.agent).toEqual({
      id: 'unknown-agent:/agents/scout',
      displayName: 'Tern',
    });
    // The box waits for a settled name, as the bar does.
    expect(result.current.placeholder).toBe('Send a message…');
  });

  it('tells the transcript when the lookup failed, and only then', () => {
    expect(renderHook(() => useSessionSurface('s', null)).result.current.transcriptNames).toEqual({
      directMessage: null,
      humanName: null,
    });
    state.lookupFailed = true;
    const { result } = renderHook(() => useSessionSurface('s', null));
    expect(result.current.directMessage).toBeNull();
    expect(result.current.transcriptNames).toMatchObject({ lookupFailed: true });
  });

  it('shows the turn’s time and tokens in a DM only with Show sessions on', () => {
    state.mode = 'dm';
    state.name = 'Scout';
    state.showSessions = true;
    const { result } = renderHook(() => useSessionSurface('s', null));
    expect(result.current.quietTurnNumbers).toBe(false);
  });

  it('draws neutral while it asks, keeping today’s names until it knows', () => {
    state.mode = 'pending';
    state.displayName = 'Dorian';
    const { result } = renderHook(() => useSessionSurface('s', AT_FOLDER));
    expect(result.current.directMessage).toEqual({ agent: null, humanName: null, settled: false });
    expect(result.current.quietTurnNumbers).toBe(true);
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

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';

import { useAgentBirthStore } from '@/layers/shared/model';
import { useAutoKickoff, __resetFiredKickoffsForTest } from '../model/kickoff/use-auto-kickoff';
import type { ChatStatus } from '../model/chat-types';

const RECORD = {
  name: 'linear-keeper',
  displayName: 'Keeper',
  bornAt: '2026-07-20T00:00:00.000Z',
  path: '/agents/linear-keeper',
  runtime: 'claude-code',
  kickoffMessage: '<dork-kickoff>\nintroduce yourself\n</dork-kickoff>',
};

function seedBirth(sessionId: string) {
  useAgentBirthStore.getState().register(sessionId, RECORD);
}

describe('useAutoKickoff', () => {
  beforeEach(() => {
    useAgentBirthStore.setState({ records: {} });
    __resetFiredKickoffsForTest();
  });

  afterEach(() => {
    cleanup();
  });

  it('fires the kickoff once, with the record message, for a fresh birth session', () => {
    seedBirth('sess-1');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );
    expect(submitKickoff).toHaveBeenCalledTimes(1);
    expect(submitKickoff).toHaveBeenCalledWith(RECORD.kickoffMessage);
    expect(useAgentBirthStore.getState().records['sess-1'].fired).toBe(true);
  });

  it('does not re-fire when the same session remounts (fired latch + module guard)', () => {
    seedBirth('sess-1');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    const first = renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );
    first.unmount();
    // Remount a brand-new hook instance for the same session (e.g. navigating
    // away and back within the page). The birth record is still present.
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );
    expect(submitKickoff).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire across the create-on-first-message rekey', () => {
    seedBirth('client-id');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      (props: { sessionId: string; status: ChatStatus; messageCount: number }) =>
        useAutoKickoff({ ...props, cwd: null, submitKickoff }),
      { initialProps: { sessionId: 'client-id', status: 'idle' as ChatStatus, messageCount: 0 } }
    );
    expect(submitKickoff).toHaveBeenCalledTimes(1);

    // The rekey migrates the birth record to the canonical id; the session is
    // now streaming (the kickoff turn started). The canonical remount must not
    // re-fire.
    useAgentBirthStore.getState().migrate('client-id', 'canonical-id');
    rerender({ sessionId: 'canonical-id', status: 'streaming', messageCount: 0 });
    expect(submitKickoff).toHaveBeenCalledTimes(1);
  });

  it('never fires into a session that already has messages', () => {
    seedBirth('sess-1');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 3,
        submitKickoff,
      })
    );
    expect(submitKickoff).not.toHaveBeenCalled();
  });

  it('never fires into a session that is already streaming', () => {
    seedBirth('sess-1');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'streaming',
        messageCount: 0,
        submitKickoff,
      })
    );
    expect(submitKickoff).not.toHaveBeenCalled();
  });

  it('is a no-op for an ordinary session with no birth record', () => {
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'ordinary',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );
    expect(submitKickoff).not.toHaveBeenCalled();
  });

  it('retries exactly once after a failed trigger, then latches on success', async () => {
    seedBirth('sess-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const submitKickoff = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );

    // The failure un-latches (store update re-runs the effect) → one retry.
    await waitFor(() => expect(submitKickoff).toHaveBeenCalledTimes(2));
    expect(useAgentBirthStore.getState().records['sess-1'].fired).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops after the single retry when the trigger keeps failing (no hot loop)', async () => {
    seedBirth('sess-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const submitKickoff = vi.fn().mockRejectedValue(new Error('still down'));
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );

    await waitFor(() => expect(submitKickoff).toHaveBeenCalledTimes(2));
    // Let any (buggy) further retries surface before asserting the bound.
    await new Promise((r) => setTimeout(r, 20));
    expect(submitKickoff).toHaveBeenCalledTimes(2);
    // Latched for good: the record stays fired so nothing re-arms later.
    expect(useAgentBirthStore.getState().records['sess-1'].fired).toBe(true);
    // The spent retry marks the greeting as failed → the empty session shows an
    // honest line, never a dead Retry button.
    await waitFor(() =>
      expect(useAgentBirthStore.getState().records['sess-1'].greetingFailed).toBe(true)
    );
    warn.mockRestore();
  });

  it('does not mark the greeting failed when the retry succeeds', async () => {
    seedBirth('sess-1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const submitKickoff = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'sess-1',
        cwd: null,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );

    await waitFor(() => expect(submitKickoff).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(useAgentBirthStore.getState().records['sess-1'].greetingFailed).toBeUndefined();
    warn.mockRestore();
  });

  // The onboarding-created case (create WITHOUT navigating to a session): the
  // birth is recorded under an id nobody visits; the agent's real first session
  // claims it by directory and produces the hello exactly once.
  it('claims an unvisited birth by directory on the first fresh session and fires once', async () => {
    seedBirth('never-visited-id');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderHook(() =>
      useAutoKickoff({
        sessionId: 'first-real-session',
        cwd: RECORD.path,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );

    // The claim re-keys the record; the effect re-run fires the kickoff.
    await waitFor(() => expect(submitKickoff).toHaveBeenCalledTimes(1));
    expect(submitKickoff).toHaveBeenCalledWith(RECORD.kickoffMessage);
    expect(useAgentBirthStore.getState().records['first-real-session'].fired).toBe(true);
    expect(useAgentBirthStore.getState().records['never-visited-id']).toBeUndefined();

    // A remount of the same session (or any later fresh session in the dir —
    // the record is now fired) never fires again.
    unmount();
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'first-real-session',
        cwd: RECORD.path,
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );
    expect(submitKickoff).toHaveBeenCalledTimes(1);
  });

  it('never claims a birth for a different directory', () => {
    seedBirth('never-visited-id');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'unrelated-session',
        cwd: '/agents/some-other-agent',
        status: 'idle',
        messageCount: 0,
        submitKickoff,
      })
    );
    expect(submitKickoff).not.toHaveBeenCalled();
    expect(useAgentBirthStore.getState().records['never-visited-id']).toBeDefined();
  });

  it('never claims into a session that already has messages', () => {
    seedBirth('never-visited-id');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    renderHook(() =>
      useAutoKickoff({
        sessionId: 'old-session-same-dir',
        cwd: RECORD.path,
        status: 'idle',
        messageCount: 5,
        submitKickoff,
      })
    );
    expect(submitKickoff).not.toHaveBeenCalled();
    // The record stays parked under its original key for a truly fresh session.
    expect(useAgentBirthStore.getState().records['never-visited-id']).toBeDefined();
  });
});

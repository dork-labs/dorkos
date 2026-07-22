// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup, waitFor } from '@testing-library/react';

import { useAgentBirthStore } from '@/layers/shared/model';
import { useAutoKickoff, __resetFiredKickoffsForTest } from '../model/kickoff/use-auto-kickoff';
import type { ChatMessage, ChatStatus } from '../model/chat-types';

const RECORD = {
  name: 'linear-keeper',
  displayName: 'Keeper',
  agentId: 'agent_linear_keeper',
  bornAt: '2026-07-20T00:00:00.000Z',
  path: '/agents/linear-keeper',
  runtime: 'claude-code',
  kickoffMessage: '<dork-kickoff>\nintroduce yourself\n</dork-kickoff>',
};

function seedBirth(sessionId: string) {
  useAgentBirthStore.getState().register(sessionId, RECORD);
}

/** `n` assistant messages carrying genuine text — real landed content. */
function textMsgs(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    role: 'assistant' as const,
    content: 'Hello there',
    parts: [{ type: 'text' as const, text: 'Hello there' }],
    timestamp: '',
  }));
}

/**
 * A single assistant message whose ONLY part is an error — the transient render
 * a typed mid-stream error produces before the turn_end reload drops it (for a
 * runtime that does not persist the injected error, e.g. claude-code). It is NOT
 * genuine landed content.
 */
function errorOnlyMsgs(): ChatMessage[] {
  return [
    {
      id: 'err',
      role: 'assistant',
      content: '',
      parts: [{ type: 'error', message: 'the turn exploded' }],
      timestamp: '',
    },
  ];
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
      })
    );
    expect(submitKickoff).toHaveBeenCalledTimes(1);
  });

  it('does not re-fire across the create-on-first-message rekey', () => {
    seedBirth('client-id');
    const submitKickoff = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      (props: { sessionId: string; status: ChatStatus; messages: ChatMessage[] }) =>
        useAutoKickoff({
          ...props,
          cwd: null,
          hydrated: true,
          submitKickoff,
          submitContent: vi.fn().mockResolvedValue(undefined),
        }),
      { initialProps: { sessionId: 'client-id', status: 'idle' as ChatStatus, messages: [] } }
    );
    expect(submitKickoff).toHaveBeenCalledTimes(1);

    // The rekey migrates the birth record to the canonical id; the session is
    // now streaming (the kickoff turn started). The canonical remount must not
    // re-fire.
    useAgentBirthStore.getState().migrate('client-id', 'canonical-id');
    rerender({ sessionId: 'canonical-id', status: 'streaming', messages: [] });
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
        messages: textMsgs(3),
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: [],
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
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
        messages: textMsgs(5),
        hydrated: true,
        submitKickoff,
        submitContent: vi.fn().mockResolvedValue(undefined),
      })
    );
    expect(submitKickoff).not.toHaveBeenCalled();
    // The record stays parked under its original key for a truly fresh session.
    expect(useAgentBirthStore.getState().records['never-visited-id']).toBeDefined();
  });

  // Mid-stream failure: the trigger 202'd (so the rejection retry path never
  // runs and `fired` stays latched), but the turn started then died before any
  // assistant text. The session must not fall back to the generic empty copy.
  describe('mid-greeting failure (a 202-accepted turn that dies before any text)', () => {
    /** Drive the kickoff lifecycle via rerenders; `submitKickoff` always resolves. */
    function driveKickoff() {
      const submitKickoff = vi.fn().mockResolvedValue(undefined);
      const view = renderHook<
        void,
        { status: ChatStatus; messages: ChatMessage[]; hydrated?: boolean }
      >(
        (props) =>
          useAutoKickoff({
            sessionId: 'sess-1',
            cwd: null,
            submitKickoff,
            submitContent: vi.fn().mockResolvedValue(undefined),
            hydrated: props.hydrated ?? true,
            status: props.status,
            messages: props.messages,
          }),
        { initialProps: { status: 'idle', messages: [] } }
      );
      return { ...view, submitKickoff };
    }

    function greetingFailed(): boolean | undefined {
      return useAgentBirthStore.getState().records['sess-1'].greetingFailed;
    }

    it('marks the greeting failed when the kickoff turn ERRORS with no output', () => {
      seedBirth('sess-1');
      const { rerender, submitKickoff } = driveKickoff();
      expect(submitKickoff).toHaveBeenCalledTimes(1);

      // The trigger 202'd and the turn started streaming — nothing failed yet.
      rerender({ status: 'streaming', messages: [] });
      expect(greetingFailed()).toBeUndefined();

      // …then it errors with no rendered content at all.
      rerender({ status: 'error', messages: [] });
      expect(greetingFailed()).toBe(true);
    });

    // The REAL claude-code pipeline: a typed error folds into a rendered error
    // part (the message list transiently has ONE entry), the turn settles, then
    // useTurnEndReconcile reloads canonical history and — because claude-code does
    // not persist the injected error — the error part vanishes and the list
    // returns to empty. The marker must SURVIVE the error-only blip so the honest
    // flip fires after the reconcile.
    it('marks failed after an error-only render blips then reconciles back to empty', () => {
      seedBirth('sess-1');
      const { rerender } = driveKickoff();

      // Turn starts → marker set.
      rerender({ status: 'streaming', messages: [] });
      // The typed error renders as an error-only bubble WHILE the turn is still
      // open. messageCount is now 1, but it is not genuine content — the marker
      // must NOT be cleared here (the pre-fix bug deleted it on any count > 0).
      rerender({ status: 'streaming', messages: errorOnlyMsgs() });
      expect(greetingFailed()).toBeUndefined();

      // turn_end + reconcile drop the unpersisted error → the list is empty again.
      rerender({ status: 'idle', messages: [] });
      expect(greetingFailed()).toBe(true);
    });

    it('marks the greeting failed when the kickoff turn ENDS empty (settles idle, no text)', () => {
      seedBirth('sess-1');
      const { rerender } = driveKickoff();

      rerender({ status: 'streaming', messages: [] });
      rerender({ status: 'idle', messages: [] });
      expect(greetingFailed()).toBe(true);
    });

    it('does NOT flip when the kickoff turn streams a greeting successfully', () => {
      seedBirth('sess-1');
      const { rerender } = driveKickoff();

      rerender({ status: 'streaming', messages: [] }); // turn live
      rerender({ status: 'streaming', messages: textMsgs(1) }); // greeting text lands
      rerender({ status: 'idle', messages: textMsgs(1) }); // turn settles
      expect(greetingFailed()).toBeUndefined();
    });

    it('does NOT flip a session whose greeting landed, even when a LATER turn fails', () => {
      seedBirth('sess-1');
      const { rerender } = driveKickoff();

      // The greeting lands and the kickoff turn settles.
      rerender({ status: 'streaming', messages: [] });
      rerender({ status: 'idle', messages: textMsgs(1) });
      // A later user turn runs and then errors — but the greeting is still there,
      // so the session is never empty and must stay untouched.
      rerender({ status: 'streaming', messages: textMsgs(2) });
      rerender({ status: 'error', messages: textMsgs(2) });
      expect(greetingFailed()).toBeUndefined();
    });

    it('does NOT flip before the turn is ever observed streaming (no false positive)', () => {
      // A record that fired but whose turn was never seen live (e.g. the status
      // prop stays idle) must not be marked — only a turn observed streaming and
      // then settling empty counts as a mid-stream death.
      seedBirth('sess-1');
      const { rerender } = driveKickoff();

      rerender({ status: 'idle', messages: [] });
      expect(greetingFailed()).toBeUndefined();
    });

    it('does NOT flip a successful newborn revisited BEFORE it rehydrates (hydration gate)', () => {
      seedBirth('sess-1');
      const { rerender } = driveKickoff();

      // The turn was seen streaming (marker set) before the person switched away.
      rerender({ status: 'streaming', messages: [] });
      // Revisit before the snapshot lands: momentarily empty + idle, but the
      // greeting actually succeeded server-side — the hydration gate holds off.
      rerender({ status: 'idle', messages: [], hydrated: false });
      expect(greetingFailed()).toBeUndefined();
      // Once hydrated, the greeting loads → genuine content → still no flip.
      rerender({ status: 'idle', messages: textMsgs(1), hydrated: true });
      expect(greetingFailed()).toBeUndefined();
    });

    it('never marks an ordinary session with no birth record', () => {
      const submitKickoff = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook(
        (props: { status: ChatStatus; messages: ChatMessage[] }) =>
          useAutoKickoff({
            sessionId: 'ordinary',
            cwd: null,
            submitKickoff,
            submitContent: vi.fn().mockResolvedValue(undefined),
            hydrated: true,
            ...props,
          }),
        { initialProps: { status: 'streaming' as ChatStatus, messages: [] as ChatMessage[] } }
      );
      rerender({ status: 'error', messages: [] });
      expect(useAgentBirthStore.getState().records['ordinary']).toBeUndefined();
    });
  });

  // The onboarding-dissolve case (ADR 260722-111316): a `first-message` birth
  // record carries the USER's typed words, so it fires through the NORMAL
  // submission path (the user's own bubble renders) rather than the kickoff path.
  describe('first-message records (onboarding dissolve)', () => {
    const FIRST_MESSAGE_RECORD = {
      ...RECORD,
      kind: 'first-message' as const,
      kickoffMessage: 'help me set up a project',
    };

    it('submits via the normal path, never the kickoff path, and latches fired', () => {
      useAgentBirthStore.getState().register('sess-1', FIRST_MESSAGE_RECORD);
      const submitKickoff = vi.fn().mockResolvedValue(undefined);
      const submitContent = vi.fn().mockResolvedValue(undefined);
      renderHook(() =>
        useAutoKickoff({
          sessionId: 'sess-1',
          cwd: null,
          status: 'idle',
          messages: [],
          hydrated: true,
          submitKickoff,
          submitContent,
        })
      );
      expect(submitContent).toHaveBeenCalledTimes(1);
      expect(submitContent).toHaveBeenCalledWith('help me set up a project');
      expect(submitKickoff).not.toHaveBeenCalled();
      expect(useAgentBirthStore.getState().records['sess-1'].fired).toBe(true);
    });

    it('does not mark the greeting failed when the send keeps failing (standard send-error affordance)', async () => {
      useAgentBirthStore.getState().register('sess-1', FIRST_MESSAGE_RECORD);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const submitKickoff = vi.fn().mockResolvedValue(undefined);
      const submitContent = vi.fn().mockRejectedValue(new Error('send down'));
      renderHook(() =>
        useAutoKickoff({
          sessionId: 'sess-1',
          cwd: null,
          status: 'idle',
          messages: [],
          hydrated: true,
          submitKickoff,
          submitContent,
        })
      );

      // One retry, same as kickoff — but no greeting-failed line: a failed user
      // send surfaces the normal path's own error, not the newborn's honest line.
      await waitFor(() => expect(submitContent).toHaveBeenCalledTimes(2));
      await new Promise((r) => setTimeout(r, 20));
      expect(submitContent).toHaveBeenCalledTimes(2);
      expect(useAgentBirthStore.getState().records['sess-1'].greetingFailed).toBeUndefined();
      warn.mockRestore();
    });

    it('does not mark the greeting failed when a first-message turn settles empty', () => {
      useAgentBirthStore.getState().register('sess-1', FIRST_MESSAGE_RECORD);
      const submitKickoff = vi.fn().mockResolvedValue(undefined);
      const submitContent = vi.fn().mockResolvedValue(undefined);
      const { rerender } = renderHook<void, { status: ChatStatus; messages: ChatMessage[] }>(
        (props) =>
          useAutoKickoff({
            sessionId: 'sess-1',
            cwd: null,
            submitKickoff,
            submitContent,
            hydrated: true,
            status: props.status,
            messages: props.messages,
          }),
        { initialProps: { status: 'idle', messages: [] } }
      );

      // A user turn that starts then produces no assistant text is an ordinary
      // quiet session, never a failed greeting.
      rerender({ status: 'streaming', messages: [] });
      rerender({ status: 'idle', messages: [] });
      expect(useAgentBirthStore.getState().records['sess-1'].greetingFailed).toBeUndefined();
    });
  });
});

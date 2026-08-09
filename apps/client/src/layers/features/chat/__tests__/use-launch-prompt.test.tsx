// @vitest-environment jsdom
/**
 * The `?prompt=` / `?send=1` launch deep link, at the seam that decides whether
 * a link's words reach a session.
 *
 * Two properties are the whole feature, and both are about NOT happening twice:
 * a prompt seeds a composer at most once, and `send=1` starts at most one turn.
 * Everything else here is the set of situations that must not count as either —
 * a conversation that already has messages, a composer somebody has typed in, a
 * session whose history has not landed yet, a re-render, a remount.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

import { useLaunchPrompt, __resetLaunchPromptsForTest } from '../model/launch/use-launch-prompt';
import type { ChatStatus } from '../model/chat-types';

const PROMPT = 'summarize the release notes';

interface Harness {
  sessionId?: string | null;
  prompt?: string;
  autoSend?: boolean;
  input?: string;
  messageCount?: number;
  hydrated?: boolean;
  status?: ChatStatus;
}

function setup(overrides: Harness = {}) {
  const setInput = vi.fn();
  const submit = vi.fn().mockResolvedValue(undefined);
  const onSeeded = vi.fn();
  const onConsumed = vi.fn();

  const view = renderHook(
    (params: Harness) =>
      useLaunchPrompt({
        sessionId: params.sessionId ?? 'sess-1',
        prompt: params.prompt,
        autoSend: params.autoSend ?? false,
        input: params.input ?? '',
        setInput,
        messageCount: params.messageCount ?? 0,
        hydrated: params.hydrated ?? true,
        status: params.status ?? 'idle',
        submit,
        onSeeded,
        onConsumed,
      }),
    { initialProps: { prompt: PROMPT, ...overrides } }
  );

  return { ...view, setInput, submit, onSeeded, onConsumed };
}

describe('useLaunchPrompt', () => {
  beforeEach(() => {
    __resetLaunchPromptsForTest();
  });

  afterEach(() => {
    cleanup();
  });

  describe('prefill', () => {
    it('seeds the composer with the launch prompt and focuses it', () => {
      const { setInput, onSeeded } = setup();
      expect(setInput).toHaveBeenCalledWith(PROMPT);
      expect(onSeeded).toHaveBeenCalledTimes(1);
    });

    it('seeds exactly once across re-renders — a render is not a new launch', () => {
      const { setInput, rerender } = setup();
      rerender({ prompt: PROMPT, input: PROMPT });
      rerender({ prompt: PROMPT, input: PROMPT });
      expect(setInput).toHaveBeenCalledTimes(1);
    });

    it('does not re-seed after a remount (back-navigation onto the same URL)', () => {
      const first = setup();
      expect(first.setInput).toHaveBeenCalledTimes(1);
      cleanup();

      const second = setup();
      expect(second.setInput).not.toHaveBeenCalled();
    });

    it('never clobbers text somebody already typed', () => {
      const { setInput } = setup({ input: 'half a thought' });
      expect(setInput).not.toHaveBeenCalled();
    });

    it('never enters a conversation that already has messages', () => {
      const { setInput } = setup({ messageCount: 3 });
      expect(setInput).not.toHaveBeenCalled();
    });

    it('ignores a blank prompt', () => {
      const { setInput, onConsumed } = setup({ prompt: '   ' });
      expect(setInput).not.toHaveBeenCalled();
      expect(onConsumed).not.toHaveBeenCalled();
    });

    it('drops the launch params from the URL once a prefill-only link is spent', () => {
      const { onConsumed } = setup();
      expect(onConsumed).toHaveBeenCalledTimes(1);
    });
  });

  describe('auto-send', () => {
    it('does not send at all without send=1', () => {
      const { submit, rerender } = setup();
      rerender({ prompt: PROMPT, input: PROMPT });
      expect(submit).not.toHaveBeenCalled();
    });

    it('sends through the composer submit once the seed has landed in the composer', () => {
      const { submit, rerender } = setup({ autoSend: true });
      // The seed is applied by the parent's state, which arrives on the next
      // render — the send must wait for it rather than racing a parallel path.
      expect(submit).not.toHaveBeenCalled();

      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('sends exactly once even while the composer still reads as seeded', () => {
      const { submit, rerender } = setup({ autoSend: true });
      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT });
      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT });
      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('does not send again after a remount on the same session and prompt', () => {
      const first = setup({ autoSend: true });
      first.rerender({ prompt: PROMPT, autoSend: true, input: PROMPT });
      expect(first.submit).toHaveBeenCalledTimes(1);
      cleanup();

      const second = setup({ autoSend: true, input: PROMPT });
      expect(second.submit).not.toHaveBeenCalled();
    });

    it('waits for the session history to land before firing', () => {
      const { submit, rerender } = setup({ autoSend: true, hydrated: false });
      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT, hydrated: false });
      expect(submit).not.toHaveBeenCalled();

      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT, hydrated: true });
      expect(submit).toHaveBeenCalledTimes(1);
    });

    it('never fires into a conversation that already has messages', () => {
      const { submit, rerender } = setup({ autoSend: true, messageCount: 2 });
      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT, messageCount: 2 });
      expect(submit).not.toHaveBeenCalled();
    });

    it('never fires while a turn is already streaming', () => {
      const { submit, rerender } = setup({ autoSend: true, status: 'streaming' });
      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT, status: 'streaming' });
      expect(submit).not.toHaveBeenCalled();
    });

    it('drops the launch params from the URL before the turn starts', () => {
      const { onConsumed, submit, rerender } = setup({ autoSend: true });
      // Prefill alone must NOT spend the link — the send still needs the prompt.
      expect(onConsumed).not.toHaveBeenCalled();

      rerender({ prompt: PROMPT, autoSend: true, input: PROMPT });
      expect(onConsumed).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
    });
  });
});

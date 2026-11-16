// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { usePausedComposerDraft } from '../model/use-paused-composer-draft';
import { useSessionChatStore } from '@/layers/entities/session';

const message: QueuedMessage & { canRestoreToComposer?: boolean } = {
  id: 'held',
  content: 'Keep these words',
  disposition: 'queue',
  enqueuedBy: 'web-window',
  canRestoreToComposer: true,
  enqueuedAt: 1,
};
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

afterEach(() => useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] }));

describe('a paused message in the composer', () => {
  function setup(initial = '', remove = vi.fn(async () => undefined), initialQueue = [message]) {
    const send = vi.fn(async (_text: string) => undefined);
    const view = renderHook(
      ({
        paused,
        sessionId,
        queue,
      }: {
        paused: boolean;
        sessionId: string;
        queue?: QueuedMessage[];
      }) => {
        const [input, setInput] = useState(initial);
        const draft = usePausedComposerDraft({
          sessionId,
          paused,
          queue: queue ?? initialQueue,
          personClientIds: ['web-window'],
          input,
          setInput,
          send,
          remove,
        });
        return { ...draft, input, setInput };
      },
      {
        initialProps: { paused: true, sessionId: 'demo' } as {
          paused: boolean;
          sessionId: string;
          queue?: QueuedMessage[];
        },
      }
    );
    return { ...view, send, remove };
  }

  it('restores the held words, keeps them on resume, and sends only on Send', async () => {
    const { result, rerender, send, remove } = setup();
    await waitFor(() => expect(result.current.input).toBe('Keep these words'));
    await act(() => result.current.submit());
    expect(send).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    rerender({ paused: false, sessionId: 'demo' });
    expect(result.current.input).toBe('Keep these words');
    expect(send).not.toHaveBeenCalled();
    await act(() => result.current.submit());
    expect(remove).toHaveBeenCalledExactlyOnceWith('demo', 'held');
    expect(send).toHaveBeenCalledExactlyOnceWith('Keep these words');
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
  });

  it('preserves a different draft instead of overwriting it', () => {
    const { result } = setup('A newer draft');
    expect(result.current.input).toBe('A newer draft');
  });

  it('keeps an edited held draft bound to its row after the composer remounts', async () => {
    const first = setup();
    act(() => first.result.current.setInput('Keep these edited words'));
    first.unmount();
    const second = setup('Keep these edited words');
    expect(second.result.current.restored).toBe(true);
    second.rerender({ paused: false, sessionId: 'demo' });
    await act(() => second.result.current.submit());
    expect(second.remove).toHaveBeenCalledExactlyOnceWith('demo', 'held');
    expect(second.send).toHaveBeenCalledExactlyOnceWith('Keep these edited words');
  });

  it.each(['heartbeat', 'todos', 'extension:flow', 'task:demo'])(
    'never restores a non-person row from %s',
    (enqueuedBy) => {
      const { result } = setup('', undefined, [{ ...message, enqueuedBy }]);
      expect(result.current.input).toBe('');
      expect(result.current.restored).toBe(false);
    }
  );

  it('never restores a row the server cannot safely return to the composer', () => {
    const { result } = setup('', undefined, [{ ...message, canRestoreToComposer: false }]);
    expect(result.current.input).toBe('');
  });

  it('hides a restored row and clears its unchanged words if it leaves elsewhere', async () => {
    const { result, rerender, send } = setup();
    expect(result.current.visibleQueue).toEqual([]);
    rerender({ paused: false, sessionId: 'demo', queue: [] });
    await waitFor(() => expect(result.current.input).toBe(''));
    await act(() => result.current.submit());
    expect(send).not.toHaveBeenCalled();
  });

  it('queues the edited held draft once when a peer’s turn is already running', async () => {
    const { result, rerender, send, remove } = setup();
    const enqueue = vi.fn(async (_text: string) => undefined);
    act(() => result.current.setInput('Keep these edited words'));
    rerender({ paused: false, sessionId: 'demo' });
    expect(result.current.restored).toBe(true);
    await act(() => result.current.submit({ deliver: enqueue }));
    expect(remove).toHaveBeenCalledExactlyOnceWith('demo', 'held');
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('Keep these edited words');
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the words and sends nothing if taking the held row off fails', async () => {
    const { result, rerender, send } = setup(
      '',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );
    rerender({ paused: false, sessionId: 'demo' });
    await act(() => result.current.submit());
    expect(send).not.toHaveBeenCalled();
    expect(result.current.input).toBe('Keep these words');
  });
});

// @vitest-environment jsdom
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { QueuedMessage } from '@dorkos/shared/schemas';
import { usePausedComposerDraft } from '../model/use-paused-composer-draft';

const message: QueuedMessage = {
  id: 'held',
  content: 'Keep these words',
  disposition: 'queue',
  enqueuedBy: 'window',
  enqueuedAt: 1,
};
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

describe('a paused message in the composer', () => {
  function setup(initial = '', remove = vi.fn(async () => undefined)) {
    const send = vi.fn(async (_text: string) => undefined);
    const view = renderHook(
      ({ paused, sessionId }) => {
        const [input, setInput] = useState(initial);
        const draft = usePausedComposerDraft({
          sessionId,
          paused,
          queue: [message],
          input,
          setInput,
          send,
          remove,
        });
        return { ...draft, input, setInput };
      },
      { initialProps: { paused: true, sessionId: 'demo' } }
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

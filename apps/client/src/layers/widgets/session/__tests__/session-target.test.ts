// @vitest-environment jsdom
/**
 * The session's `ConversationTarget`, and the one thing about it that is not
 * about sending: it has to hold still.
 *
 * The target is what `Conversation.Root` publishes as its context value, so a
 * target that is a new object every render re-renders the whole transcript —
 * every row, once per streamed token, which is exactly the cost virtualizing
 * the list was paid to remove. Its inputs churn by construction (a fresh files
 * literal, fresh send closures), so holding still is a property this file has
 * to assert rather than assume.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { PendingFile } from '@/layers/features/composer';
import { useSessionTarget, type SessionTargetInput } from '../model/session-target';

/**
 * The staged files, as `use-file-upload` really hands them over: the LITERAL is
 * fresh on every render and everything inside it is stable, because the list is
 * `useState` and every action is a `useCallback`. Faking the literal as stable
 * too would make the churn this file is about impossible to reproduce.
 */
const NOTHING_STAGED: PendingFile[] = [];
const ADD_FILES = vi.fn();
const REMOVE_FILE = vi.fn();
const RETRY_FILE = vi.fn();
const CANCEL_UPLOAD = vi.fn();

/** The session's own machinery, rebuilt fresh on every render — as it really is. */
function input(overrides: Partial<SessionTargetInput> = {}): SessionTargetInput {
  return {
    sessionId: 'session-1',
    placeholder: 'Message DorkBot…',
    submit: vi.fn(),
    enqueue: vi.fn(async () => true),
    queueDepth: 0,
    files: {
      pendingFiles: NOTHING_STAGED,
      addFiles: ADD_FILES,
      removeFile: REMOVE_FILE,
      retryFile: RETRY_FILE,
      cancelUpload: CANCEL_UPLOAD,
      hasFailedUpload: false,
      isUploading: false,
    },
    ...overrides,
  };
}

describe('useSessionTarget', () => {
  it('hands back the same target when nothing about the session changed', () => {
    // **Seeded defect:** depend on `files`, `submit` or `enqueue` directly in
    // the memo — each is a fresh object every render — and this is a new target
    // on every commit, which is a full transcript re-render per streamed token.
    // Run and red.
    const { result, rerender } = renderHook(() => useSessionTarget(input()));
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.attachments).toBe(first.attachments);
  });

  it('sends through whichever submit the latest render handed it', async () => {
    // The flip side of holding still: a stable `send` must not send through a
    // closure from the first render.
    const stale = vi.fn();
    const fresh = vi.fn();
    const { result, rerender } = renderHook(
      (props: SessionTargetInput) => useSessionTarget(props),
      { initialProps: input({ submit: stale }) }
    );

    rerender(input({ submit: fresh }));
    await result.current.send({ text: 'ship it' });

    expect(stale).not.toHaveBeenCalled();
    expect(fresh).toHaveBeenCalledWith('ship it');
  });

  it('changes identity when something the composer draws from changes', () => {
    // A memo that never changes is the other way to pass the first case, and it
    // would leave the box saying the wrong thing.
    const { result, rerender } = renderHook(
      (props: SessionTargetInput) => useSessionTarget(props),
      { initialProps: input() }
    );
    const first = result.current;

    rerender(input({ placeholder: 'Message Scout…' }));

    expect(result.current).not.toBe(first);
    expect(result.current.placeholder).toBe('Message Scout…');
  });
});

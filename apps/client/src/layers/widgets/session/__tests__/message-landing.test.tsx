// @vitest-environment jsdom
/**
 * Landing a conversation on the one message a search hit named (DOR-1579).
 *
 * The conversation's counterpart to `room-view/__tests__/entry-landing.test.tsx`,
 * and deliberately smaller: a room translates a `seq` into a row and may have to
 * open a thread panel, while a conversation has one row per message. What is
 * left to prove is the row id it asks for, and that the request is spent once.
 *
 * Deliberately not about scrolling: jsdom lays nothing out, so "did it land" is
 * `Timeline.test.tsx`'s question in this repo and a browser's beyond it.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useMessageLanding } from '../model/use-message-landing';

afterEach(cleanup);

/**
 * Mount the hook the way `SessionPage` does.
 *
 * Props are an OBJECT rather than two positional arguments with defaults: a
 * default parameter fires on an explicit `undefined` too, so `landing('s', undefined)`
 * would silently mount the default id and the "nothing was asked for" case
 * could never fail.
 */
function landing(overrides: Partial<{ session: string | null; message: string | undefined }> = {}) {
  const initialProps = {
    session: 'sess-1' as string | null,
    message: 'uuid-9' as string | undefined,
    ...overrides,
  };
  return renderHook(
    ({ session, message }: { session: string | null; message: string | undefined }) =>
      useMessageLanding(session, message),
    { initialProps }
  );
}

describe('what a conversation does with ?message=', () => {
  it('asks for the row the message is drawn under, not the bare id', () => {
    // The row id, not the message id: the timeline matches `ConversationRow.id`,
    // and the transcript's rows are keyed `msg-<id>`. Handing over the bare id
    // fails silently — the conversation just opens at the bottom, which looks
    // exactly like a link that was never followed.
    expect(landing().result.current?.()).toBe('msg-uuid-9');
  });

  it('asks for nothing at all when no message was named', () => {
    // `undefined` rather than a getter answering `undefined`: the conversation's
    // usual landing (its unread rule, or its newest message) must be left alone
    // rather than handed a request it then has to discard. Every way into a
    // conversation except a search hit takes this path.
    expect(landing({ message: undefined }).result.current).toBeUndefined();
  });

  it('asks for nothing before a conversation has resolved', () => {
    expect(landing({ session: null }).result.current).toBeUndefined();
  });

  it('is consumed by the first read, so a remount cannot re-answer it', () => {
    // A request that kept answering would outrank the remembered position for
    // the rest of the conversation's life — the exact defect `resumeRow` exists
    // to prevent.
    const { result } = landing();

    expect(result.current?.()).toBe('msg-uuid-9');
    expect(result.current?.()).toBeUndefined();
  });

  it('re-arms for a new message in the conversation already on screen', () => {
    // The whole of "search for something in the conversation you are already
    // reading": an in-place search-param navigation leaves the conversation id
    // alone, so the timeline's own arm guard never lifts and this is the only
    // thing that can move it.
    const { result, rerender } = landing();
    expect(result.current?.()).toBe('msg-uuid-9');

    rerender({ session: 'sess-1', message: 'uuid-10' });

    expect(result.current?.()).toBe('msg-uuid-10');
  });

  it('re-arms for the same message in a different conversation', () => {
    // The marker is keyed on both, so following two hits at the same id in two
    // conversations lands twice rather than once.
    const { result, rerender } = landing();
    expect(result.current?.()).toBe('msg-uuid-9');

    rerender({ session: 'sess-2', message: 'uuid-9' });

    expect(result.current?.()).toBe('msg-uuid-9');
  });
});

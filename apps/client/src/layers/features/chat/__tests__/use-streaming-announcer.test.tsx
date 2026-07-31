// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamingAnnouncer } from '../model/stream/use-streaming-announcer';

/** Longer than the settle window, so a lull is over. */
const AFTER_SETTLE_MS = 1600;
/** Longer than the window an announcement stays in the region. */
const AFTER_CLEAR_MS = 4100;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Advance timers inside an act, so the state they set is committed. */
function tick(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Whatever is in the region, without the invisible change marker. */
function said(value: string): string {
  return value.replace(/\u200B/gu, '');
}

describe('useStreamingAnnouncer', () => {
  it('says a sentence as soon as it closes', () => {
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: 'Look', isStreaming: true },
    });
    expect(said(result.current)).toBe('');
    rerender({ messageId: 'm1', text: 'Looking now. And the', isStreaming: true });
    expect(said(result.current)).toBe('Looking now.');
  });

  it('treats a pause as a pause, not an ending — resuming says only the new words', () => {
    // The regression this hook was rebuilt around: `isTextStreaming` decays
    // within half a second of the tokens stopping, and they stop constantly
    // mid-answer to think or to run a tool. An earlier version took that edge
    // for the end of the turn, let the message go, and re-adopted the SAME
    // message from zero when tokens resumed — replaying the whole answer.
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: 'First sentence.', isStreaming: true },
    });
    expect(said(result.current)).toBe('First sentence.');

    // The pause: streaming goes false while the tool runs, and the settle
    // window passes with the words standing still.
    rerender({ messageId: 'm1', text: 'First sentence.', isStreaming: false });
    tick(AFTER_SETTLE_MS);
    expect(said(result.current)).toBe('First sentence.');

    // Tokens resume on the same message.
    rerender({
      messageId: 'm1',
      text: 'First sentence. Second sentence.',
      isStreaming: true,
    });
    expect(said(result.current)).toBe('Second sentence.');
    expect(said(result.current)).not.toContain('First sentence.');
  });

  it('says the leftover tail once the words stop moving', () => {
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: 'Done.', isStreaming: true },
    });
    rerender({ messageId: 'm1', text: 'Done. No full stop here', isStreaming: false });
    expect(said(result.current)).toBe('Done.');
    tick(AFTER_SETTLE_MS);
    expect(said(result.current)).toBe('No full stop here');
  });

  it('says nothing about a conversation that is merely opened', () => {
    const { result } = renderHook(() =>
      useStreamingAnnouncer({ messageId: 'm1', text: 'All done here.', isStreaming: false })
    );
    tick(AFTER_SETTLE_MS);
    expect(said(result.current)).toBe('');
  });

  it('does not read out the backlog when a half-streamed message arrives at once', () => {
    // A reconnected stream replays what it already sent. Picking that up from
    // its beginning is a wall of speech about something that already happened,
    // so it is picked up where it stands.
    const backlog = `${'Sentence about the sea. '.repeat(40)}`;
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: backlog, isStreaming: true },
    });
    expect(said(result.current)).toBe('');
    rerender({ messageId: 'm1', text: `${backlog}And this is new.`, isStreaming: true });
    expect(said(result.current)).toBe('And this is new.');
  });

  it('empties itself, so a remount is silent', () => {
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: 'Said once.', isStreaming: true },
    });
    expect(said(result.current)).toBe('Said once.');
    rerender({ messageId: 'm1', text: 'Said once.', isStreaming: false });
    tick(AFTER_CLEAR_MS);
    expect(said(result.current)).toBe('');
  });

  it('makes two identical sentences in a row two different announcements', () => {
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: 'Same words.', isStreaming: true },
    });
    const first = result.current;
    rerender({ messageId: 'm1', text: 'Same words. Same words.', isStreaming: true });
    const second = result.current;
    expect(said(first)).toBe(said(second));
    // Identical DOM text is a no-op React never commits and no screen reader
    // ever speaks twice.
    expect(first).not.toBe(second);
  });

  it('starts a second turn from its own beginning', () => {
    const { result, rerender } = renderHook((props) => useStreamingAnnouncer(props), {
      initialProps: { messageId: 'm1', text: 'First answer.', isStreaming: true },
    });
    expect(said(result.current)).toBe('First answer.');
    rerender({ messageId: 'm2', text: 'Second answer.', isStreaming: true });
    expect(said(result.current)).toBe('Second answer.');
  });
});

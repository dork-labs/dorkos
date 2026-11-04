// @vitest-environment jsdom
/**
 * The conversation's wait for "is this a DM" has a limit (DOR-3074): under it
 * the conversation appears once, past it the conversation draws anyway, and a
 * late DM answer asks the timeline to land again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { AGENT_IDENTITY_LIMIT_MS } from '@/layers/shared/lib';
import {
  TRANSCRIPT_HOLD_MS,
  TRANSCRIPT_LOADING_MS,
  useLoadingTooLong,
  useTranscriptHold,
} from '../model/use-transcript-hold';

/** One animation frame, as the fake timers run them. */
const FRAME = 16;

interface Props {
  id: string;
  undecided: boolean;
  dm: boolean;
  ready?: boolean;
  identity?: boolean;
}

function mount(initial: Partial<Props> = {}) {
  return renderHook(
    ({ id, undecided, dm, ready = true, identity = false }: Props) =>
      useTranscriptHold(id, undecided, dm, ready, identity),
    {
      initialProps: { id: 'chat-1', undecided: true, dm: false, ...initial } as Props,
    }
  );
}

describe('useTranscriptHold', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is 300ms, the limit the design asks for', () => {
    expect(TRANSCRIPT_HOLD_MS).toBe(300);
  });

  it('holds until the limit, then lets go with the answer still out', () => {
    const { result } = mount();
    expect(result.current.held).toBe(true);
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS - 1));
    expect(result.current.held).toBe(true);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current.held).toBe(false);
    expect(result.current.landingKey).toBeUndefined();
  });

  it('lets the landing run first, and shows the conversation only after it has arrived', () => {
    const { result } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    // The landing may run now, and nothing may be seen yet: this is the frame
    // that showed the oldest message.
    expect(result.current).toMatchObject({ held: false, hidden: true });
    act(() => void vi.advanceTimersByTime(FRAME));
    expect(result.current.hidden).toBe(true);
    act(() => void vi.advanceTimersByTime(FRAME * 3));
    expect(result.current.hidden).toBe(false);
  });

  it('stays unseen after the limit until the landing has what it needs', () => {
    const { result, rerender } = mount({ ready: false });
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS + FRAME * 10));
    expect(result.current).toMatchObject({ held: false, hidden: true });

    rerender({ id: 'chat-1', undecided: true, dm: false, ready: true });
    expect(result.current.hidden).toBe(true);
    act(() => void vi.advanceTimersByTime(FRAME * 4));
    expect(result.current.hidden).toBe(false);
  });

  it('says it is loading past the second limit, and not before, while the landing cannot run', () => {
    const { result, rerender } = mount({ ready: false });
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS - 1));
    expect(result.current.showLoading).toBe(false);
    act(() => void vi.advanceTimersByTime(1));
    expect(result.current).toMatchObject({ hidden: true, showLoading: true });

    // Ready: the loading state goes, and the list still lands before it shows.
    rerender({ id: 'chat-1', undecided: true, dm: false, ready: true });
    expect(result.current).toMatchObject({ held: false, hidden: true, showLoading: false });
    act(() => void vi.advanceTimersByTime(FRAME * 4));
    expect(result.current).toMatchObject({ hidden: false, showLoading: false });
  });

  it('never says it is loading for a chat that was ready in time', () => {
    const { result } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS * 2));
    expect(result.current.showLoading).toBe(false);
  });

  it('does not carry the loading state to the next conversation', () => {
    const { result, rerender } = mount({ ready: false });
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS));
    expect(result.current.showLoading).toBe(true);
    rerender({ id: 'chat-2', undecided: true, dm: false, ready: false });
    expect(result.current.showLoading).toBe(false);
  });

  describe('while the agent’s name and face are on their way', () => {
    it('holds a chat with no other reason to wait, and its landing with it', () => {
      const { result } = mount({ undecided: false, identity: true });
      expect(result.current).toMatchObject({ held: true, hidden: true });
    });

    it('does not let go at the first limit, and says it is loading past the second', () => {
      const { result } = mount({ identity: true });
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS + 1));
      expect(result.current).toMatchObject({ held: true, hidden: true, showLoading: false });
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS));
      expect(result.current).toMatchObject({ held: true, hidden: true, showLoading: true });
    });

    it('lets go at the last limit, so nobody waits for good', () => {
      const { result } = mount({ identity: true });
      act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS - 1));
      expect(result.current).toMatchObject({ held: true, hidden: true, showLoading: true });
      act(() => void vi.advanceTimersByTime(1));
      expect(result.current.held).toBe(false);
      act(() => void vi.advanceTimersByTime(FRAME * 4));
      expect(result.current).toMatchObject({ hidden: false, showLoading: false });
    });

    it('gives each conversation its own last limit', () => {
      const { result, rerender } = mount({ identity: true });
      act(() => void vi.advanceTimersByTime(AGENT_IDENTITY_LIMIT_MS));
      expect(result.current.held).toBe(false);
      rerender({ id: 'chat-2', undecided: true, dm: false, identity: true });
      expect(result.current.held).toBe(true);
    });

    it('lets go once they arrive, landing before it shows', () => {
      const { result, rerender } = mount({ undecided: false, identity: true });
      rerender({ id: 'chat-1', undecided: false, dm: true, identity: false });
      expect(result.current).toMatchObject({ held: false, hidden: true, showLoading: false });
      act(() => void vi.advanceTimersByTime(FRAME * 4));
      expect(result.current.hidden).toBe(false);
    });
  });

  describe('useLoadingTooLong', () => {
    it('stays quiet up to the limit, then says so', () => {
      const { result } = renderHook(() => useLoadingTooLong(true, 'chat-1'));
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS - 1));
      expect(result.current).toBe(false);
      act(() => void vi.advanceTimersByTime(1));
      expect(result.current).toBe(true);
    });

    it('never says so for a wait that ended in time', () => {
      const { result, rerender } = renderHook(
        ({ waiting }: { waiting: boolean }) => useLoadingTooLong(waiting, 'chat-1'),
        { initialProps: { waiting: true } }
      );
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS - 1));
      rerender({ waiting: false });
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS));
      expect(result.current).toBe(false);
    });

    it('stops saying so the moment the wait ends, and starts over for the next one', () => {
      const { result, rerender } = renderHook(
        ({ waiting, id }: { waiting: boolean; id: string }) => useLoadingTooLong(waiting, id),
        { initialProps: { waiting: true, id: 'chat-1' } }
      );
      act(() => void vi.advanceTimersByTime(TRANSCRIPT_LOADING_MS));
      expect(result.current).toBe(true);
      rerender({ waiting: false, id: 'chat-1' });
      expect(result.current).toBe(false);
      rerender({ waiting: true, id: 'chat-2' });
      expect(result.current).toBe(false);
    });
  });

  it('does not hide a chat that was never held, however long its landing takes', () => {
    const { result } = mount({ undecided: false, ready: false });
    act(() => void vi.advanceTimersByTime(FRAME * 10));
    expect(result.current.hidden).toBe(false);
  });

  it('does the same when the answer beats the limit', () => {
    const { result, rerender } = mount();
    rerender({ id: 'chat-1', undecided: false, dm: true });
    expect(result.current).toMatchObject({ held: false, hidden: true });
    act(() => void vi.advanceTimersByTime(FRAME * 4));
    expect(result.current.hidden).toBe(false);
  });

  it('asks for no second landing when the answer beats the limit', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS - 1));
    rerender({ id: 'chat-1', undecided: false, dm: true });
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    expect(result.current).toEqual({
      held: false,
      hidden: false,
      showLoading: false,
      landingKey: undefined,
    });
  });

  it('asks the timeline to land again when a late answer reflows it as a DM', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    expect(result.current.landingKey).toBeUndefined();
    rerender({ id: 'chat-1', undecided: false, dm: true });
    expect(result.current).toMatchObject({ held: false, landingKey: 'reflowed-as-dm' });
  });

  it('leaves the landing alone when a late answer agrees with the session layout', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    rerender({ id: 'chat-1', undecided: false, dm: false });
    expect(result.current).toMatchObject({ held: false, landingKey: undefined });
  });

  it('gives each conversation its own wait', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    expect(result.current.held).toBe(false);
    rerender({ id: 'chat-2', undecided: true, dm: false });
    expect(result.current.held).toBe(true);
  });

  it('holds nothing for a chat with no question out', () => {
    const { result } = mount({ undecided: false });
    expect(result.current).toEqual({
      held: false,
      hidden: false,
      showLoading: false,
      landingKey: undefined,
    });
  });
});

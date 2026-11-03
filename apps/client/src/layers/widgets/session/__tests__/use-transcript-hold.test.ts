// @vitest-environment jsdom
/**
 * The conversation's wait for "is this a DM" has a limit (DOR-3074): under it
 * the conversation appears once, past it the conversation draws anyway, and a
 * late DM answer asks the timeline to land again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { TRANSCRIPT_HOLD_MS, useTranscriptHold } from '../model/use-transcript-hold';

interface Props {
  id: string;
  undecided: boolean;
  dm: boolean;
}

function mount(initial: Partial<Props> = {}) {
  return renderHook(({ id, undecided, dm }: Props) => useTranscriptHold(id, undecided, dm), {
    initialProps: { id: 'chat-1', undecided: true, dm: false, ...initial },
  });
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
    expect(result.current).toEqual({ held: false, landingKey: undefined });
  });

  it('asks for no second landing when the answer beats the limit', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS - 1));
    rerender({ id: 'chat-1', undecided: false, dm: true });
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    expect(result.current).toEqual({ held: false, landingKey: undefined });
  });

  it('asks the timeline to land again when a late answer reflows it as a DM', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    expect(result.current.landingKey).toBeUndefined();
    rerender({ id: 'chat-1', undecided: false, dm: true });
    expect(result.current).toEqual({ held: false, landingKey: 'reflowed-as-dm' });
  });

  it('leaves the landing alone when a late answer agrees with the session layout', () => {
    const { result, rerender } = mount();
    act(() => void vi.advanceTimersByTime(TRANSCRIPT_HOLD_MS));
    rerender({ id: 'chat-1', undecided: false, dm: false });
    expect(result.current).toEqual({ held: false, landingKey: undefined });
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
    expect(result.current).toEqual({ held: false, landingKey: undefined });
  });
});

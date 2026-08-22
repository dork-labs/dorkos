// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { AgentVisual } from '@/layers/shared/lib';
import { useLastKnownAgent } from '../model/use-last-known-agent';

const FACE: AgentVisual = { color: 'hsl(210 70% 55%)', emoji: '🤖' };
const OTHER: AgentVisual = { color: 'hsl(10 70% 55%)', emoji: '🦊' };

/** Drive the hook the way the bar does: one session, changing agent state. */
function drive(initial: [string | undefined, string | undefined, AgentVisual | undefined]) {
  return renderHook(([id, name, visual]) => useLastKnownAgent(id, name, visual), {
    initialProps: initial,
  });
}

describe('useLastKnownAgent', () => {
  it('reports the agent it is given', () => {
    const { result } = drive(['s1', 'dorkbot', FACE]);
    expect(result.current).toEqual({ name: 'dorkbot', visual: FACE });
  });

  it('reports nothing when there has never been an agent', () => {
    const { result } = drive(['s1', undefined, undefined]);
    expect(result.current).toEqual({ name: undefined, visual: undefined });
  });

  it('holds the last agent when the record disappears', () => {
    const { result, rerender } = drive(['s1', 'dorkbot', FACE]);
    rerender(['s1', undefined, undefined]);
    expect(result.current).toEqual({ name: 'dorkbot', visual: FACE });
  });

  it('keeps holding across further renders, not just the first one', () => {
    const { result, rerender } = drive(['s1', 'dorkbot', FACE]);
    rerender(['s1', undefined, undefined]);
    rerender(['s1', undefined, undefined]);
    rerender(['s1', undefined, undefined]);
    expect(result.current).toEqual({ name: 'dorkbot', visual: FACE });
  });

  it('drops the hold the moment the session changes', () => {
    const { result, rerender } = drive(['s1', 'dorkbot', FACE]);
    rerender(['s2', undefined, undefined]);
    // The whole reason the hook takes a key: without it, this returns dorkbot
    // and the bar labels a different conversation with the wrong agent.
    expect(result.current).toEqual({ name: undefined, visual: undefined });
  });

  it('adopts the new session’s own agent immediately', () => {
    const { result, rerender } = drive(['s1', 'dorkbot', FACE]);
    rerender(['s2', 'Scout', OTHER]);
    expect(result.current).toEqual({ name: 'Scout', visual: OTHER });
  });

  it('takes a rename rather than holding the old name', () => {
    const { result, rerender } = drive(['s1', 'dorkbot', FACE]);
    rerender(['s1', 'Scout', OTHER]);
    expect(result.current).toEqual({ name: 'Scout', visual: OTHER });
  });

  it('releases the name and the face together, never one without the other', () => {
    const { result, rerender } = drive(['s1', 'dorkbot', FACE]);
    rerender(['s1', undefined, undefined]);
    // A live name beside a stale face is worse than either alone, because it
    // looks correct. They move as one pair or not at all.
    expect(result.current.name).toBe('dorkbot');
    expect(result.current.visual).toBe(FACE);
  });
});

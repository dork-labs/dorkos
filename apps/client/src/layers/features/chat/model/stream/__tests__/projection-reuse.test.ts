/**
 * A streamed event re-uses the work the last one did (DOR-2895): history is
 * mapped once per history array, and an event that changes none of the render
 * inputs gets the very same list back.
 */
import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionStreamState } from '@/layers/entities/session';
import { projectSessionMessages } from '../project-session-turn';
import { selectRenderedMessages } from '../derive-rendered-state';

const history = [
  { id: 'u1', role: 'user', content: 'Hi', parts: [{ type: 'text', text: 'Hi' }] },
  { id: 'a1', role: 'assistant', content: 'Hello', parts: [{ type: 'text', text: 'Hello' }] },
] as unknown as HistoryMessage[];

function stream(overrides: Partial<SessionStreamState> = {}): SessionStreamState {
  return {
    messages: history,
    inProgressTurn: [],
    pendingInteractions: [],
    optimisticUserMessage: null,
    streamReadyCursor: 'c1',
    ...overrides,
  } as unknown as SessionStreamState;
}

describe('projection reuse', () => {
  it('keeps every history message the same object across events', () => {
    const first = projectSessionMessages(history, [], [], null);
    const second = projectSessionMessages(history, [], [], null);
    expect(second).not.toBe(first);
    second.forEach((message, i) => expect(message).toBe(first[i]));
  });

  it('maps a new history array afresh', () => {
    const first = projectSessionMessages(history, [], [], null);
    const replaced = projectSessionMessages([...history], [], [], null);
    expect(replaced[0]).not.toBe(first[0]);
  });

  it('answers an event that changed no render input with the same list', () => {
    const legacy: never[] = [];
    const state = stream();
    const first = selectRenderedMessages(state, legacy);
    // A status or usage event: a new state object, the same render inputs.
    expect(selectRenderedMessages({ ...state } as SessionStreamState, legacy)).toBe(first);
    // A streamed word: the turn moved, so the list is rebuilt.
    const moved = selectRenderedMessages(stream({ inProgressTurn: [] }), legacy);
    expect(moved).not.toBe(first);
  });

  it('rebuilds when any other render input moves', () => {
    const legacy: never[] = [];
    const state = stream();
    const first = selectRenderedMessages(state, legacy);
    // A person's just-sent message must show at once.
    const sent = selectRenderedMessages(
      { ...state, optimisticUserMessage: { id: 'o1', content: 'next' } } as SessionStreamState,
      legacy
    );
    expect(sent).not.toBe(first);
    expect(sent.map((m) => m.content)).toContain('next');
    // A recovered approval card too.
    const sameState = { ...state } as SessionStreamState;
    selectRenderedMessages(sameState, legacy);
    expect(
      selectRenderedMessages({ ...state, pendingInteractions: [] } as SessionStreamState, legacy)
    ).not.toBe(selectRenderedMessages(sameState, legacy));
    // Losing hydration falls back to the legacy list.
    const fallback = [{ id: 'l1', role: 'user', content: 'legacy', parts: [] }] as never[];
    const cold = stream({ messages: history, streamReadyCursor: null, inProgressTurn: [] });
    const hydratedAnswer = selectRenderedMessages(stream(), fallback);
    expect(selectRenderedMessages({ ...cold, messages: [] } as SessionStreamState, fallback)).toBe(
      selectRenderedMessages({ ...cold, messages: [] } as SessionStreamState, fallback)
    );
    expect(
      selectRenderedMessages({ ...cold, messages: [] } as SessionStreamState, fallback)
    ).not.toBe(hydratedAnswer);
  });
});

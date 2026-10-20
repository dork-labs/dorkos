import { describe, it, expect } from 'vitest';
import type { HistoryMessage } from '@dorkos/shared/types';
import { historyRead } from '../history-read.js';

const history = ['u1', 'a1', 'u2', 'a2'].map(
  (id) => ({ id, role: id.startsWith('u') ? 'user' : 'assistant', content: id }) as HistoryMessage
);

describe('historyRead (DOR-2890)', () => {
  it('answers the whole history when no tail was asked', () => {
    expect(historyRead(history, undefined)).toEqual({ messages: history });
    expect(historyRead(history, '')).toEqual({ messages: history });
  });

  it('answers from the named message to the end, the message included', () => {
    expect(historyRead(history, 'a1')).toEqual({ messages: history.slice(1), tail: true });
  });

  it('answers the whole history for an id it does not hold', () => {
    expect(historyRead(history, 'gone')).toEqual({ messages: history });
  });

  it('ignores a repeated query value', () => {
    expect(historyRead(history, ['a1', 'a2'])).toEqual({ messages: history });
  });
});

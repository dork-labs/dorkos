import { describe, it, expect, vi, afterEach } from 'vitest';
import { HEARTBEAT_PROMPT_OPENING } from '@dorkos/shared/chat-messages';
import type { HistoryMessage } from '@dorkos/shared/types';
import { promptSourceReader, setScheduledPromptLookup } from '../prompt-source.js';
import { stampHistory } from '../chat-message-stamps.js';

afterEach(() => setScheduledPromptLookup(undefined));

describe('promptSourceReader', () => {
  it('names a heartbeat by its opening sentence', () => {
    const read = promptSourceReader(['s1'], () => []);
    expect(read(`${HEARTBEAT_PROMPT_OPENING}\n\nYour checklist`)).toEqual({ kind: 'heartbeat' });
  });

  it('names a schedule that ran in this chat when the words are its prompt', () => {
    const read = promptSourceReader(['s1'], () => [{ prompt: ' Send the report ', name: 'Daily' }]);
    expect(read('Send the report')).toEqual({ kind: 'schedule', label: 'Daily' });
  });

  it('leaves other words alone, so what a person typed stays theirs', () => {
    const read = promptSourceReader(['s1'], () => [{ prompt: 'Send the report', name: 'Daily' }]);
    expect(read('Send the report please')).toBeNull();
  });

  it('reads the schedules once for a whole history', () => {
    const look = vi.fn(() => []);
    const read = promptSourceReader(['s1'], look);
    read('one');
    read('two');
    expect(look).toHaveBeenCalledTimes(1);
  });
});

describe('stampHistory', () => {
  it('stamps a schedule prompt and leaves a person and the agent unmarked', () => {
    setScheduledPromptLookup(() => [{ prompt: 'Send the report', name: 'Daily' }]);
    const history: HistoryMessage[] = [
      { id: '1', role: 'user', content: 'Send the report' },
      { id: '2', role: 'assistant', content: 'Send the report' },
      { id: '3', role: 'user', content: 'Thanks' },
    ];
    const out = stampHistory(['s1'], history, undefined);
    expect(out[0]?.promptSource).toEqual({ kind: 'schedule', label: 'Daily' });
    expect(out[1]?.promptSource).toBeUndefined();
    expect(out[2]?.promptSource).toBeUndefined();
  });

  it('never stamps a command row, even with the same words', () => {
    setScheduledPromptLookup(() => [{ prompt: '/report', name: 'Daily' }]);
    const history: HistoryMessage[] = [
      { id: '1', role: 'user', content: '/report', messageType: 'command' },
    ];
    const out = stampHistory(['s1'], history, undefined);
    expect(out[0]?.promptSource).toBeUndefined();
  });
});

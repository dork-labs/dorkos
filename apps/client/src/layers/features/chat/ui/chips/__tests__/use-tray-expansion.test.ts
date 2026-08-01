import { describe, it, expect, beforeEach } from 'vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { trayExpansionKey, useTrayExpansionStore } from '../use-tray-expansion';

/** One tool call, as both the live stream and the transcript carry it. */
function toolCall(toolCallId: string): MessagePart {
  return {
    type: 'tool_call',
    toolCallId,
    toolName: 'Read',
    input: '{"file_path":"/repo/a.ts"}',
    status: 'complete',
  };
}

beforeEach(() => {
  useTrayExpansionStore.setState({ open: {} });
});

describe('trayExpansionKey', () => {
  it('names the turn by its first tool call, whatever arrives after', () => {
    const early = trayExpansionKey('s1', [{ type: 'text', text: 'looking' }, toolCall('toolu_a')]);
    const later = trayExpansionKey('s1', [
      { type: 'text', text: 'looking' },
      toolCall('toolu_a'),
      toolCall('toolu_b'),
      toolCall('toolu_c'),
    ]);
    expect(later).toBe(early);
  });

  it('keeps two sessions apart even when a tool id repeats', () => {
    expect(trayExpansionKey('s1', [toolCall('toolu_a')])).not.toBe(
      trayExpansionKey('s2', [toolCall('toolu_a')])
    );
  });

  it('answers for a strip standing outside any session', () => {
    expect(trayExpansionKey(null, [toolCall('toolu_a')])).toBe('detached:toolu_a');
  });
});

describe('the open-tray record', () => {
  it('opens, shuts, and leaves nothing behind', () => {
    const { toggle } = useTrayExpansionStore.getState();
    toggle('s1:toolu_a');
    expect(useTrayExpansionStore.getState().open).toEqual({ 's1:toolu_a': true });
    toggle('s1:toolu_a');
    expect(useTrayExpansionStore.getState().open).toEqual({});
  });

  it('tracks each turn on its own', () => {
    const { toggle } = useTrayExpansionStore.getState();
    toggle('s1:toolu_a');
    toggle('s1:toolu_b');
    toggle('s1:toolu_a');
    expect(useTrayExpansionStore.getState().open).toEqual({ 's1:toolu_b': true });
  });
});

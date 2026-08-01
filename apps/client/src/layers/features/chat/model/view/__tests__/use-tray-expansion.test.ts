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
  useTrayExpansionStore.setState({ views: {} });
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
});

describe('the arranged-tray record', () => {
  it('starts every turn shut, unfiltered and grouped', () => {
    expect(useTrayExpansionStore.getState().views['s1:toolu_a']).toBeUndefined();
  });

  it('changes one field without disturbing the rest', () => {
    const { update } = useTrayExpansionStore.getState();
    update('s1:toolu_a', { expanded: true });
    update('s1:toolu_a', { order: 'chronological' });
    update('s1:toolu_a', { verbFilter: 'edit' });

    expect(useTrayExpansionStore.getState().views['s1:toolu_a']).toEqual({
      expanded: true,
      verbFilter: 'edit',
      order: 'chronological',
    });
  });

  it('tracks each turn on its own', () => {
    const { update } = useTrayExpansionStore.getState();
    update('s1:toolu_a', { expanded: true, order: 'chronological' });
    update('s1:toolu_b', { expanded: true });

    expect(useTrayExpansionStore.getState().views['s1:toolu_b']).toEqual({
      expanded: true,
      verbFilter: null,
      order: 'grouped',
    });
  });

  it('remembers how a shut tray was arranged, so reopening it looks the same', () => {
    const { update } = useTrayExpansionStore.getState();
    update('s1:toolu_a', { expanded: true, verbFilter: 'read', order: 'chronological' });
    update('s1:toolu_a', { expanded: false });

    expect(useTrayExpansionStore.getState().views['s1:toolu_a']).toEqual({
      expanded: false,
      verbFilter: 'read',
      order: 'chronological',
    });
  });
});

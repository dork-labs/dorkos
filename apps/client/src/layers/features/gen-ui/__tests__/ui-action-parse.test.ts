import { describe, it, expect } from 'vitest';
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import { parseUiActionMessage } from '../lib/ui-action-parse';

describe('parseUiActionMessage', () => {
  it('parses a block produced by the shared formatter (round-trip)', () => {
    const content = formatUiActionMessage({
      actionId: 'move-1-1',
      widgetTitle: 'Tic-Tac-Toe',
      payload: { glyph: 'X' },
    });
    const parsed = parseUiActionMessage(content);
    expect(parsed).toMatchObject({
      title: 'Tic-Tac-Toe',
      actionId: 'move-1-1',
      payload: { glyph: 'X' },
    });
  });

  it('returns null for content with no ui_action block', () => {
    expect(parseUiActionMessage('just a normal message')).toBeNull();
  });

  it('treats "(untitled)" as no title', () => {
    const parsed = parseUiActionMessage(
      '<ui_action>\nWidget: (untitled)\nAction: refresh\nPayload: (none)\n</ui_action>'
    );
    expect(parsed?.title).toBeNull();
    expect(parsed?.actionId).toBe('refresh');
    expect(parsed?.payload).toBeNull();
  });

  it('parses the optional Widget ID line', () => {
    const parsed = parseUiActionMessage(
      '<ui_action>\nWidget: Board\nAction: play\nWidget ID: board-7\nPayload: (none)\n</ui_action>'
    );
    expect(parsed?.widgetId).toBe('board-7');
  });

  it('tolerates a trailing directive line the block may carry', () => {
    const parsed = parseUiActionMessage(
      [
        '<ui_action>',
        'The user interacted with a widget you rendered.',
        'Widget: Tic-Tac-Toe',
        'Action: move-0-2',
        'Payload: (none)',
        'Respond by re-rendering the board with the move applied.',
        '</ui_action>',
      ].join('\n')
    );
    expect(parsed?.title).toBe('Tic-Tac-Toe');
    expect(parsed?.actionId).toBe('move-0-2');
  });

  it('tolerates surrounding text and unknown lines', () => {
    const parsed = parseUiActionMessage(
      'preamble\n<ui_action>\nsomething unexpected\nAction: go\n</ui_action>\ntrailing'
    );
    expect(parsed?.actionId).toBe('go');
  });

  it('requires an Action line to produce a chip', () => {
    expect(
      parseUiActionMessage('<ui_action>\nWidget: Board\nPayload: (none)\n</ui_action>')
    ).toBeNull();
  });

  it('parses a multi-line JSON payload', () => {
    const content = formatUiActionMessage({
      actionId: 'search',
      widgetTitle: 'Search',
      payload: { city: 'Berlin', count: 3 },
    });
    const parsed = parseUiActionMessage(content);
    expect(parsed?.payload).toEqual({ city: 'Berlin', count: 3 });
  });
});

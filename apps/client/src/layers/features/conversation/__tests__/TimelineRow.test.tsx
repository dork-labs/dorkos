// @vitest-environment jsdom
/**
 * DOR-3312: the virtualizer re-renders the timeline on every scroll frame, and a
 * re-render that changes nothing a row reads must not re-draw the row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ConversationRow, ConversationRowRenderer } from '../lib/row-kinds';
import { TimelineRow } from '../ui/TimelineRow';
import { formatAbsoluteTime, formatTime } from '../lib/format-entry-time';

const ROW: ConversationRow = { kind: 'day-divider', id: 'day-1', label: 'Today' };
const CONTEXT = { onOpenThread: undefined };

afterEach(cleanup);

describe('TimelineRow', () => {
  it('does not re-draw a row when the timeline re-renders with the same inputs', () => {
    const renderRow = vi.fn<ConversationRowRenderer>((row, ctx) => (
      <p>
        {row.id}@{ctx.index}
      </p>
    ));
    const view = render(
      <TimelineRow row={ROW} index={3} context={CONTEXT} renderRow={renderRow} />
    );
    // What a scroll frame does: the parent renders again, every input unchanged.
    for (let frame = 0; frame < 5; frame++) {
      view.rerender(<TimelineRow row={ROW} index={3} context={CONTEXT} renderRow={renderRow} />);
    }
    expect(renderRow).toHaveBeenCalledTimes(1);
    expect(renderRow).toHaveBeenCalledWith(ROW, { onOpenThread: undefined, index: 3 });
    expect(screen.getByText('day-1@3')).toBeInTheDocument();
  });

  it('re-draws when the row, its index or the renderer changes', () => {
    const renderRow = vi.fn<ConversationRowRenderer>((row, ctx) => (
      <p>
        {row.id}@{ctx.index}
      </p>
    ));
    const view = render(
      <TimelineRow row={ROW} index={3} context={CONTEXT} renderRow={renderRow} />
    );
    view.rerender(<TimelineRow row={ROW} index={4} context={CONTEXT} renderRow={renderRow} />);
    expect(screen.getByText('day-1@4')).toBeInTheDocument();

    const next: ConversationRow = { ...ROW, id: 'day-2' };
    view.rerender(<TimelineRow row={next} index={4} context={CONTEXT} renderRow={renderRow} />);
    expect(screen.getByText('day-2@4')).toBeInTheDocument();

    // A host's `useCallback` renderer changes identity when what it reads changes.
    const redrawn = vi.fn<ConversationRowRenderer>(() => <p>redrawn</p>);
    view.rerender(<TimelineRow row={next} index={4} context={CONTEXT} renderRow={redrawn} />);
    expect(screen.getByText('redrawn')).toBeInTheDocument();
    expect(renderRow).toHaveBeenCalledTimes(3);
  });
});

describe('format-entry-time', () => {
  it('formats exactly as the per-call locale methods did', () => {
    const iso = '2026-07-26T11:30:00.000Z';
    const at = new Date(iso);
    expect(formatTime(iso)).toBe(at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    expect(formatAbsoluteTime(iso)).toBe(
      at.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' })
    );
    // Twice, so the cached formatter is the one answering.
    expect(formatTime(iso)).toBe(formatTime(iso));
  });

  it('answers an unparseable timestamp with nothing rather than throwing', () => {
    expect(formatTime('not a time')).toBe('');
    expect(formatAbsoluteTime('not a time')).toBe('');
  });
});

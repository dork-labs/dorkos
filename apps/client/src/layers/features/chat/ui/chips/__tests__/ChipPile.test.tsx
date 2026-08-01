/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { TouchChip, TouchChipVerb } from '../../../lib/touch-chips';
import { ChipPile } from '../ChipPile';

/** Build an absorbed chip — the pile takes a roster, not a transcript. */
function chip(label: string, verb: TouchChipVerb, seq: number): TouchChip {
  return {
    key: `file:${label}`,
    kind: 'file',
    label,
    fullTarget: `/repo/${label}`,
    verb,
    live: false,
    error: false,
    touches: 1,
    firstSeq: seq,
    lastSeq: seq,
    history: [],
  };
}

/** Five chips that have aged out, oldest first — the order the strip passes. */
const ABSORBED: TouchChip[] = [
  chip('a.ts', 'read', 0),
  chip('b.ts', 'run', 1),
  chip('c.ts', 'fetch', 2),
  chip('d.ts', 'edit', 3),
  chip('e.ts', 'create', 4),
];

afterEach(() => {
  cleanup();
});

describe('ChipPile', () => {
  it('draws the three newest, newest on top, and counts them all', () => {
    render(<ChipPile chips={ABSORBED} expanded={false} controls="tray" onExpand={vi.fn()} />);

    const pile = screen.getByTestId('chip-pile');
    // The stack is decoration, so it is read as glyphs rather than by name: the
    // last three chips, newest first.
    expect(pile.textContent).toBe('✚✏️🌐5');
    expect(screen.getByTestId('chip-pile-count')).toHaveTextContent('5');
  });

  it('says how much more it is holding', () => {
    render(<ChipPile chips={ABSORBED} expanded={false} controls="tray" onExpand={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAccessibleName(
      'Show everything this turn touched (5 more)'
    );
  });

  it('is one click target for the whole roster', async () => {
    const user = userEvent.setup();
    const onExpand = vi.fn();
    render(<ChipPile chips={ABSORBED} expanded={true} controls="tray-id" onExpand={onExpand} />);

    await user.click(screen.getByTestId('chip-pile'));

    expect(onExpand).toHaveBeenCalledOnce();
    expect(screen.getByTestId('chip-pile')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('chip-pile')).toHaveAttribute('aria-controls', 'tray-id');
  });
});

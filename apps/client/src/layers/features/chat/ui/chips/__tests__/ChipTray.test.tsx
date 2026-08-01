/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import type { TouchChip, TouchChipVerb } from '../../../lib/touch-chips';
import type { ChipOrder } from '../../../model/view/use-tray-expansion';
import { ChipTray, sortChips } from '../ChipTray';

/**
 * The tray, driven the way the strip drives it.
 *
 * The tray is controlled: its filter and order belong to the strip, which holds
 * them where a turn ending cannot destroy them (DOR-827). These tests are about
 * what the tray does with them, so this supplies the smallest thing that owns
 * them. The wiring to the real store is pinned end-to-end in
 * `features/chat/__tests__/chip-tray-survives-turn-end.test.tsx`.
 */
function Tray({
  chips,
  onOpen,
  id,
}: {
  chips: TouchChip[];
  onOpen: (chip: TouchChip) => void;
  id?: string;
}) {
  const [verbFilter, setVerbFilter] = useState<TouchChipVerb | null>(null);
  const [order, setOrder] = useState<ChipOrder>('grouped');
  return (
    <ChipTray
      id={id}
      chips={chips}
      onOpen={onOpen}
      verbFilter={verbFilter}
      onVerbFilterChange={setVerbFilter}
      order={order}
      onOrderChange={setOrder}
    />
  );
}

/** Build a chip directly — the tray takes a roster, not a transcript. */
function chip(overrides: Partial<TouchChip> & Pick<TouchChip, 'label' | 'verb'>): TouchChip {
  return {
    key: `file:${overrides.label}`,
    kind: 'file',
    fullTarget: `/repo/${overrides.label}`,
    live: false,
    error: false,
    touches: 1,
    firstSeq: 0,
    lastSeq: 0,
    history: [],
    ...overrides,
  };
}

/**
 * A roster whose two orders differ: the edit happened first, so grouped-by-verb
 * puts it after both reads while chronological puts the last-touched read last.
 */
const ROSTER: TouchChip[] = [
  chip({ label: 'edited-first.ts', verb: 'edit', firstSeq: 0, lastSeq: 0 }),
  chip({ label: 'read-early.ts', verb: 'read', firstSeq: 1, lastSeq: 1 }),
  chip({ label: 'read-late.ts', verb: 'read', firstSeq: 2, lastSeq: 2 }),
];

/** The labels of the chips currently rendered, in DOM order. */
function renderedLabels(): string[] {
  return within(screen.getByTestId('chip-tray-roster'))
    .getAllByTestId('touch-chip')
    .map((node) => node.textContent ?? '');
}

afterEach(() => {
  cleanup();
});

describe('ChipTray', () => {
  it('renders the whole roster and counts each verb', () => {
    render(<Tray chips={ROSTER} onOpen={vi.fn()} />);

    expect(renderedLabels()).toHaveLength(3);
    expect(screen.getByTestId('chip-filter-read').textContent).toBe('📖Read2');
    expect(screen.getByTestId('chip-filter-edit').textContent).toBe('✏️Edited1');
  });

  it('narrows to one verb, then back to everything', async () => {
    const user = userEvent.setup();
    render(<Tray chips={ROSTER} onOpen={vi.fn()} />);

    await user.click(screen.getByTestId('chip-filter-read'));
    expect(renderedLabels()).toHaveLength(2);
    expect(renderedLabels().join(' ')).not.toContain('edited-first.ts');
    expect(screen.getByTestId('chip-filter-read')).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('chip-filter-read'));
    expect(renderedLabels()).toHaveLength(3);
    expect(screen.getByTestId('chip-filter-read')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps the filter counts steady while a filter is on', async () => {
    const user = userEvent.setup();
    render(<Tray chips={ROSTER} onOpen={vi.fn()} />);

    await user.click(screen.getByTestId('chip-filter-read'));

    // Counting the filtered list would make the buttons move under the cursor.
    expect(screen.getByTestId('chip-filter-edit').textContent).toBe('✏️Edited1');
  });

  it('reorders between grouped and chronological', async () => {
    const user = userEvent.setup();
    render(<Tray chips={ROSTER} onOpen={vi.fn()} />);

    // Grouped: reads come before edits in the canonical verb order, even though
    // the edit happened first.
    expect(renderedLabels()[0]).toContain('read-early.ts');
    expect(renderedLabels()[2]).toContain('edited-first.ts');

    await user.click(screen.getByRole('radio', { name: 'Chronological' }));

    expect(renderedLabels()[0]).toContain('edited-first.ts');
    expect(renderedLabels()[2]).toContain('read-late.ts');
  });

  it('names its default order for what it groups by', () => {
    // "Kind" was the wrong word: this groups by what HAPPENED to a target, and
    // a chip's kind is the different question of file-vs-link-vs-command.
    render(<Tray chips={ROSTER} onOpen={vi.fn()} />);

    expect(screen.getByRole('radio', { name: 'Grouped' })).toBeChecked();
  });
});

describe('sortChips', () => {
  // The comparator the tray actually ships, not one written out again here: a
  // copy stays green while the real one changes.
  const MIXED: TouchChip[] = [
    chip({ label: 'ran.sh', verb: 'run', firstSeq: 0, lastSeq: 0 }),
    chip({ label: 'read-first.ts', verb: 'read', firstSeq: 1, lastSeq: 4 }),
    chip({ label: 'created.ts', verb: 'create', firstSeq: 2, lastSeq: 2 }),
    chip({ label: 'read-second.ts', verb: 'read', firstSeq: 3, lastSeq: 3 }),
  ];

  it('groups by the canonical verb order, then by first touch', () => {
    expect(sortChips(MIXED, 'grouped').map((entry) => entry.label)).toEqual([
      'read-first.ts',
      'read-second.ts',
      'created.ts',
      'ran.sh',
    ]);
  });

  it('orders chronologically by LAST touch, which is what moved most recently', () => {
    expect(sortChips(MIXED, 'chronological').map((entry) => entry.label)).toEqual([
      'ran.sh',
      'created.ts',
      'read-second.ts',
      'read-first.ts',
    ]);
  });

  it('leaves the roster it was given alone', () => {
    const before = MIXED.map((entry) => entry.label);
    sortChips(MIXED, 'chronological');

    expect(MIXED.map((entry) => entry.label)).toEqual(before);
  });

  it('is a labelled region the disclosure can point at', () => {
    render(<Tray id="tray-1" chips={ROSTER} onOpen={vi.fn()} />);

    const tray = screen.getByTestId('chip-tray');
    expect(tray).toHaveAttribute('id', 'tray-1');
    expect(tray).toHaveAttribute('role', 'region');
    expect(tray).toHaveAccessibleName('Touched files and links');
  });

  it('bounds its own height rather than growing the transcript', () => {
    render(<Tray chips={ROSTER} onOpen={vi.fn()} />);

    const roster = screen.getByTestId('chip-tray-roster');
    expect(roster.className).toContain('max-h-60');
    expect(roster.className).toContain('overflow-y-auto');
  });

  it('hands a clicked chip back to its opener', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Tray chips={ROSTER} onOpen={onOpen} />);

    await user.click(screen.getByRole('button', { name: 'Read /repo/read-early.ts' }));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0][0].label).toBe('read-early.ts');
  });
});

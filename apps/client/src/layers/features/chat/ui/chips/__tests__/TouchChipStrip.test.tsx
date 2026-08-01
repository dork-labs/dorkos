/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { useAppStore } from '@/layers/shared/model';
import { setPlatformAdapter } from '@/layers/shared/lib';
import { TouchChipStrip } from '../TouchChipStrip';

type ToolStatus = 'pending' | 'running' | 'complete' | 'error';

let nextId = 0;

/** Build a `tool_call` part the way the wire delivers one. */
function toolCall(
  toolName: string,
  input: unknown,
  options: { result?: string; status?: ToolStatus } = {}
): Extract<MessagePart, { type: 'tool_call' }> {
  nextId += 1;
  return {
    type: 'tool_call',
    toolCallId: `tool-${nextId}`,
    toolName,
    input: JSON.stringify(input),
    result: options.result,
    status: options.status ?? 'complete',
  };
}

/** A turn that read two files, edited one, and fetched a page. */
function mixedParts(): MessagePart[] {
  return [
    toolCall('Read', { file_path: '/repo/src/a.ts' }),
    toolCall('Read', { file_path: '/repo/src/b.ts' }),
    toolCall('Edit', { file_path: '/repo/src/c.ts', old_string: 'a\nb', new_string: 'a\nX\nY' }),
    toolCall('WebFetch', { url: 'https://example.com/page' }),
  ];
}

/** Open the tray and return it. */
async function openTray(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'show all' }));
  return screen.getByTestId('chip-tray');
}

beforeEach(() => {
  useAppStore.setState({ openDocuments: [], activeDocumentId: null, canvasOpen: false });
  setPlatformAdapter({ isEmbedded: false, openFile: async () => {} });
});

afterEach(() => {
  cleanup();
});

describe('TouchChipStrip — the settled summary line', () => {
  it('tallies the turn by verb and offers the full roster', () => {
    render(<TouchChipStrip parts={mixedParts()} />);

    // Each tally is glyph, screen-reader name, count — and a diffstat where one
    // was reported. Two reads, one edit (+2 −1 for the fixture), one fetch.
    expect(screen.getByTestId('chip-summary-read').textContent).toBe('📖Read2');
    expect(screen.getByTestId('chip-summary-edit').textContent).toBe('✏️Edited1+2 −1');
    expect(screen.getByTestId('chip-summary-fetch').textContent).toBe('🌐Fetched1');
    expect(screen.queryByTestId('chip-summary-delete')).toBeNull();
    expect(screen.getByRole('button', { name: 'show all' })).toBeInTheDocument();
  });

  it('names each tally for a screen reader', () => {
    render(<TouchChipStrip parts={mixedParts()} />);

    const strip = screen.getByTestId('touch-chip-strip');
    expect(within(strip).getByText('Read')).toBeInTheDocument();
    expect(within(strip).getByText('Edited')).toBeInTheDocument();
    expect(within(strip).getByText('Fetched')).toBeInTheDocument();
  });

  it('renders nothing at all for a turn that touched nothing', () => {
    render(<TouchChipStrip parts={[{ type: 'text', text: 'just talking' }]} />);

    expect(screen.queryByTestId('touch-chip-strip')).toBeNull();
  });

  it('renders nothing for a turn whose only tools are excluded ones', () => {
    render(<TouchChipStrip parts={[toolCall('TodoWrite', { todos: [] })]} />);

    expect(screen.queryByTestId('touch-chip-strip')).toBeNull();
  });

  it('keeps the tray closed until it is asked for', () => {
    render(<TouchChipStrip parts={mixedParts()} />);

    expect(screen.queryByTestId('chip-tray')).toBeNull();
    expect(screen.getByRole('button', { name: 'show all' })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });
});

describe('TouchChipStrip — the live row', () => {
  /** The chips currently in the live row, in DOM order (left to right). */
  function liveRowLabels(): string[] {
    return within(screen.getByTestId('chip-live-row'))
      .getAllByTestId('touch-chip')
      .map((node) => node.textContent ?? '');
  }

  it('shows the live row instead of the summary while a tool is still running', () => {
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
          toolCall('Read', { file_path: '/repo/src/b.ts' }, { status: 'running' }),
        ]}
      />
    );

    expect(liveRowLabels()).toHaveLength(2);
    expect(screen.queryByTestId('chip-summary-read')).toBeNull();
    expect(screen.queryByRole('button', { name: 'show all' })).toBeNull();
  });

  it('keeps only the four newest touches in the row, newest on the right', () => {
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/a.ts' }),
          toolCall('Read', { file_path: '/repo/b.ts' }),
          toolCall('Read', { file_path: '/repo/c.ts' }),
          toolCall('Read', { file_path: '/repo/d.ts' }),
          toolCall('Read', { file_path: '/repo/e.ts' }),
          toolCall('Read', { file_path: '/repo/f.ts' }, { status: 'running' }),
        ]}
      />
    );

    expect(liveRowLabels()).toEqual(['📖c.ts', '📖d.ts', '📖e.ts', '📖f.ts']);
  });

  it('brings a re-touched file back into the row', () => {
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/a.ts' }),
          toolCall('Read', { file_path: '/repo/b.ts' }),
          toolCall('Read', { file_path: '/repo/c.ts' }),
          toolCall('Read', { file_path: '/repo/d.ts' }),
          toolCall('Read', { file_path: '/repo/e.ts' }),
          // `a.ts` is the oldest first touch, but the newest one.
          toolCall('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }),
          toolCall('Read', { file_path: '/repo/f.ts' }, { status: 'running' }),
        ]}
      />
    );

    expect(liveRowLabels()).toEqual(['📖d.ts', '📖e.ts', '✏️a.ts×2+1 −1', '📖f.ts']);
  });

  it('counts what has aged out into the pile, and opens the whole roster from it', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/a.ts' }),
          toolCall('Read', { file_path: '/repo/b.ts' }),
          toolCall('Read', { file_path: '/repo/c.ts' }),
          toolCall('Read', { file_path: '/repo/d.ts' }),
          toolCall('Read', { file_path: '/repo/e.ts' }),
          toolCall('Read', { file_path: '/repo/f.ts' }, { status: 'running' }),
        ]}
      />
    );

    const pile = screen.getByTestId('chip-pile');
    expect(within(pile).getByTestId('chip-pile-count')).toHaveTextContent('2');
    expect(pile).toHaveAttribute('aria-expanded', 'false');
    // The two oldest are out of the row entirely — the pile is where they went.
    expect(liveRowLabels()).not.toContain('📖a.ts');

    await user.click(pile);

    const tray = screen.getByTestId('chip-tray');
    expect(within(tray).getAllByTestId('touch-chip')).toHaveLength(6);
    expect(within(tray).getByRole('button', { name: 'Read /repo/a.ts' })).toBeInTheDocument();
    expect(pile).toHaveAttribute('aria-expanded', 'true');
    expect(pile.getAttribute('aria-controls')).toBe(tray.getAttribute('id'));
  });

  it('has no pile until something has actually aged out', () => {
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/a.ts' }),
          toolCall('Read', { file_path: '/repo/b.ts' }, { status: 'running' }),
        ]}
      />
    );

    expect(screen.queryByTestId('chip-pile')).toBeNull();
  });

  it('settles into the summary line once nothing is live', () => {
    const running = [
      toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'running' }),
      toolCall('Edit', { file_path: '/repo/src/c.ts', old_string: 'a\nb', new_string: 'a\nX\nY' }),
    ];
    const { rerender } = render(<TouchChipStrip parts={running} />);
    expect(screen.getByTestId('chip-live-row')).toBeInTheDocument();

    const settled = running.map((part) =>
      part.type === 'tool_call' ? { ...part, status: 'complete' as const } : part
    );
    rerender(<TouchChipStrip parts={settled} />);

    expect(screen.queryByTestId('chip-live-row')).toBeNull();
    expect(screen.getByTestId('chip-summary-read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'show all' })).toBeInTheDocument();
  });
});

describe('TouchChipStrip — the read→edit upgrade', () => {
  it('morphs the chip in place instead of adding a second one', () => {
    const read = toolCall('Read', { file_path: '/repo/a.ts' }, { status: 'running' });
    const { rerender } = render(<TouchChipStrip parts={[read]} />);

    const before = within(screen.getByTestId('chip-live-row')).getByTestId('touch-chip');
    expect(before).toHaveAttribute('data-verb', 'read');

    rerender(
      <TouchChipStrip
        parts={[
          { ...read, status: 'complete' },
          toolCall(
            'Edit',
            { file_path: '/repo/a.ts', old_string: 'a\nb', new_string: 'a\nX\nY' },
            { status: 'running' }
          ),
        ]}
      />
    );

    const row = screen.getByTestId('chip-live-row');
    const after = within(row).getByTestId('touch-chip');
    // The very same element: an upgrade rewrites the chip that is already
    // there. A chip keyed by anything that changes on upgrade would remount
    // here, and the file would appear to have been touched twice.
    expect(after).toBe(before);
    expect(after).toHaveAttribute('data-verb', 'edit');
    expect(after.textContent).toBe('✏️a.ts×2+2 −1');
  });
});

describe('TouchChipStrip — the disclosure', () => {
  it('opens the roster and flips aria-expanded', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={mixedParts()} />);

    const tray = await openTray(user);

    expect(tray).toBeInTheDocument();
    expect(within(tray).getAllByTestId('touch-chip')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'hide' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('points the trigger at the region it controls', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={mixedParts()} />);

    const tray = await openTray(user);
    const trigger = screen.getByRole('button', { name: 'hide' });

    expect(tray).toHaveAttribute('role', 'region');
    expect(tray).toHaveAccessibleName('Touched files and links');
    expect(trigger.getAttribute('aria-controls')).toBe(tray.getAttribute('id'));
  });

  it('closes again on a second click', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={mixedParts()} />);

    await openTray(user);
    await user.click(screen.getByRole('button', { name: 'hide' }));

    expect(screen.queryByTestId('chip-tray')).toBeNull();
  });
});

describe('TouchChipStrip — clicking through to the canvas', () => {
  it('opens a file chip as a canvas file document', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={mixedParts()} />);

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: 'Read /repo/src/a.ts' }));

    const { openDocuments, canvasOpen } = useAppStore.getState();
    expect(openDocuments).toHaveLength(1);
    expect(openDocuments[0].content).toEqual({ type: 'file', sourcePath: '/repo/src/a.ts' });
    expect(canvasOpen).toBe(true);
  });

  it('opens a URL chip as a canvas url document', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={mixedParts()} />);

    const tray = await openTray(user);
    await user.click(
      within(tray).getByRole('button', { name: 'Fetched https://example.com/page' })
    );

    const { openDocuments } = useAppStore.getState();
    expect(openDocuments).toHaveLength(1);
    expect(openDocuments[0].content).toEqual({ type: 'url', url: 'https://example.com/page' });
  });

  it('opens nothing for a bare command, which has no surface to open', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={[toolCall('Bash', { command: 'pnpm test' })]} />);

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: 'Ran pnpm test' }));

    expect(useAppStore.getState().openDocuments).toHaveLength(0);
  });

  it('leaves a file chip inert inside the plugin, where there is no canvas', async () => {
    setPlatformAdapter({ isEmbedded: true, openFile: async () => {} });
    const user = userEvent.setup();
    render(<TouchChipStrip parts={mixedParts()} />);

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: 'Read /repo/src/a.ts' }));

    expect(useAppStore.getState().openDocuments).toHaveLength(0);
  });
});

describe('TouchChipStrip — chip anatomy', () => {
  it('badges a repeated touch and carries the audit trail in its tooltip', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
          toolCall('Read', { file_path: '/repo/src/a.ts' }),
        ]}
      />
    );

    const tray = await openTray(user);
    const chip = within(tray).getByTestId('touch-chip');

    expect(chip.textContent).toContain('×2');
    expect(chip).toHaveAttribute('title', '/repo/src/a.ts\nread, read');
    expect(chip).toHaveAccessibleName('Read /repo/src/a.ts, 2 times');
  });

  it('keeps a deleted file on as a struck-through tombstone', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip parts={[toolCall('Bash', { command: 'rm old.ts' })]} />);

    const tray = await openTray(user);
    const tombstone = within(tray).getByRole('button', { name: 'Deleted old.ts' });

    expect(tombstone).toHaveAttribute('data-verb', 'delete');
    expect(tombstone.className).toContain('line-through');
  });

  it('tints a chip whose tool failed', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        parts={[toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'error' })]}
      />
    );

    const tray = await openTray(user);
    const chip = within(tray).getByTestId('touch-chip');

    expect(chip.className).toContain('border-destructive/40');
    expect(chip).toHaveAccessibleName('Read /repo/src/a.ts, failed');
  });

  it('marks a chip live while its tool is still running', () => {
    render(
      <TouchChipStrip
        parts={[toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'running' })]}
      />
    );

    const chip = within(screen.getByTestId('chip-live-row')).getByTestId('touch-chip');

    expect(chip).toHaveAttribute('data-live', 'true');
    expect(chip).toHaveAttribute('data-verb', 'read');
  });

  it('carries no looping-animation class, live or settled', () => {
    // `data-verb` and `data-live` are wired so the verb signatures can key off
    // them; the loops themselves are Phase 3. The real reduced-motion
    // assertion — that every verb loop stops when a reader has asked for less
    // motion — belongs to the phase that adds those loops, and needs a browser
    // to mean anything. This only pins that nothing crept in early.
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'running' }),
          toolCall('Read', { file_path: '/repo/src/b.ts' }),
        ]}
      />
    );

    for (const chip of within(screen.getByTestId('chip-live-row')).getAllByTestId('touch-chip')) {
      expect(chip.className).not.toMatch(/animate-/);
    }
  });
});

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
): MessagePart {
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
  });

  it('marks a chip live while its tool is still running', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        parts={[toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'running' })]}
      />
    );

    const tray = await openTray(user);
    const chip = within(tray).getByTestId('touch-chip');

    expect(chip).toHaveAttribute('data-live', 'true');
    expect(chip).toHaveAttribute('data-verb', 'read');
  });

  it('carries no looping-animation class in this phase, live or settled', async () => {
    // Phase 1 has no motion: `data-verb` and `data-live` are wired so the verb
    // signatures can key off them later, but nothing animates yet. The real
    // reduced-motion assertion — that every verb loop stops when a reader has
    // asked for less motion — belongs to the phase that adds those loops, and
    // needs a browser to mean anything. This only pins that nothing crept in early.
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        parts={[
          toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'running' }),
          toolCall('Read', { file_path: '/repo/src/b.ts' }),
        ]}
      />
    );

    const tray = await openTray(user);
    for (const chip of within(tray).getAllByTestId('touch-chip')) {
      expect(chip.className).not.toMatch(/animate-/);
    }
  });
});

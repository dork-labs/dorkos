/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { MessagePart } from '@dorkos/shared/types';
import { useAppStore } from '@/layers/shared/model';

import { TouchChipStrip } from '../TouchChipStrip';
import { useTrayExpansionStore } from '../../../model/view/use-tray-expansion';

type ToolStatus = 'pending' | 'running' | 'complete' | 'error';

/** The session every strip in this file belongs to — it scopes the tray store. */
const SESSION_ID = 'session-under-test';

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

/**
 * Every element that entered or left the document while `run` ran.
 *
 * The upgrade ring removes itself the moment it finishes, and the test motion
 * mock finishes it on the spot — so by the time a render has settled the ring is
 * gone, exactly as it is a third of a second later in a browser. Both halves of
 * its life are collected because a ring that mounts inside a chip that mounts in
 * the same commit is never an addition of its own: React builds that subtree
 * before attaching it, and the only record naming the ring is the one that takes
 * it away again. A node that left was, necessarily, there.
 */
function movedDuring(run: () => void): HTMLElement[] {
  const observer = new MutationObserver(() => {});
  observer.observe(document.body, { childList: true, subtree: true });
  run();

  const moved: HTMLElement[] = [];
  for (const record of observer.takeRecords()) {
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      if (!(node instanceof HTMLElement)) continue;
      moved.push(node, ...node.querySelectorAll<HTMLElement>('*'));
    }
  }
  observer.disconnect();
  return moved;
}

/** Whether a testid was among the elements that moved. */
function sawTestId(moved: HTMLElement[], testId: string): boolean {
  return moved.some((node) => node.dataset.testid === testId);
}

beforeEach(() => {
  useAppStore.setState({
    openDocuments: [],
    activeCanvasDocumentId: null,
    activeBrowserDocumentId: null,
    canvasOpen: false,
    rightPanelOpen: false,
    activeRightPanelTab: null,
  });
  // Tray state outlives the strip on purpose (DOR-827), so it also outlives a
  // test — every case here starts from a shut tray, the way a fresh tab does.
  useTrayExpansionStore.setState({ views: {} });
});

afterEach(() => {
  cleanup();
});

describe('TouchChipStrip — the settled summary line', () => {
  it('tallies the turn by verb and offers the full roster', () => {
    render(<TouchChipStrip sessionId={SESSION_ID} parts={mixedParts()} />);

    // Each tally is glyph, screen-reader name, count — and a diffstat where one
    // was reported. Two reads, one edit (+2 −1 for the fixture), one fetch.
    expect(screen.getByTestId('chip-summary-read').textContent).toBe('📖Read2');
    expect(screen.getByTestId('chip-summary-edit').textContent).toBe('✏️Edited1+2 −1');
    expect(screen.getByTestId('chip-summary-fetch').textContent).toBe('🌐Fetched1');
    expect(screen.queryByTestId('chip-summary-delete')).toBeNull();
    expect(screen.getByRole('button', { name: 'show all' })).toBeInTheDocument();
  });

  it('renders nothing at all for a turn that touched nothing', () => {
    render(
      <TouchChipStrip sessionId={SESSION_ID} parts={[{ type: 'text', text: 'just talking' }]} />
    );

    expect(screen.queryByTestId('touch-chip-strip')).toBeNull();
  });

  it('renders nothing for a turn whose only tools are excluded ones', () => {
    render(
      <TouchChipStrip sessionId={SESSION_ID} parts={[toolCall('TodoWrite', { todos: [] })]} />
    );

    expect(screen.queryByTestId('touch-chip-strip')).toBeNull();
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
        sessionId={SESSION_ID}
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
        sessionId={SESSION_ID}
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
        sessionId={SESSION_ID}
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
        sessionId={SESSION_ID}
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

  it('settles into the summary line once nothing is live', () => {
    const running = [
      toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'running' }),
      toolCall('Edit', { file_path: '/repo/src/c.ts', old_string: 'a\nb', new_string: 'a\nX\nY' }),
    ];
    const { rerender } = render(<TouchChipStrip sessionId={SESSION_ID} parts={running} />);
    expect(screen.getByTestId('chip-live-row')).toBeInTheDocument();

    const settled = running.map((part) =>
      part.type === 'tool_call' ? { ...part, status: 'complete' as const } : part
    );
    rerender(<TouchChipStrip sessionId={SESSION_ID} parts={settled} />);

    expect(screen.queryByTestId('chip-live-row')).toBeNull();
    expect(screen.getByTestId('chip-summary-read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'show all' })).toBeInTheDocument();
  });
});

describe('TouchChipStrip — live for as long as the turn is', () => {
  it('holds the row through a whole turn and settles once, when the turn ends', () => {
    const a = toolCall('Read', { file_path: '/repo/a.ts' }, { status: 'running' });
    const b = toolCall('Read', { file_path: '/repo/b.ts' }, { status: 'running' });
    const { rerender } = render(<TouchChipStrip sessionId={SESSION_ID} parts={[a]} turnActive />);

    // Every frame of a turn: a tool lands, a gap where nothing runs, the next
    // tool starts, and it lands. The row must survive all of it.
    const frames: MessagePart[][] = [
      [{ ...a, status: 'complete' }],
      [{ ...a, status: 'complete' }, b],
      [
        { ...a, status: 'complete' },
        { ...b, status: 'complete' },
      ],
    ];
    for (const parts of frames) {
      rerender(<TouchChipStrip sessionId={SESSION_ID} parts={parts} turnActive />);
      expect(screen.getByTestId('chip-live-row')).toBeInTheDocument();
    }

    rerender(
      <TouchChipStrip
        sessionId={SESSION_ID}
        parts={[
          { ...a, status: 'complete' },
          { ...b, status: 'complete' },
        ]}
      />
    );

    expect(screen.queryByTestId('chip-live-row')).toBeNull();
    expect(screen.getByTestId('chip-summary-line')).toBeInTheDocument();
  });
});

describe('TouchChipStrip — the read→edit upgrade', () => {
  it('rings a file already in the pile when it comes back as an edit', () => {
    // The production sequence, exactly: a file is read early, four more touches
    // push it out of the live row and into the pile, and then it is edited — so
    // it re-enters the row as a FRESH mount already carrying `upgraded`. A pulse
    // remembered in the chip's own state is destroyed by that remount and
    // re-seeded from what it mounts with, which is how the one animation the
    // design asks for became the one animation that never played.
    const read = toolCall('Read', { file_path: '/repo/a.ts' });
    const filler = ['b', 'c', 'd', 'e'].map((name) =>
      toolCall('Read', { file_path: `/repo/${name}.ts` })
    );
    const { rerender } = render(
      <TouchChipStrip sessionId={SESSION_ID} parts={[read, ...filler]} turnActive />
    );

    // Gone from the row: it is in the pile, and its component is unmounted.
    expect(within(screen.getByTestId('chip-live-row')).queryByText('a.ts')).toBeNull();

    const moved = movedDuring(() =>
      rerender(
        <TouchChipStrip
          sessionId={SESSION_ID}
          parts={[
            read,
            ...filler,
            toolCall('Edit', {
              file_path: '/repo/a.ts',
              old_string: 'a\nb',
              new_string: 'a\nX\nY',
            }),
          ]}
          turnActive
        />
      )
    );

    expect(sawTestId(moved, 'chip-upgrade-pulse')).toBe(true);
  });

  it('rings once, and never again however many edits follow', () => {
    const read = toolCall('Read', { file_path: '/repo/a.ts' });
    const edit = () =>
      toolCall('Edit', { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' });
    const first = edit();
    const { rerender } = render(
      <TouchChipStrip sessionId={SESSION_ID} parts={[read, first]} turnActive />
    );

    const moved = movedDuring(() =>
      rerender(
        <TouchChipStrip sessionId={SESSION_ID} parts={[read, first, edit(), edit()]} turnActive />
      )
    );

    expect(sawTestId(moved, 'chip-upgrade-pulse')).toBe(false);
  });

  it('morphs the chip in place instead of adding a second one', () => {
    const read = toolCall('Read', { file_path: '/repo/a.ts' }, { status: 'running' });
    const { rerender } = render(<TouchChipStrip sessionId={SESSION_ID} parts={[read]} />);

    const before = within(screen.getByTestId('chip-live-row')).getByTestId('touch-chip');
    expect(before).toHaveAttribute('data-verb', 'read');

    rerender(
      <TouchChipStrip
        sessionId={SESSION_ID}
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
    render(<TouchChipStrip sessionId={SESSION_ID} parts={mixedParts()} />);

    const tray = await openTray(user);

    expect(tray).toBeInTheDocument();
    expect(within(tray).getAllByTestId('touch-chip')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'hide' })).toHaveAttribute('aria-expanded', 'true');
  });
});

/**
 * Everything that has to be true for a document to be ON SCREEN, not merely in
 * the store: the canvas lives in the right panel, so a document opened without
 * opening that panel and selecting its tab is invisible (DOR-829).
 */
function canvasState() {
  const { openDocuments, canvasOpen, rightPanelOpen, activeRightPanelTab } = useAppStore.getState();
  return { openDocuments, canvasOpen, rightPanelOpen, activeRightPanelTab };
}

describe('TouchChipStrip — clicking through to the canvas', () => {
  it('opens a file chip as a canvas file document, and shows it', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip sessionId={SESSION_ID} parts={mixedParts()} />);

    const tray = await openTray(user);
    await user.click(within(tray).getByRole('button', { name: 'Read /repo/src/a.ts' }));

    const { openDocuments, canvasOpen, rightPanelOpen, activeRightPanelTab } = canvasState();
    expect(openDocuments).toHaveLength(1);
    expect(openDocuments[0].content).toEqual({ type: 'file', sourcePath: '/repo/src/a.ts' });
    expect(canvasOpen).toBe(true);
    expect(rightPanelOpen).toBe(true);
    expect(activeRightPanelTab).toBe('canvas');
  });

  it('opens a URL chip as a page, and shows the tab the page actually opened in', async () => {
    const user = userEvent.setup();
    render(<TouchChipStrip sessionId={SESSION_ID} parts={mixedParts()} />);

    const tray = await openTray(user);
    await user.click(
      within(tray).getByRole('button', { name: 'Fetched https://example.com/page' })
    );

    const { openDocuments, canvasOpen, rightPanelOpen, activeRightPanelTab } = canvasState();
    expect(openDocuments).toHaveLength(1);
    expect(openDocuments[0].content).toEqual({ type: 'url', url: 'https://example.com/page' });
    expect(canvasOpen).toBe(true);
    expect(rightPanelOpen).toBe(true);
    // A `url` is a Browser-view document. Revealing Canvas here would show an
    // empty canvas with the page one tab over — and, at `'user'` origin, would
    // persist that wrong tab as the reader's per-agent preference (DOR-227).
    expect(activeRightPanelTab).toBe('browser');
  });

  it('opens nothing for a glob pattern, and says why in the tooltip', async () => {
    // A pattern names a set of files. Handing `src/**/*.ts` to the canvas as if
    // it were a path opens an empty document titled with the pattern.
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        sessionId={SESSION_ID}
        parts={[toolCall('Glob', { pattern: 'src/**/*.ts' })]}
      />
    );

    const tray = await openTray(user);
    const chip = within(tray).getByTestId('touch-chip');
    await user.click(chip);

    expect(canvasState()).toEqual({
      openDocuments: [],
      canvasOpen: false,
      rightPanelOpen: false,
      activeRightPanelTab: null,
    });
    expect(chip.getAttribute('title')).toContain('A pattern, not one file');
  });
});

describe('TouchChipStrip — URL framing', () => {
  it('routes an unsafe target to the canvas refusal without opening a window', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        sessionId={SESSION_ID}
        parts={[toolCall('WebFetch', { url: 'javascript:alert(1)' })]}
      />
    );
    const tray = await openTray(user);
    await user.click(within(tray).getByTestId('touch-chip'));
    expect(canvasState().openDocuments[0].content).toEqual({
      type: 'url',
      url: 'javascript:alert(1)',
    });
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

describe('TouchChipStrip — chip anatomy', () => {
  it('badges a repeated touch and carries the audit trail in its tooltip', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        sessionId={SESSION_ID}
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
    render(
      <TouchChipStrip sessionId={SESSION_ID} parts={[toolCall('Bash', { command: 'rm old.ts' })]} />
    );

    const tray = await openTray(user);
    const tombstone = within(tray).getByRole('button', { name: 'Deleted old.ts' });

    expect(tombstone).toHaveAttribute('data-verb', 'delete');
    expect(tombstone.className).toContain('line-through');
  });

  it('shows a created file as gained lines and nothing lost', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        sessionId={SESSION_ID}
        parts={[
          toolCall(
            'Write',
            { file_path: '/repo/src/new.ts', content: 'a\nb\nc\nd' },
            { result: 'File created successfully at: /repo/src/new.ts' }
          ),
        ]}
      />
    );

    // `✚ new.ts +4` — no `−0`, which would state a measurement nobody made.
    expect(screen.getByTestId('chip-summary-create').textContent).toBe('✚Created1+4');

    const tray = await openTray(user);
    const chip = within(tray).getByTestId('touch-chip');
    expect(chip.textContent).toBe('✚new.ts+4');
    expect(chip).toHaveAccessibleName('Created /repo/src/new.ts, 4 added');
  });

  it('tints a chip whose tool failed', async () => {
    const user = userEvent.setup();
    render(
      <TouchChipStrip
        sessionId={SESSION_ID}
        parts={[toolCall('Read', { file_path: '/repo/src/a.ts' }, { status: 'error' })]}
      />
    );

    const tray = await openTray(user);
    const chip = within(tray).getByTestId('touch-chip');

    expect(chip.className).toContain('border-destructive/40');
    expect(chip).toHaveAccessibleName('Read /repo/src/a.ts, didn’t work');
  });
});

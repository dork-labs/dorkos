/**
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { CanvasHeader, CANVAS_PANEL_ID, type CanvasHeaderDocument } from '../ui/CanvasHeader';

afterEach(cleanup);

const DOCS: CanvasHeaderDocument[] = [
  { id: 'a', sourceLabel: 'Doc A', contentType: 'markdown' },
  { id: 'b', sourceLabel: 'Doc B', contentType: 'json' },
  { id: 'c', sourceLabel: 'Doc C', contentType: 'url' },
];

/**
 * Controlled harness — the strip is a controlled widget (roving tabindex tracks
 * the active id), so tests drive real activation/close state, plus focusable
 * elements before and after the strip to prove the single Tab stop.
 */
function Harness({
  initial = 'a',
  initialDocs = DOCS,
  onCloseSpy,
}: {
  initial?: string;
  initialDocs?: CanvasHeaderDocument[];
  onCloseSpy?: (id: string) => void;
}) {
  const [docs, setDocs] = useState(initialDocs);
  const [active, setActive] = useState<string | null>(initial);

  return (
    <>
      <button type="button">before</button>
      <CanvasHeader
        documents={docs}
        activeDocumentId={active}
        onActivate={setActive}
        onClose={(id) => {
          onCloseSpy?.(id);
          const index = docs.findIndex((d) => d.id === id);
          const next = docs[index + 1] ?? docs[index - 1] ?? null;
          setDocs((cur) => cur.filter((d) => d.id !== id));
          if (active === id) setActive(next?.id ?? null);
        }}
      />
      {/* Mirrors AgentCanvas's always-mounted content container — the strip's
          Delete-last-tab fallback focus target (found by id). */}
      <div id={CANVAS_PANEL_ID} tabIndex={-1} data-testid="canvas-panel" />
      <button type="button">after</button>
    </>
  );
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('CanvasHeader — keyboard accessibility (WAI-ARIA Tabs)', () => {
  it('exposes exactly one Tab stop: the active tab is tabIndex 0, the rest -1', () => {
    render(<Harness initial="b" />);
    expect(tab('Doc A')).toHaveAttribute('tabindex', '-1');
    expect(tab('Doc B')).toHaveAttribute('tabindex', '0');
    expect(tab('Doc C')).toHaveAttribute('tabindex', '-1');
  });

  it('Tab enters the strip once (lands on active) and the next Tab leaves it', async () => {
    const user = userEvent.setup();
    render(<Harness initial="b" />);

    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(tab('Doc B')).toHaveFocus();

    await user.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('ArrowRight moves focus and activates, wrapping at the end', async () => {
    const user = userEvent.setup();
    render(<Harness initial="a" />);
    tab('Doc A').focus();

    await user.keyboard('{ArrowRight}');
    expect(tab('Doc B')).toHaveFocus();
    expect(tab('Doc B')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(tab('Doc C')).toHaveFocus();

    // Wrap end → first.
    await user.keyboard('{ArrowRight}');
    expect(tab('Doc A')).toHaveFocus();
    expect(tab('Doc A')).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowLeft wraps at the start', async () => {
    const user = userEvent.setup();
    render(<Harness initial="a" />);
    tab('Doc A').focus();

    await user.keyboard('{ArrowLeft}');
    expect(tab('Doc C')).toHaveFocus();
    expect(tab('Doc C')).toHaveAttribute('aria-selected', 'true');
  });

  it('Home and End jump to the first and last tabs', async () => {
    const user = userEvent.setup();
    render(<Harness initial="b" />);
    tab('Doc B').focus();

    await user.keyboard('{End}');
    expect(tab('Doc C')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(tab('Doc A')).toHaveFocus();
  });

  it('Delete closes the focused tab and moves focus to the neighbor', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness initial="b" onCloseSpy={onClose} />);
    tab('Doc B').focus();

    await user.keyboard('{Delete}');
    expect(onClose).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('tab', { name: 'Doc B' })).not.toBeInTheDocument();
    // Neighbor (the tab that shifted into the slot) receives focus.
    expect(tab('Doc C')).toHaveFocus();
  });

  it('Delete on the only document lands focus on the canvas container, not the body', async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial="a"
        initialDocs={[{ id: 'a', sourceLabel: 'Doc A', contentType: 'markdown' }]}
      />
    );
    tab('Doc A').focus();

    await user.keyboard('{Delete}');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByTestId('canvas-panel')).toHaveFocus();
  });

  it('advertises the Delete shortcut via aria-keyshortcuts on each tab', () => {
    render(<Harness />);
    expect(tab('Doc A')).toHaveAttribute('aria-keyshortcuts', 'Delete');
  });

  it('the × close control is not a Tab stop (tabIndex -1) but is clickable', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onCloseSpy={onClose} />);

    const close = screen.getByRole('button', { name: 'Close Doc A' });
    expect(close).toHaveAttribute('tabindex', '-1');

    await user.click(close);
    expect(onClose).toHaveBeenCalledWith('a');
  });

  it('wires the active tab to the canvas panel via aria-controls', () => {
    render(<Harness initial="a" />);
    expect(tab('Doc A')).toHaveAttribute('aria-controls', CANVAS_PANEL_ID);
    expect(tab('Doc B')).not.toHaveAttribute('aria-controls');
  });

  it('keeps the tab and its close control as siblings (valid nesting)', () => {
    render(<Harness />);
    // The tab is the button itself; the close button must NOT be a descendant.
    expect(within(tab('Doc A')).queryByRole('button')).toBeNull();
  });
});

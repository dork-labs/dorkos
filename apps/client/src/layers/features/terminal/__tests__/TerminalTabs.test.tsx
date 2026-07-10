/**
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TerminalTabs, TERMINAL_PANEL_ID, type TerminalTabDescriptor } from '../ui/TerminalTabs';

afterEach(cleanup);

const TABS: TerminalTabDescriptor[] = [
  { key: 't1', label: 'Terminal 1' },
  { key: 't2', label: 'Terminal 2' },
  { key: 't3', label: 'Terminal 3' },
];

/** Controlled harness with a focusable element before the strip and a live "+" after. */
function Harness({
  initial = 't1',
  initialTabs = TABS,
  onActivateSpy,
  onCloseSpy,
  onCreateSpy,
}: {
  initial?: string;
  initialTabs?: TerminalTabDescriptor[];
  onActivateSpy?: (key: string, source: string) => void;
  onCloseSpy?: (key: string, source: string) => void;
  onCreateSpy?: () => void;
}) {
  const [tabs, setTabs] = useState(initialTabs);
  const [active, setActive] = useState<string | null>(initial);

  return (
    <>
      <button type="button">before</button>
      <TerminalTabs
        tabs={tabs}
        activeKey={active}
        onActivate={(key, source) => {
          onActivateSpy?.(key, source);
          setActive(key);
        }}
        onClose={(key, source) => {
          onCloseSpy?.(key, source);
          const index = tabs.findIndex((t) => t.key === key);
          const next = tabs[index + 1] ?? tabs[index - 1] ?? null;
          setTabs((cur) => cur.filter((t) => t.key !== key));
          if (active === key) setActive(next?.key ?? null);
        }}
        onCreate={() => onCreateSpy?.()}
      />
    </>
  );
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name });
}

describe('TerminalTabs — keyboard accessibility (WAI-ARIA Tabs)', () => {
  it('exposes exactly one Tab stop: the active tab is tabIndex 0, the rest -1', () => {
    render(<Harness initial="t2" />);
    expect(tab('Terminal 1')).toHaveAttribute('tabindex', '-1');
    expect(tab('Terminal 2')).toHaveAttribute('tabindex', '0');
    expect(tab('Terminal 3')).toHaveAttribute('tabindex', '-1');
  });

  it('Tab enters the strip once, then Tab lands on the "+" button OUTSIDE the tablist', async () => {
    const user = userEvent.setup();
    render(<Harness initial="t2" />);

    screen.getByRole('button', { name: 'before' }).focus();
    await user.tab();
    expect(tab('Terminal 2')).toHaveFocus();

    // The "+" is an ordinary Tab stop outside the tablist widget.
    await user.tab();
    const plus = screen.getByRole('button', { name: 'New terminal' });
    expect(plus).toHaveFocus();
    // Confirm structurally: "+" is not inside the tablist element.
    expect(screen.getByRole('tablist')).not.toContainElement(plus);
  });

  it('ArrowRight/ArrowLeft move focus and activate, wrapping at both ends', async () => {
    const user = userEvent.setup();
    render(<Harness initial="t1" />);
    tab('Terminal 1').focus();

    await user.keyboard('{ArrowRight}');
    expect(tab('Terminal 2')).toHaveFocus();
    expect(tab('Terminal 2')).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowLeft}');
    expect(tab('Terminal 1')).toHaveFocus();

    // Wrap start → end.
    await user.keyboard('{ArrowLeft}');
    expect(tab('Terminal 3')).toHaveFocus();

    // Wrap end → start.
    await user.keyboard('{ArrowRight}');
    expect(tab('Terminal 1')).toHaveFocus();
  });

  it('Home and End jump to the first and last tabs', async () => {
    const user = userEvent.setup();
    render(<Harness initial="t2" />);
    tab('Terminal 2').focus();

    await user.keyboard('{End}');
    expect(tab('Terminal 3')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(tab('Terminal 1')).toHaveFocus();
  });

  it('Delete closes the focused tab and moves focus to the neighbor', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness initial="t3" onCloseSpy={onClose} />);
    tab('Terminal 3').focus();

    await user.keyboard('{Delete}');
    expect(onClose).toHaveBeenCalledWith('t3', 'keyboard');
    expect(screen.queryByRole('tab', { name: 'Terminal 3' })).not.toBeInTheDocument();
    // Closing the last tab falls back to the previous one.
    expect(tab('Terminal 2')).toHaveFocus();
  });

  it('Delete on the only tab lands focus on the "+" button, not the body', async () => {
    const user = userEvent.setup();
    render(<Harness initial="t1" initialTabs={[{ key: 't1', label: 'Terminal 1' }]} />);
    tab('Terminal 1').focus();

    await user.keyboard('{Delete}');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New terminal' })).toHaveFocus();
  });

  it('reports the activation source: keyboard for arrows, pointer for clicks', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Harness initial="t1" onActivateSpy={onActivate} />);

    tab('Terminal 1').focus();
    await user.keyboard('{ArrowRight}');
    expect(onActivate).toHaveBeenLastCalledWith('t2', 'keyboard');

    await user.click(tab('Terminal 3'));
    expect(onActivate).toHaveBeenLastCalledWith('t3', 'pointer');
  });

  it('the × close control is not a Tab stop (tabIndex -1) but is clickable', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onCloseSpy={onClose} />);

    const close = screen.getByRole('button', { name: 'Close Terminal 1' });
    expect(close).toHaveAttribute('tabindex', '-1');

    await user.click(close);
    expect(onClose).toHaveBeenCalledWith('t1', 'pointer');
  });

  it('advertises the Delete shortcut and wires the active tab to the panel', () => {
    render(<Harness initial="t1" />);
    expect(tab('Terminal 1')).toHaveAttribute('aria-keyshortcuts', 'Delete');
    expect(tab('Terminal 1')).toHaveAttribute('aria-controls', TERMINAL_PANEL_ID);
    expect(tab('Terminal 2')).not.toHaveAttribute('aria-controls');
  });

  it('keeps the tab and its close control as siblings (valid nesting)', () => {
    render(<Harness />);
    expect(within(tab('Terminal 1')).queryByRole('button')).toBeNull();
  });

  it('creates a terminal when the "+" is clicked', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    render(<Harness onCreateSpy={onCreate} />);

    await user.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});

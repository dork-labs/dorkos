/**
 * @vitest-environment jsdom
 */
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { useRovingTabList } from '../use-roving-tab-list';

afterEach(cleanup);

/** Minimal tablist driven by the hook, controlled so activation is real. */
function Strip({
  closable = false,
  initialIds = ['x', 'y', 'z'],
  withFallback = false,
  onActivateSpy,
  onCloseSpy,
}: {
  closable?: boolean;
  initialIds?: string[];
  withFallback?: boolean;
  onActivateSpy?: (id: string, source: string) => void;
  onCloseSpy?: (id: string, source: string) => void;
}) {
  const [ids, setIds] = useState(initialIds);
  const [active, setActive] = useState<string | null>(initialIds[0] ?? null);
  const { getTabProps } = useRovingTabList({
    orderedIds: ids,
    activeId: active,
    onActivate: (id, source) => {
      onActivateSpy?.(id, source);
      setActive(id);
    },
    onClose: closable
      ? (id, source) => {
          onCloseSpy?.(id, source);
          const i = ids.findIndex((v) => v === id);
          const next = ids[i + 1] ?? ids[i - 1] ?? null;
          setIds((cur) => cur.filter((v) => v !== id));
          if (active === id) setActive(next);
        }
      : undefined,
    getFallbackFocus: withFallback ? () => document.getElementById('fallback') : undefined,
  });

  return (
    <>
      <div role="tablist" aria-label="strip">
        {ids.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === active}
            {...getTabProps(id)}
          >
            {id}
          </button>
        ))}
      </div>
      {withFallback && <button id="fallback" type="button" />}
    </>
  );
}

describe('useRovingTabList', () => {
  it('marks only the active tab as the Tab stop', () => {
    render(<Strip />);
    expect(screen.getByRole('tab', { name: 'x' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'y' })).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tab', { name: 'z' })).toHaveAttribute('tabindex', '-1');
  });

  it('arrow keys move focus and activate with wrap-around', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    screen.getByRole('tab', { name: 'x' }).focus();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'z' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'z' })).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'x' })).toHaveFocus();
  });

  it('Home/End jump to the ends', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    screen.getByRole('tab', { name: 'x' }).focus();

    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'z' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'x' })).toHaveFocus();
  });

  it('adds aria-keyshortcuts only when closable, and Delete closes + refocuses a neighbor', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Strip closable onCloseSpy={onClose} />);

    const y = screen.getByRole('tab', { name: 'y' });
    expect(y).toHaveAttribute('aria-keyshortcuts', 'Delete');
    y.focus();

    await user.keyboard('{Delete}');
    expect(onClose).toHaveBeenCalledWith('y', 'keyboard');
    expect(screen.queryByRole('tab', { name: 'y' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'z' })).toHaveFocus();
  });

  it('omits aria-keyshortcuts and ignores Delete when not closable', async () => {
    const user = userEvent.setup();
    render(<Strip />);
    const y = screen.getByRole('tab', { name: 'y' });
    expect(y).not.toHaveAttribute('aria-keyshortcuts');
    y.focus();

    await user.keyboard('{Delete}');
    expect(screen.getByRole('tab', { name: 'y' })).toBeInTheDocument();
  });

  it('Delete on the last tab focuses the getFallbackFocus element, not the body', async () => {
    const user = userEvent.setup();
    render(<Strip closable withFallback initialIds={['only']} />);
    screen.getByRole('tab', { name: 'only' }).focus();

    await user.keyboard('{Delete}');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(document.getElementById('fallback')).toHaveFocus();
  });

  it('reports the activation source: pointer via onClick, keyboard via arrows', async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Strip onActivateSpy={onActivate} />);

    await user.click(screen.getByRole('tab', { name: 'y' }));
    expect(onActivate).toHaveBeenLastCalledWith('y', 'pointer');

    screen.getByRole('tab', { name: 'y' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onActivate).toHaveBeenLastCalledWith('z', 'keyboard');
  });
});

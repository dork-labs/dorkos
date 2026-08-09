/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  useRovingFocus,
  SIDEBAR_ACTIONS_ATTRIBUTE,
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_SECTION_TOGGLE_ATTRIBUTE,
} from '../use-roving-focus';

afterEach(() => cleanup());

/**
 * A section shaped like the real thing: a header, rows, and a "⋮" beside every
 * row and the header.
 *
 * **The kebabs are the point.** The first version of this hook counted only
 * rows, so its test could not see the four Tab stops a three-row section
 * actually had. This fixture reproduces the production DOM — `SidebarRow` and
 * `SectionHeader` both render a real `<button>` for the menu — so the
 * assertions below are about the whole section, not a convenient slice of it.
 */
function Section({
  rows,
  activeIndex = null,
  onCollapse,
  onExpand,
  withHeader = true,
  extra,
}: {
  rows: string[];
  activeIndex?: number | null;
  onCollapse?: () => void;
  onExpand?: () => void;
  withHeader?: boolean;
  /** Anything else that re-renders with the section, to prove the stop survives it. */
  extra?: string;
}) {
  const roving = useRovingFocus({ onCollapse, onExpand });
  return (
    <div {...roving}>
      {withHeader && (
        <h3 className="relative">
          <button type="button" {...{ [SIDEBAR_SECTION_TOGGLE_ATTRIBUTE]: '' }}>
            Channels
          </button>
          <button type="button" {...{ [SIDEBAR_ACTIONS_ATTRIBUTE]: '' }}>
            Channels actions
          </button>
        </h3>
      )}
      {rows.map((label, index) => (
        <li key={label} data-slot="sidebar-menu-item" className="relative">
          <button
            type="button"
            {...{ [SIDEBAR_ROW_ATTRIBUTE]: '' }}
            aria-current={index === activeIndex ? 'page' : undefined}
          >
            {label}
          </button>
          <button type="button" {...{ [SIDEBAR_ACTIONS_ATTRIBUTE]: '' }}>
            {label} actions
          </button>
        </li>
      ))}
      {extra !== undefined && <span>{extra}</span>}
    </div>
  );
}

const ROWS = ['one', 'two', 'three', 'four'];

/**
 * Every element in the section a browser would put in the tab order, and the
 * `tabIndex` it carries.
 *
 * Queried by what a BROWSER considers focusable, not by the marks the hook
 * happens to know about — a test that asks the hook's own question can never
 * fail for the thing this test exists to catch.
 */
function focusables(): { label: string; tabIndex: number }[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')
  ).map((element) => ({
    label: element.textContent?.trim() ?? '',
    tabIndex: element.tabIndex,
  }));
}

/** The elements a `Tab` press would actually stop on. */
function tabStops(): string[] {
  return focusables()
    .filter((element) => element.tabIndex === 0)
    .map((element) => element.label);
}

describe('useRovingFocus — one Tab stop per section', () => {
  it('leaves exactly ONE Tab stop, counting every focusable and not only the rows', () => {
    // The regression that shipped: rows were stamped `-1` but each row's "⋮"
    // was not, so a three-row section was four stops and a 60-agent Library was
    // sixty-one. Counting only rows could not see it.
    render(<Section rows={ROWS} />);
    expect(focusables()).toHaveLength(2 + ROWS.length * 2); // header + its ⋮, then each row + its ⋮
    expect(tabStops()).toEqual(['Channels']);
  });

  it('puts the stop on the row the reader is already on', () => {
    render(<Section rows={ROWS} activeIndex={2} />);
    expect(tabStops()).toEqual(['three']);
  });

  it('falls back to the top of the section when no row is the current page', () => {
    render(<Section rows={ROWS} activeIndex={null} />);
    expect(tabStops()).toEqual(['Channels']);
  });

  it('starts at the first ROW when the section has no header', () => {
    render(<Section rows={ROWS} withHeader={false} />);
    expect(tabStops()).toEqual(['one']);
  });
});

describe('useRovingFocus — moving inside the section', () => {
  it('walks the header and the rows with the arrows, taking the Tab stop along', () => {
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('Channels'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('one'));
    expect(tabStops()).toEqual(['one']);

    fireEvent.keyDown(screen.getByText('one'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('two'));
    expect(tabStops()).toEqual(['two']);

    fireEvent.keyDown(screen.getByText('two'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByText('one'));
    expect(tabStops()).toEqual(['one']);
  });

  it('stops at the ends rather than wrapping', () => {
    // A reader who arrows past the last row should be told by nothing
    // happening, not teleported to the top of a list they cannot see all of.
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('Channels'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByText('Channels'));

    screen.getByText('four').focus();
    fireEvent.keyDown(screen.getByText('four'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('four'));
  });

  it('jumps to the ends with Home and End', () => {
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByText('four'));

    fireEvent.keyDown(screen.getByText('four'), { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByText('Channels'));
  });

  it('leaves keys it does not own alone', () => {
    render(<Section rows={ROWS} />);
    const first = screen.getByText('one');
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(first);
  });
});

describe('useRovingFocus — the ⋮ is a satellite, not a stop', () => {
  it('steps sideways onto a row’s ⋮ with ArrowRight and back with ArrowLeft', () => {
    // The keyboard path to a control that is otherwise revealed by a pointer
    // the reader does not have (WCAG, spec R2).
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('two'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByText('two actions'));

    fireEvent.keyDown(screen.getByText('two actions'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByText('two'));
  });

  it('does not make the ⋮ a Tab stop of its own when focus moves to it', () => {
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('two'), { key: 'ArrowRight' });
    // Focus is on the kebab, but Tab still has exactly one place to land — and
    // it is the row, so leaving and returning puts the reader back on the list.
    expect(tabStops()).toEqual(['two']);
  });

  it('collapses and expands the section from the header’s left and right arrows', () => {
    const onCollapse = vi.fn();
    const onExpand = vi.fn();
    render(<Section rows={ROWS} onCollapse={onCollapse} onExpand={onExpand} />);

    const header = screen.getByText('Channels');
    fireEvent.keyDown(header, { key: 'ArrowLeft' });
    expect(onCollapse).toHaveBeenCalledOnce();
    fireEvent.keyDown(header, { key: 'ArrowRight' });
    expect(onExpand).toHaveBeenCalledOnce();
    // And the header keeps focus — folding a section is not leaving it.
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe('useRovingFocus — the stop survives', () => {
  it('holds where the reader left it across an unrelated re-render', () => {
    // The regression that shipped: `useEffect(sync)` re-derived the stop from
    // `aria-current` on EVERY commit, so an unread count ticking sent the
    // reader back to the top of the section. Shift+Tab out, Tab back in, and
    // they were somewhere they had never been.
    const { rerender } = render(<Section rows={ROWS} activeIndex={0} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByText('two'), { key: 'ArrowDown' });
    expect(tabStops()).toEqual(['three']);

    // Anything at all commits — an unread badge, a query settling.
    rerender(<Section rows={ROWS} activeIndex={0} extra="an unread count ticked" />);
    expect(tabStops()).toEqual(['three']);

    rerender(<Section rows={ROWS} activeIndex={0} extra="and again" />);
    expect(tabStops()).toEqual(['three']);
  });

  it('re-homes only when the parked row actually leaves the DOM', () => {
    const { rerender } = render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'End' });
    expect(tabStops()).toEqual(['four']);

    // 'four' is filtered out — the stop has to go somewhere real.
    rerender(<Section rows={['one', 'two', 'three']} activeIndex={1} />);
    expect(tabStops()).toEqual(['two']);
  });

  it('survives a section with no rows at all', () => {
    expect(() => render(<Section rows={[]} />)).not.toThrow();
  });
});

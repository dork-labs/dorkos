/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import {
  useRovingFocus,
  SIDEBAR_ACTIONS_ATTRIBUTE,
  SIDEBAR_GLYPH_ACTION_ATTRIBUTE,
  SIDEBAR_ROW_ATTRIBUTE,
  SIDEBAR_SECTION_ACTION_ATTRIBUTE,
  SIDEBAR_SECTION_TOGGLE_ATTRIBUTE,
  SIDEBAR_TRAILING_ACTION_ATTRIBUTE,
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
  withSectionAction = false,
  withEditor = false,
  extra,
}: {
  rows: string[];
  activeIndex?: number | null;
  onCollapse?: () => void;
  onExpand?: () => void;
  withHeader?: boolean;
  /** Draw the section's `+`, the way `useSectionChrome` mounts it. */
  withSectionAction?: boolean;
  /** Mount an inline editor, the way a rename or a group-create field does. */
  withEditor?: boolean;
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
      {withSectionAction && (
        <button type="button" {...{ [SIDEBAR_SECTION_ACTION_ATTRIBUTE]: '' }}>
          New channel
        </button>
      )}
      {withEditor && <input aria-label="Group name" />}
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

  it('makes the section’s "+" a stop of its own, between the header and the rows', () => {
    // The defect: every focusable in the section was stamped `-1` and only the
    // header and rows were offered as stops, so "New channel", "New group
    // message", "New agent" and "New section" had a pointer door and no
    // keyboard one at all. Red the moment the `+` drops out of `stopsIn`.
    render(<Section rows={ROWS} withSectionAction />);
    const toggle = screen.getByText('Channels');
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('New channel'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('still leaves exactly one Tab stop once the "+" is a stop', () => {
    // The pair: a stop is not a Tab stop. Making the `+` reachable by arrow must
    // not put it back in the tab order and undo the whole point of the hook.
    render(<Section rows={ROWS} withSectionAction />);
    expect(tabStops()).toEqual(['Channels']);
  });

  it('sends Home past the "+" to the first ROW', () => {
    // Home means "the top of the list", and the `+` is not in the list. Before
    // the `+` existed this read "not the header"; that spelling would have
    // landed Home on the `+` the day it did.
    render(<Section rows={ROWS} withSectionAction />);
    const toggle = screen.getByText('Channels');
    toggle.focus();
    fireEvent.keyDown(toggle, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('leaves a mounted inline editor in the tab order (DOR-329-adjacent)', () => {
    // A rename field is mounted BECAUSE the reader is typing in it, and the
    // stamp took it out of the tab order at exactly that moment: you could not
    // Tab out of the field, and a reader who Tabbed away could not Tab back.
    render(<Section rows={ROWS} withEditor />);
    expect(screen.getByLabelText('Group name').tabIndex).toBe(0);
    // …and the section still has its own single stop beside it, so the editor
    // is an addition for as long as it is mounted rather than a replacement.
    expect(tabStops()).toEqual(['Channels', '']);
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

  it('jumps to the first ROW with Home and the last with End', () => {
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByText('four'));

    // Home is the top of the LIST, not the heading above it. The section's
    // rows are the things a reader came here to open; a Home that parks them
    // on the collapse toggle costs an ArrowDown every single time, and it is
    // the asymmetry that gives it away — End lands on a row, so Home should.
    fireEvent.keyDown(screen.getByText('four'), { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('takes Home DOWN off the header, because the first row is still the first row', () => {
    render(<Section rows={ROWS} />);
    const header = screen.getByText('Channels');
    header.focus();
    fireEvent.keyDown(header, { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('leaves Home on the header when the section has no rows to send it to', () => {
    // The same setup with the one variable flipped: with rows, Home moves; with
    // none, the header is the only stop there is and Home has to stay put
    // rather than land on nothing.
    render(<Section rows={[]} />);
    const header = screen.getByText('Channels');
    header.focus();
    fireEvent.keyDown(header, { key: 'Home' });
    expect(document.activeElement).toBe(header);
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

/**
 * A row wearing all three satellites, as `SidebarRow` renders them: the glyph
 * control to the left of the row, then the trailing control and the "⋮" in the
 * right gutter.
 */
function LoadedRow() {
  const roving = useRovingFocus();
  return (
    <div {...roving}>
      <li data-slot="sidebar-menu-item" className="relative">
        <button type="button" {...{ [SIDEBAR_GLYPH_ACTION_ATTRIBUTE]: '' }}>
          face
        </button>
        <button type="button" {...{ [SIDEBAR_ROW_ATTRIBUTE]: '' }}>
          Scout
        </button>
        <button type="button" {...{ [SIDEBAR_TRAILING_ACTION_ATTRIBUTE]: '' }}>
          3 live
        </button>
        <button type="button" {...{ [SIDEBAR_ACTIONS_ATTRIBUTE]: '' }}>
          Scout actions
        </button>
      </li>
    </div>
  );
}

describe('useRovingFocus — the row’s lane of satellites', () => {
  /** Press a sideways arrow on whatever currently has focus. */
  function arrow(key: 'ArrowLeft' | 'ArrowRight') {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key });
  }

  it('walks out along the right gutter — row, then the control, then the ⋮', () => {
    // A control in the right gutter used to be reachable by pointer ONLY:
    // ArrowRight was hard-coded to mean "the ⋮", so anything between the row
    // and the kebab was skipped and a keyboard reader could never press it.
    render(<LoadedRow />);
    screen.getByText('Scout').focus();

    arrow('ArrowRight');
    expect(document.activeElement).toBe(screen.getByText('3 live'));
    arrow('ArrowRight');
    expect(document.activeElement).toBe(screen.getByText('Scout actions'));
    // And no further — the end of the lane is the end of it.
    arrow('ArrowRight');
    expect(document.activeElement).toBe(screen.getByText('Scout actions'));
  });

  it('walks back in the same order, and on past the row to the glyph', () => {
    render(<LoadedRow />);
    screen.getByText('Scout actions').focus();

    arrow('ArrowLeft');
    expect(document.activeElement).toBe(screen.getByText('3 live'));
    arrow('ArrowLeft');
    expect(document.activeElement).toBe(screen.getByText('Scout'));
    arrow('ArrowLeft');
    expect(document.activeElement).toBe(screen.getByText('face'));
    arrow('ArrowLeft');
    expect(document.activeElement).toBe(screen.getByText('face'));
  });

  it('keeps the Tab stop on the ROW however far out the lane focus has walked', () => {
    // Each satellite is a visit, not a destination: Tab out and back should
    // return the reader to the list rather than to a control they were passing.
    render(<LoadedRow />);
    screen.getByText('Scout').focus();
    arrow('ArrowRight');
    expect(tabStops()).toEqual(['Scout']);
    arrow('ArrowRight');
    expect(tabStops()).toEqual(['Scout']);
  });

  it('leaves a row with no trailing control walking straight to its ⋮', () => {
    // The lane skips what a row does not have, so the sidebar's existing rows
    // keep exactly the two-satellite behaviour they shipped with.
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('two'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByText('two actions'));
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

  it('re-homes only when the parked row actually leaves the DOM', async () => {
    const { rerender } = render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'End' });
    expect(tabStops()).toEqual(['four']);

    // 'four' is filtered out — the stop has to go somewhere real.
    rerender(<Section rows={['one', 'two', 'three']} activeIndex={1} />);
    // **Awaited, because the re-stamp is driven by a `MutationObserver` now
    // rather than by every commit** (D8). Its callback is a microtask, so it
    // runs after this render and before the browser paints — a reader never
    // sees the intermediate state, but a synchronous assertion does.
    await waitFor(() => expect(tabStops()).toEqual(['two']));
  });

  it('survives a section with no rows at all', () => {
    expect(() => render(<Section rows={[]} />)).not.toThrow();
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useRovingFocus, SIDEBAR_SECTION_TOGGLE_ATTRIBUTE } from '../use-roving-focus';
import { SIDEBAR_ROW_ATTRIBUTE } from '../use-roving-focus';

afterEach(() => cleanup());

/** A section: an optional header toggle above a list of rows. */
function Section({
  rows,
  activeIndex = null,
  onCollapse,
  onExpand,
  withHeader = false,
}: {
  rows: string[];
  activeIndex?: number | null;
  onCollapse?: () => void;
  onExpand?: () => void;
  withHeader?: boolean;
}) {
  const roving = useRovingFocus({ onCollapse, onExpand });
  return (
    <div {...roving}>
      {withHeader && (
        <button type="button" {...{ [SIDEBAR_SECTION_TOGGLE_ATTRIBUTE]: '' }}>
          Channels
        </button>
      )}
      {rows.map((label, index) => (
        <button
          key={label}
          type="button"
          {...{ [SIDEBAR_ROW_ATTRIBUTE]: '' }}
          aria-current={index === activeIndex ? 'page' : undefined}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const ROWS = ['one', 'two', 'three', 'four'];

/** Every row's tabIndex, in DOM order. */
function tabStops(): number[] {
  return ROWS.map((label) => screen.getByText(label).tabIndex);
}

describe('useRovingFocus', () => {
  it('leaves exactly one Tab stop in the section, however many rows there are', () => {
    // The whole point: a 60-agent Library is one Tab stop, not sixty.
    render(<Section rows={ROWS} />);
    expect(tabStops()).toEqual([0, -1, -1, -1]);
  });

  it('puts the stop on the row the reader is already on', () => {
    render(<Section rows={ROWS} activeIndex={2} />);
    expect(tabStops()).toEqual([-1, -1, 0, -1]);
  });

  it('falls back to the first row when the active row is somewhere else', () => {
    render(<Section rows={ROWS} activeIndex={null} />);
    expect(tabStops()).toEqual([0, -1, -1, -1]);
  });

  it('moves down and up with the arrows, taking the Tab stop along', () => {
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('two'));
    expect(tabStops()).toEqual([-1, 0, -1, -1]);

    fireEvent.keyDown(screen.getByText('two'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByText('one'));
    expect(tabStops()).toEqual([0, -1, -1, -1]);
  });

  it('stops at the ends rather than wrapping', () => {
    // A reader who arrows past the last row should be told by nothing
    // happening, not teleported to the top of a list they cannot see all of.
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(screen.getByText('one'));

    screen.getByText('four').focus();
    fireEvent.keyDown(screen.getByText('four'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByText('four'));
  });

  it('jumps to the ends with Home and End', () => {
    render(<Section rows={ROWS} />);
    fireEvent.keyDown(screen.getByText('one'), { key: 'End' });
    expect(document.activeElement).toBe(screen.getByText('four'));

    fireEvent.keyDown(screen.getByText('four'), { key: 'Home' });
    expect(document.activeElement).toBe(screen.getByText('one'));
  });

  it('leaves keys it does not own alone', () => {
    render(<Section rows={ROWS} />);
    const first = screen.getByText('one');
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(document.activeElement).toBe(first);
  });

  it('collapses and expands the section from the header’s left and right arrows', () => {
    const onCollapse = vi.fn();
    const onExpand = vi.fn();
    render(<Section rows={ROWS} withHeader onCollapse={onCollapse} onExpand={onExpand} />);

    const header = screen.getByText('Channels');
    fireEvent.keyDown(header, { key: 'ArrowLeft' });
    expect(onCollapse).toHaveBeenCalledOnce();
    fireEvent.keyDown(header, { key: 'ArrowRight' });
    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('does not move the row focus from a header key', () => {
    const onCollapse = vi.fn();
    render(<Section rows={ROWS} withHeader onCollapse={onCollapse} />);
    const header = screen.getByText('Channels');
    header.focus();
    fireEvent.keyDown(header, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(header);
  });

  it('re-stamps the stop when the rows change under it', () => {
    // Rows arrive from queries and leave on filter changes; the section must
    // never end up with two Tab stops or none.
    const { rerender } = render(<Section rows={ROWS} activeIndex={2} />);
    expect(tabStops()).toEqual([-1, -1, 0, -1]);
    rerender(<Section rows={ROWS} activeIndex={0} />);
    expect(tabStops()).toEqual([0, -1, -1, -1]);
  });

  it('survives a section with no rows at all', () => {
    expect(() => render(<Section rows={[]} withHeader />)).not.toThrow();
  });
});

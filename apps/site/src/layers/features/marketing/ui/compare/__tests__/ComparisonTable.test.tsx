/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { COMPARISON_DIMENSIONS, comparisons, type Competitor } from '../../../lib/comparisons';
import { ComparisonTable } from '../ComparisonTable';

/** A real catalog entry, so the table renders against the shape the site ships. */
const cursor = comparisons.find((entry) => entry.slug === 'cursor') as Competitor;

/**
 * These assert structure and applied classes only. jsdom lays nothing out, so
 * whether the heading actually clears the header and whether the label actually
 * stays put are settled by driving a real browser, not here.
 */
describe('ComparisonTable', () => {
  it('anchors each row inside its leftmost cell, so a jump never scrolls the frame sideways', () => {
    render(<ComparisonTable competitor={cursor} />);
    for (const dimension of COMPARISON_DIMENSIONS) {
      const target = document.getElementById(`row-${dimension.id}`);
      expect(target, `no anchor target for row "${dimension.id}"`).not.toBeNull();
      const cell = target?.closest('th');
      expect(cell, `row-${dimension.id} does not sit inside a cell`).not.toBeNull();
      expect(
        cell?.getAttribute('scope'),
        `row-${dimension.id} anchors outside the row-label cell`
      ).toBe('row');
      expect(cell?.cellIndex, `row-${dimension.id} is not in the leftmost cell`).toBe(0);
      // Browsers ignore scroll-margin on a table cell, so the anchor has to be a
      // plain element inside it rather than the cell itself.
      expect(target?.tagName, `row-${dimension.id} anchors the cell itself`).not.toBe('TH');
    }
  });

  it('offsets the row anchor so a jump does not land under the fixed header', () => {
    render(<ComparisonTable competitor={cursor} />);
    const target = document.getElementById(`row-${COMPARISON_DIMENSIONS[0].id}`);
    expect(target?.className, 'row anchor carries no scroll offset').toMatch(/\bscroll-mt-\d+\b/);
  });

  it('pins the row label from sm up, where there is room for it beside a full column', () => {
    render(<ComparisonTable competitor={cursor} />);
    const cell = document.getElementById(`row-${COMPARISON_DIMENSIONS[0].id}`)?.closest('th');
    const className = cell?.className ?? '';
    expect(className, 'row label is not pinned on a wide screen').toContain('sm:sticky');
    expect(className, 'row label does not pin to the left edge').toContain('sm:left-0');
    // Without an opaque background the scrolled columns read straight through it.
    expect(className, 'pinned label has no opaque background').toContain('sm:bg-cream-primary');
    // Pinning on a phone is what made a full column unreadable at any scroll
    // position, so below sm it must be an ordinary block.
    expect(className, 'row label is still pinned on a phone').not.toMatch(/(^|\s)sticky(\s|$)/);
  });

  it('drops the sideways scroll entirely on a phone, so no cell is ever cut off', () => {
    const { container } = render(<ComparisonTable competitor={cursor} />);
    const table = container.querySelector('table');
    const className = table?.className ?? '';
    // A min-width below sm is what forced the columns off screen. The table only
    // becomes a fixed-layout table once there is room for one.
    expect(className, 'table still forces a minimum width on a phone').not.toMatch(/(^|\s)min-w-/);
    expect(className, 'table does not lay out as blocks on a phone').toContain('block');
    expect(className, 'table never becomes a table on a wider screen').toContain('sm:table');
    expect(className, 'wide layout does not use fixed column widths').toContain('sm:table-fixed');
  });

  it('names the side each cell belongs to where no column header is on screen', () => {
    render(<ComparisonTable competitor={cursor} />);
    // The header row is hidden on a phone, so an unlabelled cell would be an
    // unattributed verdict about one of two products.
    const headings = screen.getAllByText('Cursor', { selector: 'span' });
    expect(headings.length, 'cells are not labelled for the stacked layout').toBeGreaterThan(0);
    expect(headings[0].className).toContain('sm:hidden');
  });

  it('keeps the "more on" link short on screen but distinct to a screen reader', () => {
    render(<ComparisonTable competitor={cursor} />);
    const links = screen.getAllByRole('link', { name: /^More on / });
    const visible = links.filter((link) => link.getAttribute('href')?.startsWith('#criterion-'));
    expect(visible.length).toBeGreaterThan(0);
    for (const link of visible) {
      expect(link.textContent, 'link repeats the whole dimension label on screen').toBe(
        'More on this'
      );
      const label = link.getAttribute('aria-label') ?? '';
      expect(label, 'every "more on" link reads the same to a screen reader').not.toBe(
        'More on this'
      );
      expect(label.startsWith('More on ')).toBe(true);
    }
    // Distinct from each other, which is the whole point of the label.
    const labels = visible.map((link) => link.getAttribute('aria-label'));
    expect(new Set(labels).size).toBe(labels.length);
  });
});

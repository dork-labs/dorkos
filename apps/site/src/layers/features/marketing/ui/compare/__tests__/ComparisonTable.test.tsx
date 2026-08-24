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

  it('pins the row label so it survives scrolling the table sideways', () => {
    render(<ComparisonTable competitor={cursor} />);
    const cell = document.getElementById(`row-${COMPARISON_DIMENSIONS[0].id}`)?.closest('th');
    const className = cell?.className ?? '';
    expect(className, 'row label is not sticky').toContain('sticky');
    expect(className, 'row label does not pin to the left edge').toContain('left-0');
    // Without an opaque background the scrolled columns read straight through it.
    expect(className, 'row label has no opaque background').toMatch(/\bbg-cream-primary\b/);
  });

  it('keeps the column header pinned alongside the rows it labels', () => {
    render(<ComparisonTable competitor={cursor} />);
    const header = screen.getByText('What you get');
    expect(header.className).toContain('sticky');
    expect(header.className).toMatch(/\bbg-cream-secondary\b/);
  });

  it('fixes the column widths so the pinned label cannot crowd out the column it labels', () => {
    const { container } = render(<ComparisonTable competitor={cursor} />);
    const table = container.querySelector('table');
    // Auto layout hands the label a third of the table, which on a phone leaves
    // almost nothing for the column beside it.
    expect(table?.className, 'table does not use fixed layout').toContain('table-fixed');
    // Under fixed layout the FIRST row sets every column width, so the width has
    // to be on the header cell. On the body cell it is silently ignored.
    const header = screen.getByText('What you get');
    expect(header.className, 'label column width is not declared on the header cell').toMatch(
      /\bw-36\b/
    );
    expect(header.className, 'label column does not widen past a phone').toMatch(/\bsm:w-56\b/);
  });
});

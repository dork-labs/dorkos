/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { COMPARISON_DIMENSIONS, type Competitor } from '../../../lib/comparisons';
import { ComparisonAudience } from '../ComparisonAudience';

/** A comparison entry with only the fields this component reads. */
function entry(overrides: Partial<Competitor> & Pick<Competitor, 'framing'>): Competitor {
  return {
    slug: 'example',
    name: 'Example',
    maker: 'Example Inc',
    homepage: 'https://example.com',
    category: 'Example category',
    oneLiner: 'An entry that exists only in this test.',
    pricing: 'Free',
    openSource: true,
    verdict: 'A verdict.',
    theirStrengths: ['you want the thing it is good at'],
    // Score every dimension `no`, so DorkOS's derived column is never empty.
    cells: Object.fromEntries(
      COMPARISON_DIMENSIONS.map((dimension) => [dimension.id, { verdict: 'no', note: 'No.' }])
    ),
    faq: [],
    lastVerified: '2026-08-23',
    sources: ['https://example.com'],
    ...overrides,
  } as Competitor;
}

/**
 * The two recommendation columns, in render order. The section holds exactly
 * one grid, and each column is one of its children.
 */
function renderedColumns(container: HTMLElement): HTMLElement[] {
  const grid = container.querySelector('section > div');
  if (!grid) throw new Error('the recommendation grid did not render');
  return Array.from(grid.children) as HTMLElement[];
}

/** The `class` of every tick icon inside one column. */
function tickClasses(column: HTMLElement): string[] {
  return Array.from(column.querySelectorAll('li svg')).map(
    (icon) => icon.getAttribute('class') ?? ''
  );
}

describe('ComparisonAudience', () => {
  it('recommends the other product on a head-to-head page', () => {
    render(<ComparisonAudience competitor={entry({ framing: 'competitor', name: 'Cursor' })} />);
    expect(screen.getByText('Use Cursor if')).toBeTruthy();
    expect(screen.getByText('you want the thing it is good at')).toBeTruthy();
  });

  it('still credits the other product on a runtime page, under a complimentary heading', () => {
    render(<ComparisonAudience competitor={entry({ framing: 'runtime', name: 'Claude Code' })} />);
    expect(screen.getByText('Reach for Claude Code when')).toBeTruthy();
    expect(screen.getByText('you want the thing it is good at')).toBeTruthy();
  });

  it('heads the DorkOS column on a runtime page with a phrase the reasons finish', () => {
    render(<ComparisonAudience competitor={entry({ framing: 'runtime', name: 'Claude Code' })} />);
    // The column lists bare reasons, so a heading carrying a pronoun ("DorkOS
    // adds it when …") leaves "it" pointing at nothing on the page.
    const heading = screen.getByText('Add DorkOS when');
    expect(heading).toBeTruthy();
    expect(heading.textContent).not.toMatch(/\bit\b/);
    expect(screen.getByText(`you want ${COMPARISON_DIMENSIONS[0].wantPhrase}`)).toBeTruthy();
  });

  it('reads the DorkOS column first in every framing that gets one', () => {
    // This is a DorkOS page, so the answer it exists to give leads. One grid
    // holds both columns and it is one column wide until `md`, so DOM order is
    // reading order on a phone and on a desktop alike.
    const cases = [
      { framing: 'competitor', ours: 'Use DorkOS if', theirs: 'Use Cursor if' },
      { framing: 'runtime', ours: 'Add DorkOS when', theirs: 'Reach for Cursor when' },
      { framing: 'adjacent', ours: 'Use DorkOS if', theirs: 'Use Cursor if' },
    ] as const;
    for (const { framing, ours, theirs } of cases) {
      const { container, unmount } = render(
        <ComparisonAudience competitor={entry({ framing, name: 'Cursor' })} />
      );
      const [first, second] = renderedColumns(container);
      expect(first?.textContent, `${framing} leads with the other product`).toContain(ours);
      expect(second?.textContent, `${framing} does not follow with the other product`).toContain(
        theirs
      );
      unmount();
    }
  });

  it('ticks the DorkOS reasons green and the other product’s in the page accent', () => {
    const { container } = render(
      <ComparisonAudience competitor={entry({ framing: 'competitor', name: 'Cursor' })} />
    );
    const [ourColumn, theirColumn] = renderedColumns(container);
    const ourTicks = tickClasses(ourColumn!);
    const theirTicks = tickClasses(theirColumn!);
    expect(ourTicks.length, 'the DorkOS column rendered no ticks to check').toBeGreaterThan(0);
    expect(theirTicks.length, 'the other column rendered no ticks to check').toBeGreaterThan(0);
    for (const cls of ourTicks) {
      expect(cls, 'a DorkOS tick is not green').toContain('text-brand-green');
      expect(cls, 'a DorkOS tick still carries the other side’s accent').not.toContain(
        'text-brand-orange'
      );
    }
    for (const cls of theirTicks) {
      expect(cls, 'the other product’s tick left the page accent').toContain('text-brand-orange');
      expect(cls, 'the other product’s tick was given the DorkOS green').not.toContain(
        'text-brand-green'
      );
    }
  });

  it('lets each column end at its own height instead of stretching the shorter one', () => {
    render(<ComparisonAudience competitor={entry({ framing: 'competitor', name: 'Cline' })} />);
    const columns = screen.getByText('Use Cline if').closest('div')?.parentElement;
    // DorkOS's column is derived, so on most pages it is honestly shorter than
    // the other product's. Stretching it to match filled the card with dead
    // space, which read as a weak answer rather than a short one.
    expect(columns?.className, 'the recommendation columns stretch to equal height').toContain(
      'items-start'
    );
  });

  it('renders nothing for a product that has shut down', () => {
    const { container } = render(
      <ComparisonAudience competitor={entry({ framing: 'discontinued', theirStrengths: [] })} />
    );
    expect(container.firstChild).toBeNull();
  });

  it('writes DorkOS reasons as "you want …" fragments, never bare table labels', () => {
    render(<ComparisonAudience competitor={entry({ framing: 'competitor' })} />);
    for (const dimension of COMPARISON_DIMENSIONS) {
      // Every label would be ungrammatical after "you want"; the phrase is authored instead.
      expect(screen.queryByText(`you want ${dimension.label.toLowerCase()}`)).toBeNull();
    }
    expect(screen.getByText(`you want ${COMPARISON_DIMENSIONS[0].wantPhrase}`)).toBeTruthy();
  });
});

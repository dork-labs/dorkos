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

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { COMPARISON_DIMENSIONS, type Competitor } from '../../../lib/comparisons';
import { ComparisonSources } from '../ComparisonSources';

/** A comparison entry with only the fields this component reads. */
function entry(overrides: Partial<Competitor> = {}): Competitor {
  return {
    slug: 'example',
    name: 'Example',
    maker: 'Example Inc',
    homepage: 'https://example.com',
    framing: 'competitor',
    category: 'Example category',
    oneLiner: 'An entry that exists only in this test.',
    pricing: 'Free',
    openSource: true,
    verdict: 'A verdict.',
    theirStrengths: ['you want the thing it is good at'],
    cells: Object.fromEntries(
      COMPARISON_DIMENSIONS.map((dimension) => [dimension.id, { verdict: 'no', note: 'No.' }])
    ),
    faq: [],
    lastVerified: '2026-08-24',
    sources: ['https://example.com/docs/configuration/migrations/some-very-long-path'],
    ...overrides,
  } as Competitor;
}

describe('ComparisonSources', () => {
  it('lets a long source label wrap instead of pushing the page sideways', () => {
    render(<ComparisonSources competitor={entry()} />);
    const link = screen.getByRole('link', { name: /example\.com/ });
    const label = link.querySelector('span');
    // A URL has no spaces, so without an anywhere-break it is one unbreakable
    // box and a narrow screen scrolls the whole document to fit it.
    expect(label?.className, 'source label cannot wrap mid-string').toMatch(
      /\b(break-all|wrap-anywhere|break-words)\b/
    );
    // The link has to be allowed to shrink, or the unbreakable box just moves up.
    expect(link.className, 'source link cannot shrink below its content').toContain('max-w-full');
  });

  it('shows when the facts were last checked, in a form a reader can parse', () => {
    render(<ComparisonSources competitor={entry({ lastVerified: '2026-08-24' })} />);
    expect(screen.getByText(/August 24, 2026/)).toBeTruthy();
  });

  it('links every source it was given', () => {
    const sources = ['https://example.com/one', 'https://example.com/two'];
    render(<ComparisonSources competitor={entry({ sources })} />);
    for (const source of sources) {
      const link = screen.getByRole('link', { name: new RegExp(source.replace('https://', '')) });
      expect(link.getAttribute('href')).toBe(source);
      expect(link.getAttribute('rel')).toContain('noopener');
    }
  });
});

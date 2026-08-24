/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { COMPARISON_DIMENSIONS, type Competitor } from '../../../lib/comparisons';
import { ComparisonVerdict } from '../ComparisonVerdict';

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
    openSource: false,
    verdict: 'A verdict.',
    theirStrengths: ['you want the thing it is good at'],
    cells: Object.fromEntries(
      COMPARISON_DIMENSIONS.map((dimension) => [dimension.id, { verdict: 'no', note: 'No.' }])
    ),
    faq: [],
    lastVerified: '2026-08-24',
    sources: ['https://example.com'],
    ...overrides,
  } as Competitor;
}

describe('ComparisonVerdict', () => {
  it('says plainly when the whole product is closed', () => {
    render(<ComparisonVerdict competitor={entry({ openSource: false })} />);
    expect(screen.getByText('Closed, you cannot read it')).toBeTruthy();
  });

  it('says plainly when the whole product is open', () => {
    render(<ComparisonVerdict competitor={entry({ openSource: true })} />);
    expect(screen.getByText('Open, you can read it')).toBeTruthy();
  });

  it('prefers the authored wording where a product is open in part only', () => {
    const note = 'The command-line tool is open. The cloud service, apps and models are not.';
    render(<ComparisonVerdict competitor={entry({ openSource: true, openSourceNote: note })} />);
    expect(screen.getByText(note)).toBeTruthy();
    // The flat claim would tell a reader the cloud service is readable too.
    expect(screen.queryByText('Open, you can read it')).toBeNull();
  });
});

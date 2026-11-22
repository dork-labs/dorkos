/**
 * @vitest-environment jsdom
 */
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { trackMarketplaceBrowse } = vi.hoisted(() => ({ trackMarketplaceBrowse: vi.fn() }));

vi.mock('@/lib/analytics', () => ({ trackMarketplaceBrowse }));

import { MarketplaceBrowseTracker } from '../MarketplaceBrowseTracker';

describe('MarketplaceBrowseTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing and reports the visit with its filters once on mount', () => {
    const { container } = render(
      <MarketplaceBrowseTracker type="agent" category="devops" q="" resultCount={4} />
    );

    expect(container.firstChild).toBeNull();
    expect(trackMarketplaceBrowse).toHaveBeenCalledTimes(1);
    expect(trackMarketplaceBrowse).toHaveBeenCalledWith({
      type: 'agent',
      category: 'devops',
      q: '',
      resultCount: 4,
    });
  });

  it('fires only once per filter set even when effects double-invoke (StrictMode)', () => {
    render(
      <StrictMode>
        <MarketplaceBrowseTracker type="plugin" resultCount={2} />
      </StrictMode>
    );

    expect(trackMarketplaceBrowse).toHaveBeenCalledTimes(1);
  });

  it('fires again when a filter changes on the same page', () => {
    const { rerender } = render(<MarketplaceBrowseTracker type="agent" resultCount={9} />);

    rerender(<MarketplaceBrowseTracker type="agent" q="telegram" resultCount={1} />);

    expect(trackMarketplaceBrowse).toHaveBeenCalledTimes(2);
    expect(trackMarketplaceBrowse).toHaveBeenLastCalledWith({
      type: 'agent',
      category: undefined,
      q: 'telegram',
      resultCount: 1,
    });
  });

  it('does not re-fire on a re-render with unchanged filters', () => {
    const { rerender } = render(<MarketplaceBrowseTracker type="agent" resultCount={9} />);

    rerender(<MarketplaceBrowseTracker type="agent" resultCount={9} />);

    expect(trackMarketplaceBrowse).toHaveBeenCalledTimes(1);
  });
});

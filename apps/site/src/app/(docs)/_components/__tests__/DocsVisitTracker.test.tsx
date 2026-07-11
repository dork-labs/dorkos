/**
 * @vitest-environment jsdom
 */
import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { trackDocsVisit, usePathname } = vi.hoisted(() => ({
  trackDocsVisit: vi.fn(),
  usePathname: vi.fn(),
}));

vi.mock('next/navigation', () => ({ usePathname }));
vi.mock('@/lib/analytics', () => ({ trackDocsVisit }));

import { DocsVisitTracker } from '../DocsVisitTracker';

describe('DocsVisitTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing and reports the current docs path once on mount', () => {
    usePathname.mockReturnValue('/docs/getting-started/quickstart');

    const { container } = render(<DocsVisitTracker />);

    expect(container.firstChild).toBeNull();
    expect(trackDocsVisit).toHaveBeenCalledTimes(1);
    expect(trackDocsVisit).toHaveBeenCalledWith('/docs/getting-started/quickstart');
  });

  it('fires only once per path even when effects double-invoke (StrictMode)', () => {
    usePathname.mockReturnValue('/docs');

    render(
      <StrictMode>
        <DocsVisitTracker />
      </StrictMode>
    );

    expect(trackDocsVisit).toHaveBeenCalledTimes(1);
  });

  it('fires again when the pathname changes on client-side navigation', () => {
    usePathname.mockReturnValue('/docs');
    const { rerender } = render(<DocsVisitTracker />);

    usePathname.mockReturnValue('/docs/concepts/agents');
    rerender(<DocsVisitTracker />);

    expect(trackDocsVisit).toHaveBeenCalledTimes(2);
    expect(trackDocsVisit).toHaveBeenLastCalledWith('/docs/concepts/agents');
  });

  it('does not re-fire on a re-render with an unchanged pathname', () => {
    usePathname.mockReturnValue('/docs');
    const { rerender } = render(<DocsVisitTracker />);

    rerender(<DocsVisitTracker />);

    expect(trackDocsVisit).toHaveBeenCalledTimes(1);
  });
});

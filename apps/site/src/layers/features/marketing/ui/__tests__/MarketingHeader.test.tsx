/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MarketingHeader } from '../MarketingHeader';
import { trackGetStartedNav } from '@/lib/analytics';

vi.mock('@/lib/analytics', () => ({
  trackGithubClick: vi.fn(),
  trackGetStartedNav: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('MarketingHeader CTA', () => {
  it('shows a "Get started" button linking to /install', () => {
    render(<MarketingHeader />);

    const cta = screen.getByRole('link', { name: /get started/i });
    expect(cta.getAttribute('href')).toBe('/install');
  });

  it('reports the CTA click to analytics', () => {
    render(<MarketingHeader />);

    fireEvent.click(screen.getByRole('link', { name: /get started/i }));
    expect(trackGetStartedNav).toHaveBeenCalledTimes(1);
  });
});

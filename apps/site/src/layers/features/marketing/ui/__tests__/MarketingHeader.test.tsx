/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MarketingHeader } from '../MarketingHeader';

vi.mock('@/lib/analytics', () => ({
  trackGithubClick: vi.fn(),
  trackHeroDownload: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function stubNavigator(overrides: { userAgent?: string; platform?: string }): void {
  vi.stubGlobal('navigator', {
    userAgent: overrides.userAgent ?? '',
    platform: overrides.platform ?? '',
    maxTouchPoints: 0,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MarketingHeader — OS-aware CTA', () => {
  it('shows a "Download" button linking to /download/mac on macOS', async () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
    });
    render(<MarketingHeader />);

    await waitFor(() => {
      const cta = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('href') === '/download/mac');
      expect(cta).toBeTruthy();
      expect(cta!.textContent).toContain('Download');
    });
  });

  it('shows a "Download" button linking to /download/windows on Windows', async () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Win32',
    });
    render(<MarketingHeader />);

    await waitFor(() => {
      const cta = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('href') === '/download/windows');
      expect(cta).toBeTruthy();
      expect(cta!.textContent).toContain('Download');
    });
  });

  it('shows a "Get started" button anchored to #install on other platforms (Linux)', () => {
    stubNavigator({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      platform: 'Linux x86_64',
    });
    render(<MarketingHeader />);

    const cta = screen.getAllByRole('link').find((el) => el.getAttribute('href') === '#install');
    expect(cta).toBeTruthy();
    expect(cta!.textContent).toContain('Get started');
    expect(screen.queryByRole('link', { name: /download/i })).toBeNull();
  });
});

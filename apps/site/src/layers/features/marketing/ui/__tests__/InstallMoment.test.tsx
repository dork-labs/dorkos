/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { InstallMoment } from '../InstallMoment';

// Keep analytics hermetic — the real module reaches for posthog + env.
vi.mock('@/lib/analytics', () => ({
  trackHeroInstallCopy: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

/** motion's `useInView` needs IntersectionObserver, which jsdom does not ship. */
class NoopIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): [] {
    return [];
  }
}

function stubNavigator(overrides: { userAgent?: string; platform?: string }): void {
  vi.stubGlobal('navigator', {
    userAgent: overrides.userAgent ?? '',
    platform: overrides.platform ?? '',
    maxTouchPoints: 0,
  });
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InstallMoment — OS-aware download affordance', () => {
  it('keeps the terminal (curl) install as the recommended primary path', () => {
    stubNavigator({ userAgent: 'Windows NT 10.0', platform: 'Win32' });
    render(<InstallMoment />);
    expect(screen.getByText('recommended')).toBeTruthy();
    // The one-liner tab is present alongside npm.
    expect(screen.getByText('One-liner')).toBeTruthy();
    expect(screen.getByText('npm')).toBeTruthy();
  });

  it('shows a prominent "Download for Mac" card with the Apple Silicon qualifier on macOS', async () => {
    stubNavigator({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15',
      platform: 'MacIntel',
    });
    render(<InstallMoment />);

    const link = await waitFor(() => {
      const found = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('href') === '/download/mac');
      expect(found).toBeTruthy();
      return found!;
    });

    expect(link.textContent).toContain('Download for Mac');
    expect(link.textContent).toContain('Apple Silicon');
    // Honest Intel fallback line.
    expect(screen.getByText(/Intel Mac/i)).toBeTruthy();
  });

  it('shows only a low-emphasis macOS link (no card) for non-Mac visitors', async () => {
    stubNavigator({ userAgent: 'Windows NT 10.0', platform: 'Win32' });
    render(<InstallMoment />);

    const link = await waitFor(() => {
      const found = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('href') === '/download/mac');
      expect(found).toBeTruthy();
      return found!;
    });

    expect(link.textContent).toContain('Desktop app for macOS');
    expect(link.textContent).not.toContain('Download for Mac');
    // The prominent card's Intel helper line must not render off-Mac.
    expect(screen.queryByText(/Intel Mac/i)).toBeNull();
  });
});

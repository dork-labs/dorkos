/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InstallMoment } from '../InstallMoment';

// Keep analytics hermetic — the real module reaches for posthog + env.
vi.mock('@/lib/analytics', () => ({
  trackHeroInstallCopy: vi.fn(),
  trackHeroDownload: vi.fn(),
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

/** Stub navigator and return the clipboard `writeText` mock for copy assertions. */
function stubNavigator(overrides: { userAgent?: string; platform?: string }): {
  writeText: Mock;
} {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', {
    userAgent: overrides.userAgent ?? '',
    platform: overrides.platform ?? '',
    maxTouchPoints: 0,
    clipboard: { writeText },
  });
  return { writeText };
}

const CURL_COMMAND = 'curl -fsSL https://dorkos.ai/install | bash';
const NPM_COMMAND = 'npm install -g dorkos';

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', NoopIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('InstallMoment — OS-adaptive install hero', () => {
  describe('macOS visitor', () => {
    let writeText: Mock;

    beforeEach(() => {
      ({ writeText } = stubNavigator({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.0 Safari/605.1.15',
        platform: 'MacIntel',
      }));
    });

    it('leads with a prominent "Download for Mac" button pointing at /download/mac', async () => {
      render(<InstallMoment />);

      const link = await waitFor(() => {
        const found = screen
          .getAllByRole('link')
          .find((el) => el.getAttribute('href') === '/download/mac');
        expect(found).toBeTruthy();
        return found!;
      });

      expect(link.textContent).toContain('Download for Mac');
      expect(screen.getByText(/Apple Silicon/i)).toBeTruthy();
      // Honest Intel fallback line lives next to the terminal peer.
      expect(screen.getByText(/Intel Mac/i)).toBeTruthy();
    });

    it('keeps the terminal one-liner a respected, still-copyable peer', async () => {
      render(<InstallMoment />);

      await waitFor(() => expect(screen.getByText(/Prefer the terminal/i)).toBeTruthy());
      // The real one-liner is present verbatim...
      expect(
        screen.getByText(new RegExp(CURL_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      ).toBeTruthy();
      // ...and there is a copy affordance for it.
      const copyButton = screen
        .getAllByRole('button')
        .find((el) => el.getAttribute('aria-label')?.includes(CURL_COMMAND));
      expect(copyButton).toBeTruthy();
    });

    it('offers an "Other ways to install" disclosure', async () => {
      render(<InstallMoment />);
      await waitFor(() => expect(screen.getByText('Other ways to install')).toBeTruthy());
    });

    it('copies the real curl one-liner (never the scrambled display text) when the peer copy is clicked', async () => {
      render(<InstallMoment />);

      const copyButton = await waitFor(() => {
        const found = screen
          .getAllByRole('button')
          .find((el) => el.getAttribute('aria-label')?.includes(CURL_COMMAND));
        expect(found).toBeTruthy();
        return found!;
      });

      fireEvent.click(copyButton);
      expect(writeText).toHaveBeenCalledWith(CURL_COMMAND);
    });

    it('copies the exact npm command from the expanded disclosure', async () => {
      render(<InstallMoment />);

      // Native <details> keeps its children mounted even while collapsed.
      const npmCopyButton = await waitFor(() => {
        const found = screen
          .getAllByRole('button')
          .find((el) => el.getAttribute('aria-label')?.includes(NPM_COMMAND));
        expect(found).toBeTruthy();
        return found!;
      });

      fireEvent.click(npmCopyButton);
      expect(writeText).toHaveBeenCalledWith(NPM_COMMAND);
    });
  });

  describe('Windows visitor', () => {
    let writeText: Mock;

    beforeEach(() => {
      ({ writeText } = stubNavigator({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'Win32',
      }));
    });

    it('leads with a prominent "Download for Windows" button pointing at /download/windows', async () => {
      render(<InstallMoment />);

      const link = await waitFor(() => {
        const found = screen
          .getAllByRole('link')
          .find((el) => el.getAttribute('href') === '/download/windows');
        expect(found).toBeTruthy();
        return found!;
      });

      expect(link.textContent).toContain('Download for Windows');
    });

    it('marks the Windows build as an early alpha (honest, not hypey)', async () => {
      render(<InstallMoment />);

      // The hero button carries a visible "alpha" tag...
      const link = await waitFor(() => {
        const found = screen
          .getAllByRole('link')
          .find((el) => el.getAttribute('href') === '/download/windows');
        expect(found).toBeTruthy();
        return found!;
      });
      expect(link.textContent).toContain('alpha');
      // ...and the subtitle sets honest expectations (unsigned, SmartScreen).
      expect(screen.getByText(/unsigned early alpha/i)).toBeTruthy();
    });

    it('keeps the terminal one-liner a respected, still-copyable peer', async () => {
      render(<InstallMoment />);

      const copyButton = await waitFor(() => {
        const found = screen
          .getAllByRole('button')
          .find((el) => el.getAttribute('aria-label')?.includes(CURL_COMMAND));
        expect(found).toBeTruthy();
        return found!;
      });

      fireEvent.click(copyButton);
      expect(writeText).toHaveBeenCalledWith(CURL_COMMAND);
    });

    it('never promotes the Mac download to hero for a Windows visitor', async () => {
      render(<InstallMoment />);
      await waitFor(() => expect(screen.getByText('Download for Windows')).toBeTruthy());

      expect(screen.queryByText('Download for Mac')).toBeNull();
    });
  });

  describe('non-Mac, non-Windows visitor', () => {
    beforeEach(() => {
      stubNavigator({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        platform: 'Linux x86_64',
      });
    });

    it('leads with the tabbed terminal install (one-liner recommended, npm alongside)', () => {
      render(<InstallMoment />);
      expect(screen.getByText('recommended')).toBeTruthy();
      expect(screen.getByText('One-liner')).toBeTruthy();
      expect(screen.getByText('npm')).toBeTruthy();
    });

    it('keeps a subtle "Desktop app for macOS" link and never promotes a download to hero', () => {
      render(<InstallMoment />);

      const link = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('href') === '/download/mac');
      expect(link).toBeTruthy();
      expect(link!.textContent).toContain('Desktop app for macOS');

      // The Mac download button and its Intel helper never render off-Mac.
      expect(screen.queryByText('Download for Mac')).toBeNull();
      expect(screen.queryByText('Download for Windows')).toBeNull();
      expect(screen.queryByText(/Intel Mac/i)).toBeNull();
    });

    it('offers the Windows alpha as a real link inside "Other ways to install"', () => {
      render(<InstallMoment />);

      // Native <details> keeps its children mounted even while collapsed.
      const winLink = screen
        .getAllByRole('link')
        .find((el) => el.getAttribute('href') === '/download/windows');
      expect(winLink).toBeTruthy();
      expect(winLink!.textContent).toContain('alpha');
    });
  });
});

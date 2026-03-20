// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { VersionItem } from '../ui/VersionItem';

// Mock Radix popover portal to render inline in jsdom
vi.mock('radix-ui', async () => {
  const actual = await vi.importActual<typeof import('radix-ui')>('radix-ui');
  return {
    ...actual,
    Popover: {
      ...actual.Popover,
      Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VersionItem', () => {
  describe('no update available', () => {
    it('renders current version with v prefix', () => {
      render(<VersionItem version="1.2.3" latestVersion={null} />);
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    });

    it('renders muted text with cursor-default', () => {
      render(<VersionItem version="1.2.3" latestVersion={null} />);
      const el = screen.getByText('v1.2.3');
      expect(el.className).toContain('text-muted-foreground');
      expect(el.className).toContain('cursor-default');
    });

    it('has correct aria-label', () => {
      render(<VersionItem version="1.2.3" latestVersion={null} />);
      expect(screen.getByLabelText('Version 1.2.3')).toBeInTheDocument();
    });

    it('does not render amber dot', () => {
      render(<VersionItem version="1.2.3" latestVersion={null} />);
      expect(screen.queryByText('available')).not.toBeInTheDocument();
    });
  });

  describe('patch update available', () => {
    it('renders "v{latest} available" text', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      expect(screen.getByText('v1.2.4 available')).toBeInTheDocument();
    });

    it('uses muted text (not amber)', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      const button = screen.getByRole('button');
      expect(button.className).toContain('text-muted-foreground');
      expect(button.className).not.toContain('text-amber-600');
    });

    it('has patch aria-label', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      expect(screen.getByLabelText('Patch update available: v1.2.4')).toBeInTheDocument();
    });

    it('opens popover on click with version transition', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Update Available')).toBeInTheDocument();
      // Version transition text contains both versions separated by arrow
      const versionDiv = screen.getByText((_, el) => el?.textContent === 'v1.2.3→v1.2.4');
      expect(versionDiv).toBeInTheDocument();
    });

    it('shows copy command in popover', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('npm update -g dorkos')).toBeInTheDocument();
    });

    it('does not show "What\'s new" link for patches', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByText("What's new")).not.toBeInTheDocument();
    });
  });

  describe('feature update available', () => {
    it('renders "Upgrade available" text', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" />);
      expect(screen.getByText('Upgrade available')).toBeInTheDocument();
    });

    it('uses amber text color', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" />);
      const button = screen.getByRole('button');
      expect(button.className).toContain('text-amber-600');
    });

    it('has feature aria-label', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" />);
      expect(screen.getByLabelText('Feature update available: v1.3.0')).toBeInTheDocument();
    });

    it('opens popover with version transition and "What\'s new" link', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Update Available')).toBeInTheDocument();
      const link = screen.getByText("What's new");
      expect(link).toBeInTheDocument();
      expect(link.closest('a')).toHaveAttribute(
        'href',
        'https://github.com/dork-labs/dorkos/releases/tag/v1.3.0'
      );
    });

    it('shows "What\'s new" link for major bumps too', () => {
      render(<VersionItem version="1.9.9" latestVersion="2.0.0" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText("What's new")).toBeInTheDocument();
    });
  });

  describe('copy to clipboard', () => {
    beforeEach(() => {
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      });
    });

    it('copies update command on click', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" />);
      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByLabelText('Copy update command'));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('npm update -g dorkos');
    });
  });

  describe('equal or older versions show no update', () => {
    it('equal versions', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.3" />);
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();
      expect(screen.queryByText('available')).not.toBeInTheDocument();
    });

    it('older latest version', () => {
      render(<VersionItem version="2.0.0" latestVersion="1.9.9" />);
      expect(screen.getByText('v2.0.0')).toBeInTheDocument();
      expect(screen.queryByText('available')).not.toBeInTheDocument();
    });
  });

  describe('dev mode', () => {
    it('renders DEV badge when isDevMode is true', () => {
      render(<VersionItem version="0.0.0" latestVersion={null} isDevMode />);
      expect(screen.getByText('DEV')).toBeInTheDocument();
    });

    it('does not show version number in dev mode', () => {
      render(<VersionItem version="0.0.0" latestVersion={null} isDevMode />);
      expect(screen.queryByText('v0.0.0')).not.toBeInTheDocument();
    });

    it('does not show upgrade indicator in dev mode even with latestVersion', () => {
      render(<VersionItem version="0.0.0" latestVersion="1.0.0" isDevMode />);
      expect(screen.queryByText('available')).not.toBeInTheDocument();
      expect(screen.queryByText('Upgrade available')).not.toBeInTheDocument();
      expect(screen.getByText('DEV')).toBeInTheDocument();
    });

    it('has correct aria-label for dev badge', () => {
      render(<VersionItem version="0.0.0" latestVersion={null} isDevMode />);
      expect(screen.getByLabelText('Development build')).toBeInTheDocument();
    });

    it('renders amber-styled badge', () => {
      render(<VersionItem version="0.0.0" latestVersion={null} isDevMode />);
      const badge = screen.getByText('DEV');
      expect(badge.className).toContain('bg-amber-500/15');
      expect(badge.className).toContain('text-amber-600');
    });
  });

  describe('dismiss', () => {
    it('renders dismiss button in upgrade popover', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Dismiss this version')).toBeInTheDocument();
    });

    it('calls onDismiss with latest version when dismiss clicked', () => {
      const onDismiss = vi.fn();
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" onDismiss={onDismiss} />);
      fireEvent.click(screen.getByRole('button'));
      fireEvent.click(screen.getByText('Dismiss this version'));
      expect(onDismiss).toHaveBeenCalledWith('1.3.0');
    });

    it('shows plain version when isDismissed is true', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.3.0" isDismissed />);
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();
      expect(screen.queryByText('Upgrade available')).not.toBeInTheDocument();
    });

    it('does not show upgrade indicator when dismissed', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" isDismissed />);
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();
      expect(screen.queryByText('available')).not.toBeInTheDocument();
    });

    it('renders dismiss button for patch updates too', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Dismiss this version')).toBeInTheDocument();
    });
  });

  describe('isFeatureUpdate classification', () => {
    it('major bump is feature update', () => {
      render(<VersionItem version="1.0.0" latestVersion="2.0.0" />);
      expect(screen.getByText('Upgrade available')).toBeInTheDocument();
    });

    it('minor bump is feature update', () => {
      render(<VersionItem version="1.2.0" latestVersion="1.3.0" />);
      expect(screen.getByText('Upgrade available')).toBeInTheDocument();
    });

    it('patch-only bump is not feature update', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.4" />);
      expect(screen.getByText('v1.2.4 available')).toBeInTheDocument();
      expect(screen.queryByText('Upgrade available')).not.toBeInTheDocument();
    });

    it('same version shows no update', () => {
      render(<VersionItem version="1.2.3" latestVersion="1.2.3" />);
      expect(screen.getByText('v1.2.3')).toBeInTheDocument();
    });

    it('older version shows no update', () => {
      render(<VersionItem version="1.5.0" latestVersion="1.4.99" />);
      expect(screen.getByText('v1.5.0')).toBeInTheDocument();
    });
  });
});

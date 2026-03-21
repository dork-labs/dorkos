/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureCard } from '../FeatureCard';
import type { Feature } from '../../lib/features';

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const gaFeature: Feature = {
  slug: 'pulse-scheduler',
  name: 'Pulse Scheduler',
  product: 'pulse',
  category: 'scheduling',
  tagline: "Schedule agents to run on any cron — they work while you don't",
  description:
    'Stop manually triggering agent runs. Pulse lets you schedule any agent on any cron expression, with a visual builder, preset gallery, and full run history.',
  status: 'ga',
  benefits: [
    'Visual cron builder with natural-language preview',
    'Preset gallery for common patterns',
    'Run history with status, duration, and output',
  ],
};

const betaFeature: Feature = {
  slug: 'slack-adapter',
  name: 'Slack Adapter',
  product: 'relay',
  category: 'integration',
  tagline: 'Chat with your agents in Slack — no context switching required',
  description:
    'The Slack adapter connects DorkOS Relay to your Slack workspace. Send messages, receive agent updates, and approve tool calls without leaving Slack.',
  status: 'beta',
  benefits: [
    'Send messages to agents from any Slack channel',
    'Receive streaming agent responses in Slack',
    'Tool approval and question prompts via Slack buttons',
  ],
};

const comingSoonFeature: Feature = {
  slug: 'future-feature',
  name: 'Future Feature',
  product: 'core',
  category: 'infrastructure',
  tagline: 'Something great is coming',
  description:
    'A future feature that will be available soon. This is a placeholder for testing the coming-soon status badge rendering and display behavior.',
  status: 'coming-soon',
  benefits: [
    'First benefit of the future feature',
    'Second benefit of the future feature',
    'Third benefit of the future feature',
  ],
};

describe('FeatureCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('link and routing', () => {
    it('renders a link to /features/[slug]', () => {
      render(<FeatureCard feature={gaFeature} />);
      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toBe('/features/pulse-scheduler');
    });

    it('uses the feature slug in the href', () => {
      render(<FeatureCard feature={betaFeature} />);
      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toBe('/features/slack-adapter');
    });
  });

  describe('feature name and tagline', () => {
    it('renders the feature name', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText('Pulse Scheduler')).toBeTruthy();
    });

    it('renders the feature tagline', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(
        screen.getByText("Schedule agents to run on any cron — they work while you don't")
      ).toBeTruthy();
    });
  });

  describe('product badge', () => {
    it('renders the product label for pulse', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText('Pulse')).toBeTruthy();
    });

    it('renders the product label for relay', () => {
      render(<FeatureCard feature={betaFeature} />);
      expect(screen.getByText('Relay')).toBeTruthy();
    });

    it('renders the product label for core', () => {
      render(<FeatureCard feature={comingSoonFeature} />);
      expect(screen.getByText('Core')).toBeTruthy();
    });
  });

  describe('category badge', () => {
    it('renders the category label for scheduling', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText('Scheduling')).toBeTruthy();
    });

    it('renders the category label for integration', () => {
      render(<FeatureCard feature={betaFeature} />);
      expect(screen.getByText('Integration')).toBeTruthy();
    });

    it('renders the category label for infrastructure', () => {
      render(<FeatureCard feature={comingSoonFeature} />);
      expect(screen.getByText('Infrastructure')).toBeTruthy();
    });
  });

  describe('status badge', () => {
    it('renders "Available" for ga status', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText('Available')).toBeTruthy();
    });

    it('renders "Beta" for beta status', () => {
      render(<FeatureCard feature={betaFeature} />);
      expect(screen.getByText('Beta')).toBeTruthy();
    });

    it('renders "Coming Soon" for coming-soon status', () => {
      render(<FeatureCard feature={comingSoonFeature} />);
      expect(screen.getByText('Coming Soon')).toBeTruthy();
    });
  });

  describe('"Learn more" affordance', () => {
    it('renders the learn more text', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText(/learn more/i)).toBeTruthy();
    });
  });
});

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

// A media fixture renders ProductFrame → next/image; stub it to a plain <img>
// so the media-card assertions stay hermetic in jsdom.
vi.mock('next/image', () => ({
  // eslint-disable-next-line @next/next/no-img-element -- test stub, not production markup
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

const gaFeature: Feature = {
  slug: 'task-scheduler',
  name: 'Tasks Scheduler',
  product: 'tasks',
  category: 'scheduling',
  tagline: "Schedule agents to run on any cron — they work while you don't",
  description:
    'Stop manually triggering agent runs. Tasks lets you schedule any agent on any cron expression, with a visual builder, preset gallery, and full run history.',
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

const manyBenefitsFeature: Feature = {
  slug: 'many-benefits',
  name: 'Many Benefits',
  product: 'runtimes',
  category: 'agent-control',
  tagline: 'A text-only card with more benefits than the preview shows',
  description:
    'A text-only fixture used to verify the benefit preview caps its bullet list, rendering only the first few concrete benefits on the compact card.',
  status: 'ga',
  benefits: [
    'Bullet alpha appears in the preview',
    'Bullet bravo appears in the preview',
    'Bullet charlie appears in the preview',
    'Bullet delta is capped out of the preview',
    'Bullet echo is capped out of the preview',
  ],
};

const mediaFeature: Feature = {
  slug: 'media-feature',
  name: 'Media Feature',
  product: 'console',
  category: 'chat',
  tagline: 'A card with a real capture shows the screenshot instead of bullets',
  description:
    'A media fixture used to verify that a card carrying product media renders its capture and suppresses the text-only benefit preview entirely.',
  status: 'ga',
  benefits: [
    'Media benefit that must never render as a bullet',
    'Second media benefit that must never render as a bullet',
    'Third media benefit that must never render as a bullet',
  ],
  media: {
    surface: 'subagents',
    alt: 'A chat session with sub-agents running in parallel',
  },
};

describe('FeatureCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('link and routing', () => {
    it('renders a link to /features/[slug]', () => {
      render(<FeatureCard feature={gaFeature} />);
      const link = screen.getByRole('link');
      expect(link.getAttribute('href')).toBe('/features/task-scheduler');
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
      expect(screen.getByText('Tasks Scheduler')).toBeTruthy();
    });

    it('renders the feature tagline', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(
        screen.getByText("Schedule agents to run on any cron — they work while you don't")
      ).toBeTruthy();
    });
  });

  describe('product badge', () => {
    it('renders the product label for tasks', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText('Tasks')).toBeTruthy();
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

  describe('benefit preview', () => {
    it('previews the benefits on a text-only card', () => {
      render(<FeatureCard feature={gaFeature} />);
      expect(screen.getByText('Visual cron builder with natural-language preview')).toBeTruthy();
      expect(screen.getByText('Run history with status, duration, and output')).toBeTruthy();
    });

    it('caps the benefit preview at three bullets', () => {
      render(<FeatureCard feature={manyBenefitsFeature} />);
      expect(screen.getByText('Bullet alpha appears in the preview')).toBeTruthy();
      expect(screen.getByText('Bullet charlie appears in the preview')).toBeTruthy();
      expect(screen.queryByText('Bullet delta is capped out of the preview')).toBeNull();
      expect(screen.queryByText('Bullet echo is capped out of the preview')).toBeNull();
    });

    it('suppresses the benefit preview when the card has media', () => {
      render(<FeatureCard feature={mediaFeature} />);
      expect(screen.queryByText('Media benefit that must never render as a bullet')).toBeNull();
      // The capture renders in place of the bullets.
      expect(
        screen.getByAltText('A chat session with sub-agents running in parallel')
      ).toBeTruthy();
    });
  });
});

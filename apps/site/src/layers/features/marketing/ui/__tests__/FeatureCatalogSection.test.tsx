/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeatureCatalogSection } from '../FeatureCatalogSection';

// Mock next/link to a plain anchor so href assertions work in jsdom
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

// Mock lucide-react icons to avoid SVG rendering issues
vi.mock('lucide-react', () => ({
  ArrowRight: () => <svg data-testid="arrow-right" />,
}));

// Mock the features module so tests are isolated from real catalog data.
// Data is defined inline because vi.mock factories are hoisted before const declarations.
vi.mock('../../lib/features', () => ({
  features: [
    {
      slug: 'test-feature',
      name: 'Test Feature',
      category: 'core',
      tagline: 'A test tagline under 80 chars',
      description:
        'A test description that is between 120 and 160 characters long to satisfy the catalog data integrity rules.',
      status: 'ga',
      featured: true,
      benefits: ['Benefit one', 'Benefit two', 'Benefit three'],
    },
    {
      slug: 'hidden-feature',
      name: 'Hidden Feature',
      category: 'pulse',
      tagline: 'This should not appear on the homepage',
      description:
        'A test description that is between 120 and 160 characters long to satisfy the catalog data integrity rules.',
      status: 'beta',
      featured: false,
      benefits: ['Benefit one', 'Benefit two', 'Benefit three'],
    },
  ],
  CATEGORY_LABELS: {
    console: 'Console',
    pulse: 'Pulse',
    relay: 'Relay',
    mesh: 'Mesh',
    core: 'Core',
  },
}));

describe('FeatureCatalogSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the section heading', () => {
    render(<FeatureCatalogSection />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toBe('Built for how you actually work');
  });

  it('renders the section subtitle', () => {
    render(<FeatureCatalogSection />);
    expect(screen.getByText('Every subsystem designed to get out of the way.')).toBeTruthy();
  });

  it('renders only featured features', () => {
    render(<FeatureCatalogSection />);
    expect(screen.getByText('Test Feature')).toBeTruthy();
    expect(screen.queryByText('Hidden Feature')).toBeNull();
  });

  it('renders a card for each featured feature with its tagline', () => {
    render(<FeatureCatalogSection />);
    expect(screen.getByText('A test tagline under 80 chars')).toBeTruthy();
  });

  it('renders desktop "All features" link pointing to /features', () => {
    render(<FeatureCatalogSection />);
    // The desktop link text is "All features" (with arrow icon as separate element)
    const links = screen.getAllByRole('link');
    const featuresLinks = links.filter((l) => l.getAttribute('href') === '/features');
    expect(featuresLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('renders mobile "View all features" link pointing to /features', () => {
    render(<FeatureCatalogSection />);
    const links = screen.getAllByRole('link');
    const mobileLink = links.find((l) =>
      l.textContent?.includes('View all features') && l.getAttribute('href') === '/features'
    );
    expect(mobileLink).toBeTruthy();
  });

  it('renders feature cards that link to /features/[slug]', () => {
    render(<FeatureCatalogSection />);
    const links = screen.getAllByRole('link');
    const cardLink = links.find((l) => l.getAttribute('href') === '/features/test-feature');
    expect(cardLink).toBeTruthy();
  });

  it('renders the correct number of feature cards for featured items only', () => {
    render(<FeatureCatalogSection />);
    // Only the 1 featured feature card link + 2 "All features" / "View all features" links = 3 total links
    const links = screen.getAllByRole('link');
    // 1 card link (/features/test-feature) + 2 nav links (/features)
    expect(links).toHaveLength(3);
  });
});

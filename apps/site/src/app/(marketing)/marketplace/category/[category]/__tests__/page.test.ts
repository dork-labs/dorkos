/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// notFound() is mocked to throw a recognizable sentinel so tests can assert the
// 404 path without a real Next.js request context.
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

// Stub only the network fetchers; keep rankPackages and the UI real.
vi.mock('@/layers/features/marketplace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/features/marketplace')>();
  return {
    ...actual,
    fetchMarketplaceJson: vi.fn(),
    fetchInstallCounts: vi.fn(),
  };
});

import { fetchMarketplaceJson, fetchInstallCounts } from '@/layers/features/marketplace';
import MarketplaceCategoryPage, { generateMetadata, generateStaticParams } from '../page';

type FetchResult = Awaited<ReturnType<typeof fetchMarketplaceJson>>;

/** Build a registry fetch result carrying only the fields the page reads. */
function registry(plugins: Array<Record<string, unknown>>): FetchResult {
  return {
    marketplace: { name: 'test', owner: { name: 'test' }, plugins },
    sidecar: null,
    plugins,
    orphans: [],
  } as unknown as FetchResult;
}

beforeEach(() => {
  vi.mocked(fetchMarketplaceJson).mockResolvedValue(registry([]));
  vi.mocked(fetchInstallCounts).mockResolvedValue({});
});

describe('generateStaticParams', () => {
  it('returns one entry per controlled category (16 static pages)', () => {
    const params = generateStaticParams();
    expect(params).toHaveLength(16);
    expect(params).toContainEqual({ category: 'security' });
    expect(params).toContainEqual({ category: 'code-review' });
  });
});

describe('generateMetadata', () => {
  it('builds the title and canonical for a valid category', async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ category: 'security' }),
    });
    expect(metadata.title).toBe('Security — DorkOS Marketplace');
    expect(metadata.alternates?.canonical).toBe('/marketplace/category/security');
    expect(metadata.openGraph?.url).toBe('/marketplace/category/security');
  });

  it('caps the appended package names at 5 so the description is never engine-truncated', async () => {
    // Seven in-category packages — only the first five names may appear.
    vi.mocked(fetchMarketplaceJson).mockResolvedValue(
      registry(
        ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'].map((name) => ({
          name,
          source: `./${name}`,
          category: 'security',
        }))
      )
    );
    const metadata = await generateMetadata({
      params: Promise.resolve({ category: 'security' }),
    });
    expect(metadata.description).toContain('n5');
    expect(metadata.description).not.toContain('n6');
  });

  it('404s an unknown slug', async () => {
    await expect(
      generateMetadata({ params: Promise.resolve({ category: 'not-a-category' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});

describe('MarketplaceCategoryPage', () => {
  it('404s an unknown slug before fetching', async () => {
    await expect(
      MarketplaceCategoryPage({ params: Promise.resolve({ category: 'not-a-category' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('renders only the in-category packages for a valid category', async () => {
    // Membership filter: the security member renders; the documentation one is excluded.
    vi.mocked(fetchMarketplaceJson).mockResolvedValue(
      registry([
        { name: 'security-auditor', source: './security-auditor', category: 'security' },
        { name: 'docs-keeper', source: './docs-keeper', category: 'documentation' },
      ])
    );

    const ui = await MarketplaceCategoryPage({
      params: Promise.resolve({ category: 'security' }),
    });
    render(ui);

    expect(screen.getByText('security-auditor')).toBeTruthy();
    expect(screen.queryByText('docs-keeper')).toBeNull();
  });

  it('still renders (empty state, not a 500) when the registry fetch rejects', async () => {
    // The catch → [] degradation branch: a registry outage must yield a valid page.
    vi.mocked(fetchMarketplaceJson).mockRejectedValue(new Error('registry down'));

    const ui = await MarketplaceCategoryPage({
      params: Promise.resolve({ category: 'security' }),
    });
    render(ui);

    expect(screen.getByText('No Security packages yet')).toBeTruthy();
  });
});

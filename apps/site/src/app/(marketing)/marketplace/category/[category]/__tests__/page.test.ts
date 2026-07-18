import { describe, it, expect, vi } from 'vitest';

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
    fetchMarketplaceJson: vi.fn(async () => ({
      marketplace: { name: 'test', owner: { name: 'test' }, plugins: [] },
      sidecar: null,
      plugins: [],
      orphans: [],
    })),
    fetchInstallCounts: vi.fn(async () => ({})),
  };
});

import MarketplaceCategoryPage, { generateMetadata, generateStaticParams } from '../page';

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
});

import type { Metadata } from 'next';
import Link from 'next/link';
import type { MarketplaceJson } from '@dorkos/marketplace';
import { siteConfig } from '@/config/site';
import {
  fetchMarketplaceJson,
  fetchInstallCounts,
  rankPackages,
  MarketplaceHeader,
  FeaturedAgentsRail,
  MarketplaceGrid,
} from '@/layers/features/marketplace';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Marketplace — DorkOS',
  description:
    'Pre-built agents, plugins, and skill packs from the DorkOS community. Install with one command.',
  alternates: { canonical: '/marketplace' },
  openGraph: {
    title: 'Marketplace — DorkOS',
    description: 'Pre-built agents, plugins, and skill packs from the DorkOS community.',
    url: '/marketplace',
    siteName: siteConfig.name,
  },
};

/**
 * Marketplace browse page — server-rendered with hourly ISR.
 *
 * Fetches the dorkos-community registry and install counts, applies query-string
 * filters, and renders the featured rail plus the full grid. Telemetry failures
 * degrade gracefully to an empty install-count map. Registry failures degrade to
 * a "launching soon" empty state — the dorkos-community repo may not exist yet
 * (it's bootstrapped as a separate deploy step), so the page must keep rendering.
 */
export default async function MarketplacePage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const type = typeof searchParams.type === 'string' ? searchParams.type : undefined;
  const category = typeof searchParams.category === 'string' ? searchParams.category : undefined;
  const q = typeof searchParams.q === 'string' ? searchParams.q : undefined;

  const [marketplaceResult, installCounts] = await Promise.all([
    fetchMarketplaceJson()
      .then((m) => ({ ok: true as const, marketplace: m }))
      .catch(() => ({ ok: false as const, marketplace: null as MarketplaceJson | null })),
    fetchInstallCounts().catch(() => ({})),
  ]);

  if (!marketplaceResult.ok || !marketplaceResult.marketplace) {
    return (
      <main className="mx-auto max-w-6xl px-6 pt-32 pb-24">
        <MarketplaceHeader />
        <section className="border-warm-gray-light/30 bg-cream-secondary/50 mt-12 rounded-lg border p-12 text-center">
          <h2 className="text-charcoal font-mono text-2xl font-semibold">Launching soon</h2>
          <p className="text-warm-gray mx-auto mt-4 max-w-xl text-base leading-relaxed">
            The DorkOS community marketplace is being bootstrapped. Once the registry is live,
            you&apos;ll be able to browse pre-built agents, plugins, and skill packs from the
            community here.
          </p>
          <p className="text-warm-gray-light mt-6 text-sm">
            In the meantime, browse the{' '}
            <Link href="/features" className="text-charcoal underline">
              feature catalog
            </Link>{' '}
            or read about how install telemetry works on the{' '}
            <Link href="/marketplace/privacy" className="text-charcoal underline">
              privacy page
            </Link>
            .
          </p>
        </section>
      </main>
    );
  }

  const marketplace = marketplaceResult.marketplace;
  const ranked = rankPackages(marketplace.plugins, installCounts, { type, category, q });
  const featured = ranked.filter((p) => p.featured && p.type === 'agent');

  return (
    <main className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <MarketplaceHeader />
      <FeaturedAgentsRail packages={featured} installCounts={installCounts} />
      <MarketplaceGrid
        packages={ranked}
        installCounts={installCounts}
        initialFilters={{ type, category, q }}
      />
    </main>
  );
}

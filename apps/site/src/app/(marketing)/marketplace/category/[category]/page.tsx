import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import {
  MARKETPLACE_CATEGORIES,
  CATEGORY_LABELS,
  CATEGORY_DESCRIPTIONS,
  asMarketplaceCategory,
  type MarketplaceCategory,
} from '@dorkos/marketplace';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import {
  fetchMarketplaceJson,
  fetchInstallCounts,
  rankPackages,
  PackageCard,
  type RankedPackage,
} from '@/layers/features/marketplace';

export const revalidate = 3600;

/**
 * One static page per controlled category. Prerendering the full closed
 * vocabulary (16 slugs) satisfies the Shapes program's "≥6 category SEO
 * routes" criterion and keeps every category crawlable even before the
 * registry backfill assigns packages to it.
 */
export function generateStaticParams() {
  return MARKETPLACE_CATEGORIES.map((category) => ({ category }));
}

/**
 * Fetch and rank the packages that belong to `category`.
 *
 * Registry-down degradation: a fetch failure returns an empty list rather
 * than throwing, so the category page stays a valid (empty) SEO surface
 * instead of returning a 500 — mirrors the `/marketplace` browse page.
 */
async function fetchCategoryPackages(
  category: MarketplaceCategory,
  installCounts: Record<string, number>
): Promise<RankedPackage[]> {
  try {
    const marketplace = await fetchMarketplaceJson();
    return rankPackages(marketplace.plugins, installCounts, { category });
  } catch {
    return [];
  }
}

export async function generateMetadata(props: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const { category: slug } = await props.params;
  const category = asMarketplaceCategory(slug);
  if (!category) notFound();

  const label = CATEGORY_LABELS[category];
  const title = `${label} — DorkOS Marketplace`;
  // Seed the meta description with the honest category blurb, then append the
  // real package names so the snippet reflects what the page actually lists.
  // Capped at 5 names so a busy post-backfill category never produces an
  // engine-truncated description.
  const names = (await fetchCategoryPackages(category, {})).map((p) => p.name).slice(0, 5);
  const description =
    names.length > 0
      ? `${CATEGORY_DESCRIPTIONS[category]} Includes ${names.join(', ')}.`
      : CATEGORY_DESCRIPTIONS[category];

  return {
    title,
    description,
    alternates: {
      canonical: `/marketplace/category/${category}`,
      types: rssFeedAlternateTypes,
    },
    openGraph: {
      title,
      description,
      url: `/marketplace/category/${category}`,
      siteName: siteConfig.name,
      type: 'website',
    },
    twitter: twitterFromOpenGraph({ title, description }),
  };
}

/**
 * Marketplace category landing page — statically generated, hourly ISR.
 *
 * Lists every package that belongs to one controlled category (via the
 * membership filter in `rankPackages`), with BreadcrumbList + CollectionPage
 * JSON-LD for search engines. Copy states only what each package describes
 * about itself; the subhead makes no capability claim (demo-claim gate).
 */
export default async function MarketplaceCategoryPage(props: {
  params: Promise<{ category: string }>;
}) {
  const { category: slug } = await props.params;
  const category = asMarketplaceCategory(slug);
  if (!category) notFound();

  const label = CATEGORY_LABELS[category];
  const installCounts: Record<string, number> = await fetchInstallCounts().catch(() => ({}));
  const packages = await fetchCategoryPackages(category, installCounts);

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Marketplace',
        item: `${siteConfig.url}/marketplace`,
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: label,
        item: `${siteConfig.url}/marketplace/category/${category}`,
      },
    ],
  };

  const collectionJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${label} — DorkOS Marketplace`,
    description: CATEGORY_DESCRIPTIONS[category],
    url: `${siteConfig.url}/marketplace/category/${category}`,
    hasPart: packages.map((p) => ({
      '@type': 'SoftwareApplication',
      name: p.name,
      description: p.description ?? 'A DorkOS marketplace package',
      applicationCategory: 'DeveloperApplication',
      url: `${siteConfig.url}/marketplace/${p.name}`,
    })),
  };

  return (
    <main className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(collectionJsonLd).replace(/</g, '\\u003c'),
        }}
      />

      {/* Back link */}
      <Link
        href="/marketplace"
        className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth mb-8 inline-flex items-center gap-1 font-mono tracking-[0.04em]"
      >
        <ArrowLeft size={12} /> Marketplace
      </Link>

      {/* Page header */}
      <div className="mb-12">
        <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">{label}</h1>
        <p className="text-warm-gray-light mt-3 font-mono text-sm">
          Browse {label} packages for DorkOS
        </p>
        <p className="text-warm-gray mt-4 max-w-2xl text-base leading-relaxed">
          {CATEGORY_DESCRIPTIONS[category]}
        </p>
      </div>

      {packages.length === 0 ? (
        <section className="border-warm-gray-light/30 bg-cream-secondary/50 rounded-lg border p-12 text-center">
          <h2 className="text-charcoal font-mono text-xl font-semibold">No {label} packages yet</h2>
          <p className="text-warm-gray mx-auto mt-4 max-w-xl text-base leading-relaxed">
            Packages in this category will appear here as they&apos;re published. In the meantime,
            browse the{' '}
            <Link href="/marketplace" className="text-charcoal underline">
              full marketplace
            </Link>
            .
          </p>
        </section>
      ) : (
        <section aria-label={`${label} packages`}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((pkg) => (
              <PackageCard key={pkg.name} package={pkg} installCount={installCounts[pkg.name]} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

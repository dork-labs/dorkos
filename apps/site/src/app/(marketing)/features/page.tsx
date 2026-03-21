import type { Metadata } from 'next';
import Link from 'next/link';
import { siteConfig } from '@/config/site';
import { features, PRODUCT_LABELS, type FeatureProduct } from '@/layers/features/marketing';
import { FeatureCard } from '@/layers/features/marketing';

export const metadata: Metadata = {
  title: 'Features — DorkOS',
  description:
    'The complete DorkOS feature catalog — scheduling, messaging, agent discovery, and more. Built for developers who ship.',
  alternates: { canonical: '/features' },
  openGraph: {
    title: 'Features — DorkOS',
    description: 'The complete DorkOS feature catalog.',
    url: '/features',
    siteName: siteConfig.name,
  },
};

const VALID_PRODUCTS = Object.keys(PRODUCT_LABELS) as FeatureProduct[];

/**
 * Feature catalog index page — server-rendered product filtering via ?product= param.
 */
export default async function FeaturesPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const rawProduct = searchParams['product'];
  const activeProduct =
    typeof rawProduct === 'string' && VALID_PRODUCTS.includes(rawProduct as FeatureProduct)
      ? (rawProduct as FeatureProduct)
      : null;

  const filteredFeatures = activeProduct
    ? features.filter((f) => f.product === activeProduct)
    : features;

  // Sort within each product by sortOrder, then insertion order
  const sortedFeatures = [...filteredFeatures].sort((a, b) => {
    if (a.product !== b.product) return 0;
    return (a.sortOrder ?? 999) - (b.sortOrder ?? 999);
  });

  return (
    <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <header className="mb-12">
        <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">Features</h1>
        <p className="text-warm-gray mt-3 max-w-2xl text-lg">
          Everything DorkOS does — scheduling, messaging, discovery, and control.
        </p>
      </header>

      {/* Product tab strip — pure links, no JS */}
      <nav className="mb-10 flex flex-wrap gap-2" aria-label="Filter by product">
        <ProductTab href="/features" active={activeProduct === null} label="All" />
        {VALID_PRODUCTS.map((prod) => (
          <ProductTab
            key={prod}
            href={`/features?product=${prod}`}
            active={activeProduct === prod}
            label={PRODUCT_LABELS[prod]}
          />
        ))}
      </nav>

      {sortedFeatures.length === 0 ? (
        <p className="text-warm-gray-light text-sm">No features in this category yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sortedFeatures.map((feature) => (
            <FeatureCard key={feature.slug} feature={feature} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductTab({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      className={`rounded-full px-4 py-1.5 font-mono text-xs tracking-[0.04em] transition-colors ${
        active
          ? 'bg-charcoal text-cream-primary'
          : 'border-warm-gray-light/30 text-warm-gray hover:text-charcoal border'
      }`}
    >
      {label}
    </Link>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { siteConfig } from '@/config/site';
import { features, CATEGORY_LABELS, type FeatureCategory } from '@/layers/features/marketing';
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

const VALID_CATEGORIES = Object.keys(CATEGORY_LABELS) as FeatureCategory[];

/**
 * Feature catalog index page — server-rendered category filtering via ?category= param.
 */
export default async function FeaturesPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const rawCategory = searchParams['category'];
  const activeCategory =
    typeof rawCategory === 'string' && VALID_CATEGORIES.includes(rawCategory as FeatureCategory)
      ? (rawCategory as FeatureCategory)
      : null;

  const filteredFeatures = activeCategory
    ? features.filter((f) => f.category === activeCategory)
    : features;

  // Sort within each category by sortOrder, then insertion order
  const sortedFeatures = [...filteredFeatures].sort((a, b) => {
    if (a.category !== b.category) return 0;
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

      {/* Category tab strip — pure links, no JS */}
      <nav className="mb-10 flex flex-wrap gap-2" aria-label="Filter by category">
        <CategoryTab href="/features" active={activeCategory === null} label="All" />
        {VALID_CATEGORIES.map((cat) => (
          <CategoryTab
            key={cat}
            href={`/features?category=${cat}`}
            active={activeCategory === cat}
            label={CATEGORY_LABELS[cat]}
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

function CategoryTab({ href, active, label }: { href: string; active: boolean; label: string }) {
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

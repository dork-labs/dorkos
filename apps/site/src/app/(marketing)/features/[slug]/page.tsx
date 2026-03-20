import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight, ExternalLink, CheckCircle } from 'lucide-react';
import { features, CATEGORY_LABELS } from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';

export function generateStaticParams() {
  return features.map((f) => ({ slug: f.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);
  if (!feature) notFound();

  return {
    title: `${feature.name} — DorkOS`,
    description: feature.description,
    openGraph: {
      title: `${feature.name} — DorkOS`,
      description: feature.description,
      url: `/features/${feature.slug}`,
      siteName: siteConfig.name,
      type: 'website',
    },
    alternates: {
      canonical: `/features/${feature.slug}`,
    },
  };
}

/**
 * Individual feature detail page with JSON-LD structured data.
 *
 * Statically pre-rendered for all slugs via generateStaticParams.
 */
export default async function FeaturePage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const feature = features.find((f) => f.slug === params.slug);
  if (!feature) notFound();

  const relatedFeatureData = (feature.relatedFeatures ?? [])
    .map((slug) => features.find((f) => f.slug === slug))
    .filter(Boolean);

  // BreadcrumbList JSON-LD
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
      { '@type': 'ListItem', position: 2, name: 'Features', item: `${siteConfig.url}/features` },
      {
        '@type': 'ListItem',
        position: 3,
        name: feature.name,
        item: `${siteConfig.url}/features/${feature.slug}`,
      },
    ],
  };

  // SoftwareApplication JSON-LD scoped to this feature
  const featureJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: `${siteConfig.name} — ${feature.name}`,
    description: feature.description,
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    url: `${siteConfig.url}/features/${feature.slug}`,
    featureList: feature.benefits,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };

  return (
    <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(featureJsonLd).replace(/</g, '\\u003c'),
        }}
      />

      {/* Back link */}
      <Link
        href="/features"
        className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth mb-8 inline-flex items-center gap-1 font-mono tracking-[0.04em]"
      >
        <ArrowLeft size={12} /> Features
      </Link>

      <div className="max-w-3xl">
        {/* Category + status badges */}
        <div className="mb-4 flex items-center gap-2">
          <span className="text-warm-gray-light border-warm-gray-light/30 rounded-full border px-2.5 py-0.5 font-mono text-xs">
            {CATEGORY_LABELS[feature.category]}
          </span>
          <StatusBadge status={feature.status} />
        </div>

        <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">
          {feature.name}
        </h1>
        <p className="text-warm-gray mt-3 text-xl leading-relaxed">{feature.tagline}</p>
        <p className="text-warm-gray-light mt-4 text-base">{feature.description}</p>

        {/* Benefits */}
        {feature.benefits.length > 0 && (
          <ul className="mt-8 space-y-3">
            {feature.benefits.map((benefit) => (
              <li key={benefit} className="flex items-start gap-3">
                <CheckCircle
                  size={16}
                  className="text-brand-orange mt-0.5 shrink-0"
                  strokeWidth={2}
                />
                <span className="text-warm-gray text-base">{benefit}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Screenshot */}
        {feature.media?.screenshot && (
          <figure className="mt-10">
            <img
              src={feature.media.screenshot}
              alt={feature.media.alt ?? `${feature.name} screenshot`}
              className="border-warm-gray-light/20 w-full rounded-lg border shadow-sm"
            />
          </figure>
        )}

        {/* Docs link */}
        {feature.docsUrl && (
          <div className="mt-10">
            <Link
              href={feature.docsUrl}
              className="text-charcoal hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono text-sm font-medium"
            >
              Read the docs <ExternalLink size={12} />
            </Link>
          </div>
        )}

        {/* Related features */}
        {relatedFeatureData.length > 0 && (
          <section className="mt-12">
            <h2 className="text-charcoal mb-4 font-mono text-sm font-semibold uppercase tracking-[0.08em]">
              Related Features
            </h2>
            <div className="flex flex-wrap gap-2">
              {relatedFeatureData.map((related) => (
                <Link
                  key={related!.slug}
                  href={`/features/${related!.slug}`}
                  className="border-warm-gray-light/30 text-warm-gray hover:text-charcoal hover:border-warm-gray transition-smooth inline-flex items-center gap-1 rounded-full border px-3 py-1 font-mono text-xs"
                >
                  {related!.name} <ArrowRight size={10} />
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const STATUS_STYLES: Record<string, string> = {
  ga: 'bg-emerald-100/60 text-emerald-900',
  beta: 'bg-amber-100/60 text-amber-900',
  'coming-soon': 'bg-warm-gray/10 text-warm-gray-light',
};

const STATUS_LABELS: Record<string, string> = {
  ga: 'Available',
  beta: 'Beta',
  'coming-soon': 'Coming Soon',
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 font-mono text-xs ${STATUS_STYLES[status] ?? ''}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

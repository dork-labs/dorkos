import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import {
  comparisons,
  COMPARISON_FRAMING_COPY,
  features,
  ComparisonAudience,
  ComparisonCriteria,
  ComparisonFaq,
  ComparisonSources,
  ComparisonTable,
  ComparisonVerdict,
  MarketingChrome,
  InstallMoment,
  type Competitor,
} from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';

/** Stable `@id` of the site-wide DorkOS entity declared in the marketing layout. */
const SOFTWARE_APP_ID = `${siteConfig.url}/#software`;

/** Framings that get the two-column "which one is for you" recommendation. */
const HEAD_TO_HEAD: Competitor['framing'][] = ['competitor', 'adjacent'];

export function generateStaticParams() {
  return comparisons.map((competitor) => ({ slug: competitor.slug }));
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const competitor = comparisons.find((c) => c.slug === params.slug);
  if (!competitor) notFound();

  const title = COMPARISON_FRAMING_COPY[competitor.framing].metaTitle(competitor.name);

  return {
    title,
    description: competitor.oneLiner,
    openGraph: {
      title,
      description: competitor.oneLiner,
      url: `/compare/${competitor.slug}`,
      siteName: siteConfig.name,
      type: 'website',
    },
    twitter: twitterFromOpenGraph({ title, description: competitor.oneLiner }),
    alternates: {
      // One address per pair, self first. The reversed wording lives in the page
      // copy, never in a second URL.
      canonical: `/compare/${competitor.slug}`,
      types: rssFeedAlternateTypes,
    },
  };
}

/**
 * A single comparison page, statically pre-rendered for every entry in the
 * comparison catalog. The template branches on the entry's framing, so adding a
 * product later is a data change, not a code change.
 */
export default async function ComparisonPage(props: { params: Promise<{ slug: string }> }) {
  const params = await props.params;
  const competitor = comparisons.find((c) => c.slug === params.slug);
  if (!competitor) notFound();

  const copy = COMPARISON_FRAMING_COPY[competitor.framing];
  const headline = copy.headline(competitor.name);
  const scopeNote = copy.scopeNote?.(competitor.name);
  const relatedFeatureData = (competitor.relatedFeatures ?? [])
    .map((slug) => features.find((f) => f.slug === slug))
    .filter((feature) => feature !== undefined);

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
      { '@type': 'ListItem', position: 2, name: 'Compare', item: `${siteConfig.url}/compare` },
      {
        '@type': 'ListItem',
        position: 3,
        name: headline,
        item: `${siteConfig.url}/compare/${competitor.slug}`,
      },
    ],
  };

  // Both products as entities: DorkOS by reference to the site-wide node, the
  // other product with its own maker and address.
  const productsJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        '@id': SOFTWARE_APP_ID,
        name: siteConfig.name,
        url: siteConfig.url,
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${siteConfig.url}/compare/${competitor.slug}#${competitor.slug}`,
        name: competitor.name,
        url: competitor.homepage,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Any',
        author: { '@type': 'Organization', name: competitor.maker },
      },
    ],
  };

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: competitor.faq.map((entry) => ({
      '@type': 'Question',
      name: entry.q,
      acceptedAnswer: { '@type': 'Answer', text: entry.a },
    })),
  };

  return (
    <MarketingChrome>
      <div className="mx-auto max-w-5xl px-6 pt-32 pb-16">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(productsJsonLd).replace(/</g, '\\u003c'),
          }}
        />
        {competitor.faq.length > 0 && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(faqJsonLd).replace(/</g, '\\u003c'),
            }}
          />
        )}

        <Link
          href="/compare"
          className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth mb-8 inline-flex items-center gap-1 font-mono tracking-[0.04em]"
        >
          <ArrowLeft size={12} /> Compare
        </Link>

        <header className="mt-8 mb-10">
          <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">{headline}</h1>
          <p className="text-warm-gray mt-3 max-w-3xl text-lg leading-relaxed">
            {copy.intro(competitor.name)}
          </p>
        </header>

        {scopeNote && (
          <p className="border-brand-orange/40 text-warm-gray mb-10 border-l-2 pl-5 text-base leading-relaxed">
            {scopeNote}
          </p>
        )}

        <ComparisonVerdict competitor={competitor} />

        {HEAD_TO_HEAD.includes(competitor.framing) && (
          <ComparisonAudience competitor={competitor} />
        )}

        <ComparisonTable competitor={competitor} />

        <ComparisonCriteria competitor={competitor} />

        <ComparisonFaq competitor={competitor} />

        {relatedFeatureData.length > 0 && (
          <section aria-labelledby="dig-deeper" className="mt-16">
            <h2
              id="dig-deeper"
              className="text-charcoal mb-4 font-mono text-sm font-semibold tracking-[0.08em] uppercase"
            >
              Dig into the DorkOS side
            </h2>
            <div className="flex flex-wrap gap-2">
              {relatedFeatureData.map((feature) => (
                <Link
                  key={feature.slug}
                  href={`/features/${feature.slug}`}
                  className="border-warm-gray-light/30 text-warm-gray hover:text-charcoal hover:border-warm-gray transition-smooth inline-flex items-center gap-1 rounded-full border px-3 py-1 font-mono text-xs"
                >
                  {feature.name} <ArrowRight size={10} />
                </Link>
              ))}
            </div>
          </section>
        )}

        <ComparisonSources competitor={competitor} />
      </div>

      {/* Install CTA — the established install pattern */}
      <InstallMoment />
    </MarketingChrome>
  );
}

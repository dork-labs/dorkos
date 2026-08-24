import type { Metadata } from 'next';
import {
  comparisons,
  COMPARISON_FRAMING_COPY,
  CompetitorCard,
  MarketingChrome,
  InstallMoment,
  ProductFrame,
  type ComparisonFraming,
} from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';

const TITLE = 'Compare DorkOS — DorkOS';
const DESCRIPTION =
  'How DorkOS stacks up against the other tools for running coding agents. Honest comparisons, with the date we last checked and where every fact came from.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/compare', types: rssFeedAlternateTypes },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: '/compare',
    siteName: siteConfig.name,
    type: 'website',
  },
  twitter: twitterFromOpenGraph({ title: TITLE, description: DESCRIPTION }),
};

/** Hub section order. Head-to-head first: that is what people come looking for. */
const FRAMING_ORDER: ComparisonFraming[] = ['competitor', 'runtime', 'adjacent', 'discontinued'];

/**
 * The /compare hub: every comparison page, grouped by how DorkOS relates to the
 * other product. Groups with no entries are left out, so the page grows as
 * comparisons are added without ever showing an empty shelf.
 */
export default function ComparePage() {
  const groups = FRAMING_ORDER.map((framing) => ({
    framing,
    copy: COMPARISON_FRAMING_COPY[framing],
    entries: comparisons.filter((competitor) => competitor.framing === framing),
  })).filter((group) => group.entries.length > 0);

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: siteConfig.url },
      { '@type': 'ListItem', position: 2, name: 'Compare', item: `${siteConfig.url}/compare` },
    ],
  };

  const itemListJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'DorkOS comparisons',
    itemListElement: comparisons.map((competitor, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: COMPARISON_FRAMING_COPY[competitor.framing].headline(competitor.name),
      url: `${siteConfig.url}/compare/${competitor.slug}`,
    })),
  };

  return (
    <MarketingChrome>
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
            __html: JSON.stringify(itemListJsonLd).replace(/</g, '\\u003c'),
          }}
        />

        <header className="mb-12 grid grid-cols-1 items-center gap-10 lg:grid-cols-2">
          <div>
            <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">Compare</h1>
            <p className="text-warm-gray mt-3 max-w-2xl text-lg">
              How DorkOS stacks up against the other ways to run coding agents. Every page says
              where the other tool is better, when we last checked the facts, and where they came
              from.
            </p>
          </div>

          {/* The thing being compared, shown rather than described */}
          <ProductFrame
            surface="cockpit"
            alt="DorkOS: every coding agent you run, in one place"
            size="hero"
            priority
          />
        </header>

        <div className="space-y-14">
          {groups.map((group) => (
            <section key={group.framing} aria-labelledby={`group-${group.framing}`}>
              <h2
                id={`group-${group.framing}`}
                className="text-charcoal font-mono text-sm font-semibold tracking-[0.08em] uppercase"
              >
                {group.copy.groupLabel}
              </h2>
              <p className="text-warm-gray mt-2 text-sm">{group.copy.groupBlurb}</p>
              <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
                {group.entries.map((competitor) => (
                  <CompetitorCard key={competitor.slug} competitor={competitor} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>

      {/* Closing exit ramp — the established install pattern */}
      <InstallMoment />
    </MarketingChrome>
  );
}

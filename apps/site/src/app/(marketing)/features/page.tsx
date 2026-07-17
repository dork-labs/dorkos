import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import { features, PRODUCT_LABELS, type FeatureProduct } from '@/layers/features/marketing';
import { FeatureCatalog, MarketingChrome, InstallMoment } from '@/layers/features/marketing';

export const metadata: Metadata = {
  title: 'Features — DorkOS',
  description:
    'The complete DorkOS feature catalog: scheduling, messaging, agent discovery, and more. Built for developers who ship.',
  alternates: { canonical: '/features', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Features — DorkOS',
    description: 'The complete DorkOS feature catalog.',
    url: '/features',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({
    title: 'Features — DorkOS',
    description: 'The complete DorkOS feature catalog.',
  }),
};

const VALID_PRODUCTS = Object.keys(PRODUCT_LABELS) as FeatureProduct[];

/**
 * Feature catalog index page. Reads the `?product=` param for a server-rendered,
 * shareable initial filter, then hands the full catalog to {@link FeatureCatalog},
 * which filters and reflows client-side with an animated bento grid.
 */
export default async function FeaturesPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const searchParams = await props.searchParams;
  const rawProduct = searchParams['product'];
  const initialProduct =
    typeof rawProduct === 'string' && VALID_PRODUCTS.includes(rawProduct as FeatureProduct)
      ? (rawProduct as FeatureProduct)
      : null;

  return (
    <MarketingChrome>
      <div className="mx-auto max-w-6xl px-6 pt-32 pb-24">
        <header className="mb-12">
          <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">Features</h1>
          <p className="text-warm-gray mt-3 max-w-2xl text-lg">
            Mission control for every coding agent you run: the full catalog, organized by what each
            part does.
          </p>
        </header>

        <FeatureCatalog features={features} initialProduct={initialProduct} />
      </div>

      {/* Closing exit ramp — the established install pattern */}
      <InstallMoment />
    </MarketingChrome>
  );
}

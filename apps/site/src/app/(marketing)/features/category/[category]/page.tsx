import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  ExternalLink,
  MessageSquare,
  Calendar,
  Mail,
  Plug,
  Search,
  Network,
  Server,
  Bot,
  Fingerprint,
  Store,
} from 'lucide-react';
import {
  features,
  CATEGORY_LABELS,
  PRODUCT_LABELS,
  ProductFrame,
  ProductBadge,
  MarketingChrome,
  InstallMoment,
  type FeatureCategory,
  type FeatureStatus,
} from '@/layers/features/marketing';
import { siteConfig } from '@/config/site';

export function generateStaticParams() {
  return (Object.keys(CATEGORY_LABELS) as FeatureCategory[]).map((category) => ({ category }));
}

export async function generateMetadata(props: {
  params: Promise<{ category: string }>;
}): Promise<Metadata> {
  const params = await props.params;
  const category = params.category as FeatureCategory;
  const label = CATEGORY_LABELS[category];
  if (!label) notFound();

  const categoryFeatures = features.filter((f) => f.category === category);
  const description = `DorkOS ${label.toLowerCase()} capabilities: ${categoryFeatures.map((f) => f.name).join(', ')}.`;

  return {
    title: `${label} Features — DorkOS`,
    description,
    openGraph: {
      title: `${label} Features — DorkOS`,
      description,
      url: `/features/category/${category}`,
      siteName: siteConfig.name,
      type: 'website',
    },
    alternates: {
      canonical: `/features/category/${category}`,
    },
  };
}

export default async function FeatureCategoryPage(props: {
  params: Promise<{ category: string }>;
}) {
  const params = await props.params;
  const category = params.category as FeatureCategory;
  const label = CATEGORY_LABELS[category];
  if (!label) notFound();

  const categoryFeatures = features.filter((f) => f.category === category);
  const description = `DorkOS ${label.toLowerCase()} capabilities: ${categoryFeatures.map((f) => f.name).join(', ')}.`;

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
        name: `${label} Features`,
        item: `${siteConfig.url}/features/category/${category}`,
      },
    ],
  };

  // CollectionPage JSON-LD
  const collectionJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: `${label} Features — DorkOS`,
    description,
    url: `${siteConfig.url}/features/category/${category}`,
    hasPart: categoryFeatures.map((f) => ({
      '@type': 'SoftwareApplication',
      name: f.name,
      description: f.description,
      applicationCategory: 'DeveloperApplication',
      featureList: f.benefits,
    })),
  };

  const CategoryIcon = CATEGORY_ICONS[category];

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
            __html: JSON.stringify(collectionJsonLd).replace(/</g, '\\u003c'),
          }}
        />

        {/* Back link */}
        <Link
          href="/features"
          className="text-2xs text-warm-gray-light hover:text-brand-orange transition-smooth mb-8 inline-flex items-center gap-1 font-mono tracking-[0.04em]"
        >
          <ArrowLeft size={12} /> Features
        </Link>

        {/* Page header */}
        <div className="mb-16">
          <h1 className="text-charcoal font-mono text-4xl font-bold tracking-tight">
            {label} Features
          </h1>
          <p className="text-warm-gray-light mt-3 font-mono text-sm">
            All DorkOS {label.toLowerCase()} capabilities
          </p>
        </div>

        {/* Feature rows */}
        <div className="divide-warm-gray-light/10 divide-y">
          {categoryFeatures.map((feature, index) => (
            <div
              key={feature.slug}
              className={`grid grid-cols-1 gap-12 py-16 lg:grid-cols-2 ${index === 0 ? 'pt-0' : ''}`}
            >
              {/* Text column */}
              <div>
                <div className="mb-4 flex items-center gap-2">
                  <ProductBadge product={feature.product} />
                  <StatusBadge status={feature.status} />
                </div>

                <h2 className="text-charcoal font-mono text-2xl font-bold tracking-tight">
                  {feature.name}
                </h2>
                <p className="text-warm-gray mt-2 text-lg leading-relaxed">{feature.tagline}</p>
                <p className="text-warm-gray-light mt-3 text-sm leading-relaxed">
                  {feature.description}
                </p>

                {feature.benefits.length > 0 && (
                  <ul className="mt-6 space-y-2.5">
                    {feature.benefits.map((benefit) => (
                      <li key={benefit} className="flex items-start gap-2.5">
                        <CheckCircle
                          size={14}
                          className="text-brand-orange mt-0.5 shrink-0"
                          strokeWidth={2}
                        />
                        <span className="text-warm-gray text-sm">{benefit}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="mt-8 flex flex-wrap items-center gap-4">
                  {feature.docsUrl && (
                    <Link
                      href={feature.docsUrl}
                      className="text-charcoal hover:text-brand-orange transition-smooth inline-flex items-center gap-1.5 font-mono text-sm font-medium"
                    >
                      Read the docs <ExternalLink size={12} />
                    </Link>
                  )}
                  <Link
                    href={`/features/${feature.slug}`}
                    className="text-warm-gray-light hover:text-charcoal transition-smooth inline-flex items-center gap-1 font-mono text-sm"
                  >
                    View details <ArrowRight size={12} />
                  </Link>
                </div>
              </div>

              {/* Media column */}
              <div>
                {feature.media ? (
                  <ProductFrame
                    surface={feature.media.surface}
                    alt={feature.media.alt}
                    crop={feature.media.crop}
                    frame={feature.media.frame}
                    animate={feature.media.loop}
                    size="hero"
                  />
                ) : (
                  <div
                    className="flex h-64 w-full flex-col items-center justify-center rounded-lg lg:h-full lg:min-h-[240px]"
                    style={{
                      background: '#1a1a1a',
                      backgroundImage:
                        'radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px)',
                      backgroundSize: '24px 24px',
                    }}
                  >
                    <CategoryIcon size={32} className="text-warm-gray-light/40 mb-3" />
                    <span className="text-warm-gray-light/50 font-mono text-xs tracking-[0.08em] uppercase">
                      {PRODUCT_LABELS[feature.product]}
                    </span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Closing exit ramp — the established install pattern */}
      <InstallMoment />
    </MarketingChrome>
  );
}

// Category → icon mapping
const CATEGORY_ICONS: Record<
  FeatureCategory,
  React.ComponentType<{ size?: number; className?: string }>
> = {
  chat: MessageSquare,
  'agent-control': Bot,
  scheduling: Calendar,
  messaging: Mail,
  integration: Plug,
  discovery: Search,
  visualization: Network,
  identity: Fingerprint,
  marketplace: Store,
  infrastructure: Server,
};

const STATUS_STYLES: Record<FeatureStatus, string> = {
  ga: 'bg-emerald-100/60 text-emerald-900',
  beta: 'bg-amber-100/60 text-amber-900',
  'coming-soon': 'bg-warm-gray/10 text-warm-gray-light',
};

const STATUS_LABELS: Record<FeatureStatus, string> = {
  ga: 'Available',
  beta: 'Beta',
  'coming-soon': 'Coming Soon',
};

function StatusBadge({ status }: { status: FeatureStatus }) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 font-mono text-xs ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

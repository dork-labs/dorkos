import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { siteConfig } from '@/config/site';
import {
  fetchMarketplaceJson,
  fetchPackageReadme,
  fetchInstallCount,
  fetchInstallCounts,
  PackageHeader,
  PermissionPreviewServer,
  PackageReadme,
  InstallInstructions,
  RelatedPackages,
} from '@/layers/features/marketplace';

export const revalidate = 3600;

/**
 * Prerender one path per seed package. When the registry is unreachable
 * at build time (e.g. before the dorkos-community repo is published),
 * return an empty list so the build succeeds and slugs fall through to
 * on-demand SSR. The hourly ISR loop will pick them up once the registry
 * becomes reachable.
 */
export async function generateStaticParams() {
  try {
    const marketplace = await fetchMarketplaceJson();
    return marketplace.plugins.map((p) => ({ slug: p.name }));
  } catch {
    return [];
  }
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const marketplace = await fetchMarketplaceJson().catch(() => null);
  const pkg = marketplace?.plugins.find((p) => p.name === slug);
  if (!pkg) return { title: 'Not found — DorkOS' };

  const title = `${pkg.name} — DorkOS Marketplace`;
  const description = pkg.description ?? 'A DorkOS marketplace package';
  return {
    title,
    description,
    alternates: { canonical: `/marketplace/${pkg.name}` },
    openGraph: {
      title,
      description,
      url: `/marketplace/${pkg.name}`,
      siteName: siteConfig.name,
      type: 'website',
    },
  };
}

/**
 * Marketplace package detail page — server-rendered with hourly ISR.
 *
 * Pulls the registry, the package's README, and install counts in parallel,
 * then renders the header, permission preview, README, install instructions,
 * and related packages. JSON-LD breadcrumb and SoftwareApplication blocks are
 * emitted for SEO (mirrors `apps/site/src/app/(marketing)/features/[slug]/page.tsx`).
 */
export default async function PackageDetailPage(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  // When the registry is unreachable (e.g. before the dorkos-community repo
  // is published), surface a 404 rather than a 500. The browse page renders
  // a "launching soon" empty state for the same condition.
  const marketplace = await fetchMarketplaceJson().catch(() => null);
  const pkg = marketplace?.plugins.find((p) => p.name === slug);
  if (!pkg || !marketplace) notFound();

  const [readme, installCount, installCounts] = await Promise.all([
    fetchPackageReadme(pkg.source),
    fetchInstallCount(slug).catch(() => 0),
    fetchInstallCounts().catch(() => ({})),
  ]);

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
        name: pkg.name,
        item: `${siteConfig.url}/marketplace/${pkg.name}`,
      },
    ],
  };

  const packageJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: `${siteConfig.name} — ${pkg.name}`,
    description: pkg.description ?? 'A DorkOS marketplace package',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'macOS, Linux, Windows',
    url: `${siteConfig.url}/marketplace/${pkg.name}`,
    ...(pkg.author ? { author: { '@type': 'Person', name: pkg.author } } : {}),
    ...(pkg.version ? { softwareVersion: pkg.version } : {}),
    ...(pkg.keywords && pkg.keywords.length > 0 ? { keywords: pkg.keywords.join(', ') } : {}),
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  };

  return (
    <article className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(packageJsonLd).replace(/</g, '\\u003c'),
        }}
      />

      <PackageHeader package={pkg} installCount={installCount} />
      <PermissionPreviewServer package={pkg} />
      <PackageReadme markdown={readme} />
      <InstallInstructions package={pkg} />
      <RelatedPackages
        currentName={pkg.name}
        allPackages={marketplace.plugins}
        installCounts={installCounts}
      />
    </article>
  );
}

import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { MarketingShell } from './marketing-shell';

const metaDescription =
  'Mission control for every coding agent you run — Claude Code, Codex, and OpenCode in one cockpit. Schedule your fleet, get pinged when your agents finish, and keep everything on your machine. Open source, MIT.';

export const metadata: Metadata = {
  title: `${siteConfig.name} - ${siteConfig.description}`,
  description: metaDescription,
  openGraph: {
    title: `${siteConfig.name} - ${siteConfig.description}`,
    description: metaDescription,
    url: '/',
    type: 'website',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'DorkOS — mission control for every coding agent you run',
      },
    ],
  },
  alternates: {
    canonical: '/',
  },
};

// JSON-LD structured data for SoftwareApplication
const softwareAppJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: siteConfig.name,
  url: siteConfig.url,
  description: siteConfig.description,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Any',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
  sameAs: [siteConfig.github, siteConfig.npm],
};

// JSON-LD for WebSite with SearchAction (helps with sitelinks search box)
const websiteJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: siteConfig.name,
  url: siteConfig.url,
};

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-cream-primary min-h-screen">
      {/* SoftwareApplication structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(softwareAppJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      {/* WebSite structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(websiteJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <MarketingShell>{children}</MarketingShell>
    </div>
  );
}

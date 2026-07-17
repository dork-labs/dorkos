import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { twitterFromOpenGraph } from '@/lib/metadata';
import { MarketingShell } from './marketing-shell';

const metaTitle = `${siteConfig.name} - ${siteConfig.description}`;
const metaDescription =
  'Mission control for every coding agent you run: Claude Code, Codex, and OpenCode in one cockpit. Schedule your fleet, get pinged when your agents finish, and keep everything on your machine. Open source, MIT.';

export const metadata: Metadata = {
  title: metaTitle,
  description: metaDescription,
  openGraph: {
    title: metaTitle,
    description: metaDescription,
    url: '/',
    type: 'website',
    images: [
      {
        url: '/opengraph-image',
        width: 1200,
        height: 630,
        alt: 'DorkOS: mission control for every coding agent you run',
      },
    ],
  },
  // Mirror the long marketing copy into Twitter so the card matches Open Graph;
  // without this the root layout's shorter description would show on the home
  // page's Twitter card instead.
  twitter: twitterFromOpenGraph({ title: metaTitle, description: metaDescription }),
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

// JSON-LD for WebSite. Deliberately no `potentialAction`/SearchAction: Google
// retired the sitelinks searchbox on 2024-11-21, so the markup no longer does
// anything. This block still declares the site entity (name + canonical URL).
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

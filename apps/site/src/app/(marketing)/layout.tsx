import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
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
    // The (marketing) layout overwrites the root layout's `alternates`, so it
    // must re-declare the RSS feed link to keep advertising it on marketing
    // pages (Next shallow-merges metadata; it does not deep-merge `alternates`).
    types: rssFeedAlternateTypes,
  },
};

// Stable `@id` for the SoftwareApplication entity so the SoftwareSourceCode node
// can link to it (`isSourceCodeOf`) without duplicating the whole object.
const SOFTWARE_APP_ID = `${siteConfig.url}/#software`;

// JSON-LD structured data for SoftwareApplication
const softwareAppJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  '@id': SOFTWARE_APP_ID,
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

// JSON-LD for the Organization entity. Consolidates dorkos.ai, the GitHub repo,
// and the npm package as one entity for search and AI engines. `sameAs` is built
// only from links that already exist in siteConfig (no invented social handles);
// `logo` is the square 512x512 app icon, not the 1200x480 wordmark: Google's
// structured-data guidance prefers a near-square logo, and the mark stays
// legible on white at that size.
const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: siteConfig.name,
  url: siteConfig.url,
  logo: `${siteConfig.url}/icon-512.png`,
  sameAs: [siteConfig.github, siteConfig.npm],
};

// JSON-LD for the open-source identity: the SoftwareApplication's public source.
// Linked to the app entity via `isSourceCodeOf`.
const softwareSourceCodeJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareSourceCode',
  name: `${siteConfig.name} source`,
  url: siteConfig.github,
  codeRepository: siteConfig.github,
  programmingLanguage: 'TypeScript',
  isSourceCodeOf: { '@id': SOFTWARE_APP_ID },
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
      {/* Organization structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(organizationJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      {/* SoftwareSourceCode structured data (open-source identity) */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(softwareSourceCodeJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <MarketingShell>{children}</MarketingShell>
    </div>
  );
}

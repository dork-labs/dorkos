import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes } from '@/lib/metadata';
import { Providers } from './providers';
import { CookieConsentBanner } from '@/layers/widgets/cookie-consent';
import { AnalyticsIdentity } from '@/layers/widgets/analytics-identity';
import { env } from '@/env';
import { cloudAccountsForwarding } from '@/lib/cloud-accounts/forward';
import './globals.css';

// Bundled, not fetched: next/font/google downloads at build time and that
// download failed often enough in CI to eject PRs from the merge queue
// (DOR-3434). Latin subset, normal style, from @fontsource 5.3.0; OFL in ./fonts.
const ibmPlexSans = localFont({
  src: [
    { path: './fonts/ibm-plex-sans-latin-300-normal.woff2', weight: '300', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-600-normal.woff2', weight: '600', style: 'normal' },
    { path: './fonts/ibm-plex-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
});

const ibmPlexMono = localFont({
  src: [
    { path: './fonts/ibm-plex-mono-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
    { path: './fonts/ibm-plex-mono-latin-600-normal.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: siteConfig.name,
    template: `%s | ${siteConfig.name}`,
  },
  description: siteConfig.description,
  keywords: [
    'dorkos',
    'ai agents',
    'mini apps',
    'founders',
    'workspace for people and agents',
    'claude code',
    'codex',
    'opencode',
    'open source',
  ],
  authors: [{ name: siteConfig.name, url: siteConfig.url }],
  creator: '@doriancollier',
  publisher: siteConfig.name,
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-video-preview': -1,
      'max-image-preview': 'large',
      'max-snippet': -1,
    },
  },
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: '/',
    siteName: siteConfig.name,
    title: `${siteConfig.name}: ${siteConfig.category}`,
    description: siteConfig.description,
    // Images are auto-generated from opengraph-image.tsx
  },
  twitter: {
    card: 'summary_large_image',
    title: `${siteConfig.name}: ${siteConfig.category}`,
    description: siteConfig.description,
    creator: '@doriancollier',
    // Images are auto-generated from twitter-image.tsx
  },
  alternates: {
    canonical: '/',
    // Advertise the blog RSS feed sitewide so readers autodiscover it from any
    // page, not just /blog. Re-declared on segments that set their own
    // `alternates` (they overwrite this one; Next does not deep-merge).
    types: rssFeedAlternateTypes,
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFCF7' },
    { media: '(prefers-color-scheme: dark)', color: '#09090b' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${ibmPlexSans.variable} ${ibmPlexMono.variable} font-sans antialiased`}>
        <Providers>
          {children}
          <CookieConsentBanner />
          {/* Accounts handed to the accounts service (DOR-2441) means the
              session lives on that service's host; asking this one would
              always answer "signed out", once per page view. */}
          {cloudAccountsForwarding(env.DORKOS_CLOUD_ACCOUNTS_ORIGIN) ? null : <AnalyticsIdentity />}
        </Providers>
      </body>
    </html>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';

import { siteConfig } from '@/config/site';
import { MarketingChrome } from '@/layers/features/marketing';
import { NewsletterSignupForm } from '@/layers/shared/ui/newsletter-signup';

export const metadata: Metadata = {
  title: 'Newsletter — DorkOS',
  description:
    'Release notes and fleet reports from DorkOS, about twice a month. Double opt-in, one-click unsubscribe, no spam.',
  alternates: { canonical: '/newsletter' },
  openGraph: {
    title: 'Newsletter — DorkOS',
    description: 'Release notes and fleet reports, about twice a month.',
    url: '/newsletter',
    siteName: siteConfig.name,
  },
};

/**
 * `/newsletter` — the dedicated newsletter landing page (ADR 260707-025214).
 * Hero + signup form + honest cadence promise, with the blog standing in as the
 * public archive.
 */
export default function NewsletterPage() {
  return (
    <MarketingChrome>
      <main className="mx-auto max-w-2xl px-6 pt-32 pb-24">
        <p className="text-2xs text-brand-orange mb-4 font-mono tracking-[0.15em] uppercase">
          The DorkOS newsletter
        </p>
        <h1 className="text-charcoal font-mono text-3xl font-bold tracking-tight sm:text-4xl">
          One person. A fleet of agents. Read the receipts.
        </h1>
        <p className="text-warm-gray mt-4 text-lg">
          Release notes and fleet reports, about twice a month: what shipped, what the fleet did
          overnight, and the numbers behind it. No hype, no more than we promised.
        </p>

        <div className="border-warm-gray-light/30 mt-10 rounded-xl border p-6 sm:p-8">
          <NewsletterSignupForm source="newsletter-page" variant="card" />
        </div>

        <p className="text-warm-gray-light mt-8 text-sm">
          Want to read first? Every issue is built from the{' '}
          <Link href="/blog" className="text-charcoal hover:text-brand-orange underline">
            blog
          </Link>
          , which doubles as the full archive.
        </p>
      </main>
    </MarketingChrome>
  );
}

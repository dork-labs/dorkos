import type { Metadata } from 'next';
import Link from 'next/link';

import { MarketingChrome } from '@/layers/features/marketing';

export const metadata: Metadata = {
  title: 'Unsubscribed — DorkOS',
  robots: { index: false },
};

/**
 * `/newsletter/unsubscribed` — result page the unsubscribe route redirects to
 * (ADR 260707-025214). Always friendly and idempotent, even for an
 * already-processed or unknown token.
 */
export default function NewsletterUnsubscribedPage() {
  return (
    <MarketingChrome>
      <main className="mx-auto max-w-xl px-6 pt-32 pb-24 text-center">
        <h1 className="text-charcoal font-mono text-2xl font-bold tracking-tight sm:text-3xl">
          You&apos;re unsubscribed.
        </h1>
        <p className="text-warm-gray mt-4 text-lg">
          You won&apos;t get any more DorkOS newsletters. No hard feelings — you can resubscribe any
          time.
        </p>
        <div className="mt-8 flex justify-center gap-4 font-mono text-sm">
          <Link href="/newsletter" className="text-charcoal hover:text-brand-orange underline">
            Resubscribe
          </Link>
          <Link href="/" className="text-charcoal hover:text-brand-orange underline">
            Back home
          </Link>
        </div>
      </main>
    </MarketingChrome>
  );
}

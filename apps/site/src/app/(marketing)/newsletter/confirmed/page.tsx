import type { Metadata } from 'next';
import Link from 'next/link';

import { MarketingChrome } from '@/layers/features/marketing';

export const metadata: Metadata = {
  title: 'Subscription confirmed — DorkOS',
  robots: { index: false },
};

/**
 * `/newsletter/confirmed` — result page the confirm route redirects to
 * (ADR 260707-025214). `?status=invalid` renders the expired/unknown-token
 * variant so a stale link still lands somewhere friendly.
 */
export default async function NewsletterConfirmedPage(props: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await props.searchParams;
  const invalid = status === 'invalid';

  return (
    <MarketingChrome>
      <main className="mx-auto max-w-xl px-6 pt-32 pb-24 text-center">
        <h1 className="text-charcoal font-mono text-2xl font-bold tracking-tight sm:text-3xl">
          {invalid ? 'That link has expired' : "You're in."}
        </h1>
        <p className="text-warm-gray mt-4 text-lg">
          {invalid ? (
            <>
              This confirmation link is invalid or has expired. Subscribe again and we&apos;ll send
              a fresh one.
            </>
          ) : (
            <>
              Your email is confirmed. You&apos;ll get release notes and fleet reports about twice a
              month, and one click unsubscribes any time.
            </>
          )}
        </p>
        <div className="mt-8 flex justify-center gap-4 font-mono text-sm">
          {invalid ? (
            <Link href="/newsletter" className="text-charcoal hover:text-brand-orange underline">
              Back to the newsletter
            </Link>
          ) : (
            <>
              <Link href="/blog" className="text-charcoal hover:text-brand-orange underline">
                Read the blog
              </Link>
              <Link href="/" className="text-charcoal hover:text-brand-orange underline">
                Back home
              </Link>
            </>
          )}
        </div>
      </main>
    </MarketingChrome>
  );
}

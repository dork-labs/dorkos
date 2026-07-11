import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Cookie Policy',
  description: 'The short list of cookies dorkos.ai actually sets.',
};

export default function CookiePolicyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Cookie Policy</h1>
          <p className="text-warm-gray text-lg">Last updated: July 10, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            This site is run by Blaze Ventures, LLC. When this page says &quot;we,&quot; that is who
            we mean.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <p className="text-warm-gray leading-relaxed">
            We keep cookies to a minimum. We set a login cookie if you sign in, and a small cookie
            that remembers UI preferences. We do not use ad cookies, and we do not sell cookie data.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">What is a cookie?</h2>
          <p className="text-warm-gray leading-relaxed">
            A cookie is a small text file a website stores in your browser. It helps the site
            remember things, like the fact that you are signed in.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Which cookies we set</h2>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">Login cookie</h3>
            <p className="text-warm-gray leading-relaxed">
              If you sign in to a DorkOS account, we set a session cookie so you stay signed in. It
              is required for signing in to work, and it goes away when your session ends.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">Preference cookie</h3>
            <p className="text-warm-gray leading-relaxed">
              We store a small cookie that remembers UI choices, like whether a sidebar is open, so
              the site looks the way you left it.
            </p>
          </div>

          <div className="space-y-3">
            <h3 className="text-charcoal text-lg font-medium">Analytics</h3>
            <p className="text-warm-gray leading-relaxed">
              We do not run website analytics today, so we do not set analytics cookies. The site
              has PostHog, a privacy-friendly analytics tool, wired in, but it stays completely off
              until we configure it. If we turn it on, PostHog will only store anything in your
              browser after you accept the consent banner, and we will update this page first.
            </p>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Managing cookies</h2>
          <p className="text-warm-gray leading-relaxed">
            You can view, block, or delete cookies in your browser settings. If you block the login
            cookie, signing in will not work, but the rest of the site will still load.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">When this changes</h2>
          <p className="text-warm-gray leading-relaxed">
            When we change how we use cookies, we will update this page and the date at the top.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">More detail</h2>
          <p className="text-warm-gray leading-relaxed">
            For the full picture of what we collect, see our{' '}
            <Link href="/privacy" className="text-charcoal hover:text-brand-orange underline">
              Privacy Policy
            </Link>
            . Questions? Email us at{' '}
            <a
              href="mailto:hey@dorkos.ai"
              className="text-charcoal hover:text-brand-orange underline"
            >
              hey@dorkos.ai
            </a>
            .
          </p>
        </section>
      </article>
    </main>
  );
}

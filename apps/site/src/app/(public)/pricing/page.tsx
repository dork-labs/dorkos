import type { Metadata } from 'next';
import Link from 'next/link';
import { siteConfig } from '@/config/site';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'What stays free forever, what will cost money later, and why. In writing, before anything costs a cent.',
  alternates: { canonical: '/pricing' },
  openGraph: {
    title: 'Pricing — DorkOS',
    description: 'What stays free forever, what will cost money later, and why.',
    url: '/pricing',
    siteName: siteConfig.name,
  },
};

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Pricing</h1>
          <p className="text-warm-gray text-lg">Last updated: July 11, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. Nothing about DorkOS costs money yet. We are
            writing this page now, before the first invoice exists, because that is the only time a
            promise about pricing actually means something.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              Everything you can use today, and everything we build as the free core, stays free.
              Forever. Not a trial, not a set of missing pieces waiting to be unlocked.
            </li>
            <li>
              If we ever charge for something, it will be new: a cloud service that needs our
              servers, or that helps more than one person coordinate. It will never be something
              that used to be free.
            </li>
            <li>
              We will announce a price here, with the reason for it, before you ever see a bill. No
              surprise upgrades, no quiet feature removal.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The free core, in writing
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is open source under the MIT license, and that does not change. The cockpit, all
            three agent runtimes, Tasks, Relay, Mesh, the Marketplace, your own tunnel for remote
            access, and every client surface (browser, desktop, Obsidian) are yours to run, fork,
            and keep. One operator, full power, works offline, no account required unless you choose
            to open it up to another device.
          </p>
          <p className="text-warm-gray leading-relaxed">
            That is not a starter tier. It is the whole product. Its job is to be the best free
            thing in its category, and it stays that way whether or not we ever make a dollar.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Where money will come in
          </h2>
          <p className="text-warm-gray leading-relaxed">
            The line is simple: if it runs entirely on your own machine, it is free. Money only
            enters through things that need our servers to work, or that help more than one person
            coordinate. We are not there yet, but the kinds of things that fit on the paid side of
            that line are:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              Reaching your fleet from your phone or another device without setting up your own
              tunnel.
            </li>
            <li>Push notifications that do not require you to wire up your own bot.</li>
            <li>
              One view across every machine you run DorkOS on, instead of checking each one
              separately.
            </li>
            <li>
              Later, tools for a small team to share a fleet, hand agents to each other, and see
              what everyone is spending on models, together.
            </li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            None of that changes what running DorkOS on your own computer means. A team that
            installs DorkOS on one machine and shares it the way they already share any local tool
            pays nothing extra for that. The gate is on the feature, not on how many people are
            standing behind your keyboard.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">The promise</h2>
          <p className="text-warm-gray leading-relaxed">
            Open source tools have a bad habit: something is free for years, people build their work
            around it, and then it quietly stops being free. We are writing this page now, before
            that question can even come up, so we cannot do that later without everyone watching.
          </p>
          <p className="text-warm-gray leading-relaxed">
            Anything DorkOS ever ships as free stays free. New paid features get added next to the
            free core, never carved out of it. If we are ever tempted to change that, this page is
            the thing that stops us.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">When this changes</h2>
          <p className="text-warm-gray leading-relaxed">
            When we have real prices to announce, we will publish them here first, with plain
            reasoning, before anyone is asked to pay. Until then, this page describes the plan, not
            a bill you should expect. Questions? Email us at{' '}
            <a
              href="mailto:hey@dorkos.ai"
              className="text-charcoal hover:text-brand-orange underline"
            >
              hey@dorkos.ai
            </a>
            . For how DorkOS handles your data and machine, see{' '}
            <Link href="/security" className="text-charcoal hover:text-brand-orange underline">
              Security
            </Link>{' '}
            and{' '}
            <Link href="/privacy" className="text-charcoal hover:text-brand-orange underline">
              Privacy
            </Link>
            .
          </p>
        </section>
      </article>
    </main>
  );
}

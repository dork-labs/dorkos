import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'The plain-English deal for using the DorkOS website and services.',
};

export default function TermsOfServicePage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Terms of Service</h1>
          <p className="text-warm-gray text-lg">Last updated: July 9, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. When these terms say &quot;we,&quot; that is who
            you are agreeing with.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              The DorkOS software is open source under the MIT license. You can read, change, and
              run every line. That license, not this page, governs the code.
            </li>
            <li>
              This website and the extras we host, the newsletter, accounts, and the Marketplace
              listing, are free and provided as-is, with no warranty.
            </li>
            <li>
              You run the agents on your own machine, so you are responsible for what they do.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The software is yours to use
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is open source under the MIT license. A copy of that license ships with the code.
            It lets you use, copy, change, and share DorkOS for free, and it says the software comes
            with no warranty.
          </p>
          <p className="text-warm-gray leading-relaxed">
            The MIT license is the real agreement for the software itself. These terms only cover
            this website and the services we host on it.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            You run the agents, so you own what they do
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS runs AI agents on your own computer. Those agents act with your permissions. They
            can run commands, change files, and use your API keys.
          </p>
          <p className="text-warm-gray leading-relaxed">
            You decide what an agent is allowed to do, and you are responsible for what it does.
            Review what you set it loose on. If an agent deletes a file or runs up an API bill, that
            is on you, not us. Keep backups, and set limits you are comfortable with.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            The website and services are provided as-is
          </h2>
          <p className="text-warm-gray leading-relaxed">
            We offer this website, the newsletter, accounts, and the Marketplace listing for free.
            We provide them as-is and as-available, with no warranty of any kind. We cannot promise
            they will always be online, fast, or bug-free, and we may change or shut down any of
            them at any time.
          </p>
          <p className="text-warm-gray leading-relaxed">
            To the extent the law allows, we are not liable for losses that come from using them.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Using the site fairly</h2>
          <p className="text-warm-gray leading-relaxed">
            A few simple rules keep this working for everyone:
          </p>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>Do not break the law with our services.</li>
            <li>Do not try to break into, overload, or disrupt our systems.</li>
            <li>
              If you make an account, keep your login safe. You are responsible for what happens
              under it.
            </li>
          </ul>
          <p className="text-warm-gray leading-relaxed">
            We may suspend or remove accounts that abuse these terms. Anything you submit to us,
            like feedback or a newsletter reply, stays yours.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Privacy</h2>
          <p className="text-warm-gray leading-relaxed">
            Our{' '}
            <Link href="/privacy" className="text-charcoal hover:text-brand-orange underline">
              Privacy Policy
            </Link>{' '}
            explains what we collect and what we never touch. It is part of these terms.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">When these terms change</h2>
          <p className="text-warm-gray leading-relaxed">
            When we update these terms, we will change the date at the top. If it is a big change,
            we will say so clearly, right here on this page.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Contact</h2>
          <p className="text-warm-gray leading-relaxed">
            Questions about these terms? Email us at{' '}
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

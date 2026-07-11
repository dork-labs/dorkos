import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How DorkOS keeps your machine the trust boundary, and how to report a vulnerability.',
};

export default function SecurityPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <article className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-charcoal font-mono text-3xl font-bold">Security</h1>
          <p className="text-warm-gray text-lg">Last updated: July 11, 2026</p>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is made by Blaze Ventures, LLC. It is an early open-source alpha, and we would
            rather tell you exactly how it works than make it sound safer than it is.
          </p>
        </header>

        <section className="border-warm-gray-light/30 space-y-3 rounded-xl border p-6">
          <h2 className="text-charcoal font-mono text-base font-semibold">The short version</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-1.5 leading-relaxed">
            <li>
              DorkOS runs on your own computer. By default it has no login and listens only on your
              machine.
            </li>
            <li>
              To reach it from your phone or another device, you turn on a real login first. That is
              enforced, not a suggestion.
            </li>
            <li>
              Found a security problem? Email{' '}
              <a
                href="mailto:security@dorkos.ai"
                className="text-charcoal hover:text-brand-orange underline"
              >
                security@dorkos.ai
              </a>
              . Please do not post it publicly until it is fixed.
            </li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Your machine is the line
          </h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS is a cockpit for AI agents that run on your own computer. The one idea that
            explains everything else: your machine is the trust boundary. By default there is no
            account and DorkOS answers only to your own computer, the same way other developer tools
            do. It does not try to protect you from other software you already chose to run under
            your own user. It protects the line between your machine and everyone else.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Reaching DorkOS from elsewhere requires a login
          </h2>
          <p className="text-warm-gray leading-relaxed">
            The moment you want to reach DorkOS remotely, by starting a tunnel or opening it to your
            network, it becomes a networked service. So DorkOS requires an owner account before it
            will do that. Start a tunnel with login off and it walks you through creating one first.
            Bind to a public network address with no login and it refuses to start. Remote visitors
            get a sign-in screen, and every request needs a valid session.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Running an agent is a real act of trust
          </h2>
          <p className="text-warm-gray leading-relaxed">
            Agents can read and write files and run commands inside the boundary you give them.
            Installing a package from the Marketplace runs that package&apos;s code on your machine.
            We fetch packages over safe channels and roll back a failed install cleanly, but we do
            not yet verify a package signature for you. Install packages the way you would run any
            script from the internet: only from authors you trust.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Your AI keys, your data</h2>
          <p className="text-warm-gray leading-relaxed">
            You bring your own AI keys. Your prompts and code go straight to the model vendor you
            chose, under their terms. DorkOS passes it along and keeps no copy. See our{' '}
            <Link href="/privacy" className="text-charcoal hover:text-brand-orange underline">
              Privacy Policy
            </Link>{' '}
            for the full picture.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            Reporting a vulnerability
          </h2>
          <p className="text-warm-gray leading-relaxed">
            If you think you have found a security issue, please tell us privately first. Email{' '}
            <a
              href="mailto:security@dorkos.ai"
              className="text-charcoal hover:text-brand-orange underline"
            >
              security@dorkos.ai
            </a>{' '}
            or use the private &quot;Report a vulnerability&quot; button on our{' '}
            <a
              href="https://github.com/dork-labs/dorkos/security"
              target="_blank"
              rel="noopener noreferrer"
              className="text-charcoal hover:text-brand-orange underline"
            >
              GitHub Security page
            </a>
            . We are a tiny team, so we aim to reply within three business days and fix confirmed
            issues before moving on to new features. We will credit you if you would like.
          </p>
          <p className="text-warm-gray leading-relaxed">
            The full policy lives in{' '}
            <a
              href="https://github.com/dork-labs/dorkos/blob/main/SECURITY.md"
              target="_blank"
              rel="noopener noreferrer"
              className="text-charcoal hover:text-brand-orange underline"
            >
              SECURITY.md
            </a>
            , and the detailed{' '}
            <Link
              href="/docs/self-hosting/threat-model"
              className="text-charcoal hover:text-brand-orange underline"
            >
              threat model
            </Link>{' '}
            explains what DorkOS trusts and where the sharp edges are.
          </p>
        </section>

        <section className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">When this changes</h2>
          <p className="text-warm-gray leading-relaxed">
            DorkOS moves fast. When how it handles security changes, we update this page and change
            the date at the top. No quiet edits.
          </p>
        </section>
      </article>
    </main>
  );
}

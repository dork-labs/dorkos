import type { Metadata } from 'next';
import Link from 'next/link';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';

export const metadata: Metadata = {
  title: 'Marketplace privacy — DorkOS',
  description:
    'How DorkOS handles install telemetry. Anonymous and opt-in. No PII. Anonymous install IDs. Open source pipeline.',
  alternates: { canonical: '/marketplace/privacy', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Marketplace privacy — DorkOS',
    description: 'How DorkOS handles install telemetry: anonymous, opt-in, no PII, anonymous IDs.',
    url: '/marketplace/privacy',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({
    title: 'Marketplace privacy — DorkOS',
    description: 'How DorkOS handles install telemetry: anonymous, opt-in, no PII, anonymous IDs.',
  }),
};

export default function MarketplacePrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 pt-32 pb-24">
      <header className="mb-10">
        <h1 className="text-charcoal font-mono text-3xl font-bold">Marketplace privacy</h1>
        <p className="text-warm-gray mt-3 text-lg">
          What DorkOS does — and does not — collect when you install a marketplace package.
        </p>
      </header>

      <section className="space-y-10">
        <div className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">The contract</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-2 text-base leading-relaxed">
            <li>
              <strong className="text-charcoal font-semibold">No IP addresses logged.</strong> Your
              address is used for one thing: our server counts how many requests come from it in the
              last few minutes, so nobody can flood the endpoint. That count lives in memory for a
              few minutes and then it is gone. Your address is never saved, never written to a log,
              and never passed to anyone else.
            </li>
            <li>
              <strong className="text-charcoal font-semibold">No name or email.</strong> Each event
              carries your install’s random ID (one per install, not per person). That ID is tied to
              your DorkOS account only if you choose to link usage data to your account.
            </li>
            <li>
              <strong className="text-charcoal font-semibold">
                No package contents transmitted.
              </strong>
            </li>
            <li>
              <strong className="text-charcoal font-semibold">Anonymous and opt-in.</strong> Off
              until you turn it on, and anonymous when you do, unless you link usage data to your
              account. DorkOS shows a first-run notice explaining it, and you can turn it back off
              any time.
            </li>
            <li>
              <strong className="text-charcoal font-semibold">Aggregate counts only</strong>{' '}
              displayed publicly on marketplace pages.
            </li>
            <li>
              <strong className="text-charcoal font-semibold">Full event data</strong> accessible
              only to the DorkOS team for debugging.
            </li>
          </ul>
        </div>

        <div className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">What we collect</h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-2 text-base leading-relaxed">
            <li>
              The package name and the marketplace it came from. For a marketplace package, that is
              its name in the marketplace. For a package installed from a direct link, the
              repository or package name is sent as the package name, never the link itself.
            </li>
            <li>
              For a package installed from a folder on your computer, the placeholder{' '}
              <span className="font-mono">&lt;local&gt;</span> instead of the folder name.
            </li>
            <li>
              If an install fails before DorkOS finds the package, a placeholder instead of the
              package name. What you typed is never sent, and the marketplace is sent only if it is
              one you added.
            </li>
            <li>The package type (agent, plugin, skill-pack, adapter, shape).</li>
            <li>
              The kind of source the package came from (GitHub, a URL, a git subfolder, npm, a
              folder in the marketplace, or a folder on your computer), never the address or path.
            </li>
            <li>The install outcome (success, failure, cancelled).</li>
            <li>How long the install took (for performance debugging).</li>
            <li>An error code on failure (so we can fix what is breaking).</li>
            <li>
              Your install’s random ID, made once on your computer and shared by every DorkOS
              telemetry channel.
            </li>
            <li>The DorkOS version (so we can spot version-specific install regressions).</li>
          </ul>
        </div>

        <div className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">How to turn it off</h2>
          <p className="text-warm-gray text-base leading-relaxed">
            Install counts are off until you turn them on, and anonymous unless you link usage data
            to your account. Turn them on or back off any time: run{' '}
            <span className="text-charcoal font-mono">
              dorkos telemetry enable --channel install
            </span>{' '}
            or{' '}
            <span className="text-charcoal font-mono">
              dorkos telemetry disable --channel install
            </span>
            , or use the Privacy and Data tab in DorkOS settings. Setting the environment variable{' '}
            <span className="text-charcoal font-mono">DO_NOT_TRACK=1</span> keeps install counts and
            every other telemetry channel off, no matter what the settings say.
          </p>
        </div>

        <div className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">Open source pipeline</h2>
          <p className="text-warm-gray text-base leading-relaxed">
            Both the client-side reporter and the receiving Edge Function live in the public DorkOS
            repo. You can audit exactly what gets sent.
          </p>
        </div>

        <p className="text-warm-gray text-base leading-relaxed">
          <Link href="/marketplace" className="text-charcoal hover:text-brand-orange underline">
            Back to the marketplace
          </Link>
        </p>
      </section>
    </main>
  );
}

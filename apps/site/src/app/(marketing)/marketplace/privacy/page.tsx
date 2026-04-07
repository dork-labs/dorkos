import type { Metadata } from 'next';
import Link from 'next/link';
import { siteConfig } from '@/config/site';

export const metadata: Metadata = {
  title: 'Marketplace privacy — DorkOS',
  description:
    'How DorkOS handles install telemetry. Opt-in. No PII. Anonymous install IDs. Open source pipeline.',
  alternates: { canonical: '/marketplace/privacy' },
  openGraph: {
    title: 'Marketplace privacy — DorkOS',
    description: 'How DorkOS handles install telemetry — opt-in, no PII, anonymous IDs.',
    url: '/marketplace/privacy',
    siteName: siteConfig.name,
  },
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
              <strong className="text-charcoal font-semibold">No IP addresses logged.</strong>
            </li>
            <li>
              <strong className="text-charcoal font-semibold">No user identifiers</strong> — only
              random per-install UUIDs (one per install, not per user).
            </li>
            <li>
              <strong className="text-charcoal font-semibold">
                No package contents transmitted.
              </strong>
            </li>
            <li>
              <strong className="text-charcoal font-semibold">Opt-in.</strong> Disabled by default.
              You enable it explicitly in DorkOS settings.
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
          <h2 className="text-charcoal font-mono text-xl font-semibold">
            What we collect when you opt in
          </h2>
          <ul className="text-warm-gray ml-5 list-disc space-y-2 text-base leading-relaxed">
            <li>The package name and marketplace it came from.</li>
            <li>The package type (agent, plugin, skill-pack, adapter).</li>
            <li>The install outcome (success, failure, cancelled).</li>
            <li>How long the install took (for performance debugging).</li>
            <li>An error code on failure (so we can fix what is breaking).</li>
            <li>A random install ID generated locally per install.</li>
            <li>The DorkOS version (so we can spot version-specific install regressions).</li>
          </ul>
        </div>

        <div className="space-y-4">
          <h2 className="text-charcoal font-mono text-xl font-semibold">How to opt in (or out)</h2>
          <p className="text-warm-gray text-base leading-relaxed">
            The toggle lives in DorkOS settings. The default is off. The DorkOS client never reports
            telemetry until you flip the switch.
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

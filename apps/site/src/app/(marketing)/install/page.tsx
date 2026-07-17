import type { Metadata } from 'next';
import Link from 'next/link';

import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import { MarketingChrome } from '@/layers/features/marketing';
import { DownloadButton, InstallCommand } from './_components/InstallPageActions';

const CURL_COMMAND = 'curl -fsSL https://dorkos.ai/install | bash';

export const metadata: Metadata = {
  title: 'Install DorkOS',
  description:
    'Every way to install DorkOS: the Mac app, a one-line terminal install, npm, the Windows early alpha, and Docker for servers.',
  alternates: { canonical: '/install', types: rssFeedAlternateTypes },
  openGraph: {
    title: 'Install DorkOS',
    description:
      'Every way to install DorkOS: the Mac app, a one-line terminal install, npm, the Windows early alpha, and Docker for servers.',
    url: '/install',
    siteName: siteConfig.name,
    // No explicit `images`: the co-located opengraph-image.tsx auto-attaches to
    // both Open Graph and Twitter (Next only skips it when a route sets its own
    // images), so the install-specific card wins over the root fallback.
  },
  twitter: twitterFromOpenGraph({
    title: 'Install DorkOS',
    description:
      'Every way to install DorkOS: the Mac app, a one-line terminal install, npm, the Windows early alpha, and Docker for servers.',
  }),
};

/** Mono uppercase section kicker used above each install option. */
function SectionKicker({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-2xs text-brand-orange mb-3 font-mono tracking-[0.15em] uppercase">
      {children}
    </p>
  );
}

/**
 * `/install` — the canonical install page. Every install path in one place:
 * desktop apps, the terminal one-liner, npm, and Docker, plus how to update.
 * The same URL doubles as the install script for CLI clients — `src/proxy.ts`
 * rewrites non-browser requests to `/install.sh`.
 */
export default function InstallPage() {
  return (
    <MarketingChrome>
      <main className="mx-auto max-w-2xl px-6 pt-32 pb-24">
        <p className="text-2xs text-brand-orange mb-4 font-mono tracking-[0.15em] uppercase">
          Get started
        </p>
        <h1 className="text-charcoal font-mono text-3xl font-bold tracking-tight sm:text-4xl">
          Install DorkOS
        </h1>
        <p className="text-warm-gray mt-4 text-lg">
          Every path below sets up the same DorkOS on your machine. Pick the one that fits how you
          work.
        </p>

        <div className="mt-12 space-y-12">
          {/* Mac app */}
          <section id="mac">
            <SectionKicker>Mac app</SectionKicker>
            <DownloadButton href="/download/mac" placement="install_page">
              Download for Mac
            </DownloadButton>
            <p className="text-warm-gray-light mt-3 font-mono text-xs tracking-[0.02em]">
              Apple Silicon · no terminal needed
            </p>
            <p className="text-warm-gray mt-3 text-sm">
              On an Intel Mac? Use the{' '}
              <a href="#terminal" className="text-charcoal hover:text-brand-orange underline">
                terminal install
              </a>{' '}
              below.{' '}
              <Link
                href="/docs/getting-started/desktop-app"
                className="text-charcoal hover:text-brand-orange underline"
              >
                What you get
              </Link>
              .
            </p>
          </section>

          {/* Terminal one-liner */}
          <section id="terminal">
            <SectionKicker>Terminal · recommended</SectionKicker>
            <InstallCommand command={CURL_COMMAND} method="curl" />
            <p className="text-warm-gray mt-3 text-sm">
              One command. It checks Node.js, installs DorkOS via npm, and offers a setup wizard.
              Works on macOS and Linux.
            </p>
          </section>

          {/* npm */}
          <section id="npm">
            <SectionKicker>npm</SectionKicker>
            <InstallCommand command="npm install -g dorkos" method="npm" />
            <p className="text-warm-gray mt-3 text-sm">
              Already have Node.js 22 or newer? Install straight from npm. Works everywhere Node
              runs, including Windows.
            </p>
          </section>

          {/* Windows app */}
          <section id="windows">
            <SectionKicker>Windows app · early alpha</SectionKicker>
            <DownloadButton href="/download/windows" placement="windows_install_page">
              Download for Windows
              <span className="text-cream-white rounded-sm bg-white/[0.18] px-1.5 py-0.5 text-[9px] tracking-[0.1em] uppercase">
                alpha
              </span>
            </DownloadButton>
            <p className="text-warm-gray-light mt-3 font-mono text-xs tracking-[0.02em]">
              Windows x64 · unsigned early alpha · SmartScreen may warn on first launch
            </p>
            <p className="text-warm-gray mt-3 text-sm">
              Want something proven today? The{' '}
              <a href="#npm" className="text-charcoal hover:text-brand-orange underline">
                npm install
              </a>{' '}
              works on Windows now.
            </p>
          </section>

          {/* Docker / servers */}
          <section id="docker">
            <SectionKicker>Docker and servers</SectionKicker>
            <p className="text-warm-gray text-sm">
              Running DorkOS somewhere other than your own machine?{' '}
              <Link
                href="/docs/self-hosting/docker"
                className="text-charcoal hover:text-brand-orange underline"
              >
                Run it in Docker
              </Link>
              .
            </p>
          </section>

          {/* Updating */}
          <section id="update">
            <SectionKicker>Already running DorkOS?</SectionKicker>
            <InstallCommand command="npm install -g dorkos@latest" method="npm" />
            <p className="text-warm-gray mt-3 text-sm">
              One command updates a terminal install. The desktop app can update itself: choose
              Check for Updates from the app menu.
            </p>
          </section>
        </div>

        <p className="text-warm-gray-light mt-16 text-sm">
          New here? Start with the{' '}
          <Link
            href="/docs/getting-started/quickstart"
            className="text-charcoal hover:text-brand-orange underline"
          >
            quickstart
          </Link>
          .
        </p>
      </main>
    </MarketingChrome>
  );
}

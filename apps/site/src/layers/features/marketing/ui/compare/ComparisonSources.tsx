import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import type { Competitor } from '../../lib/comparisons';

/** Render an ISO date as a plain English day, in UTC so it never shifts. */
function formatVerifiedDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** Show a link by its site, not its full address. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * The freshness stamp and the reading list. These products change every month,
 * so the page says when someone last checked and where the facts came from.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonSources({ competitor }: { competitor: Competitor }) {
  return (
    <section
      aria-labelledby="how-we-checked"
      className="border-warm-gray-light/30 mt-16 border-t pt-8"
    >
      <h2
        id="how-we-checked"
        className="text-2xs text-warm-gray-light font-mono tracking-[0.12em] uppercase"
      >
        How we checked
      </h2>
      <p className="text-warm-gray mt-3 text-sm leading-relaxed">
        We last checked these facts on {formatVerifiedDate(competitor.lastVerified)}. Tools in this
        space change fast. If something here is out of date,{' '}
        <Link href="/feedback" className="text-brand-orange hover:text-charcoal transition-smooth">
          tell us
        </Link>{' '}
        and we will fix it.
      </p>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
        {competitor.sources.map((source) => (
          <li key={source}>
            <a
              href={source}
              target="_blank"
              rel="noopener noreferrer"
              className="text-warm-gray-light hover:text-brand-orange transition-smooth inline-flex items-center gap-1 font-mono text-xs"
            >
              {hostOf(source)} <ExternalLink size={10} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

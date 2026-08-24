import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { COMPARISON_FRAMING_COPY, type Competitor } from '../../lib/comparisons';

/**
 * One card on the /compare hub: the page's own headline, what the product is,
 * and the one-line summary of how it stacks up.
 *
 * @param competitor - The product the card links to.
 */
export function CompetitorCard({ competitor }: { competitor: Competitor }) {
  const copy = COMPARISON_FRAMING_COPY[competitor.framing];

  return (
    <Link
      href={`/compare/${competitor.slug}`}
      className="border-warm-gray-light/30 hover:border-brand-orange/40 transition-smooth group flex flex-col rounded-lg border p-6"
    >
      <span className="text-2xs text-warm-gray-light font-mono tracking-[0.12em] uppercase">
        {competitor.category}
      </span>
      <span className="text-charcoal group-hover:text-brand-orange transition-smooth mt-2 font-mono text-lg font-bold tracking-tight">
        {copy.headline(competitor.name)}
      </span>
      <span className="text-warm-gray mt-3 text-sm leading-relaxed">{competitor.oneLiner}</span>
      <span className="text-2xs text-warm-gray-light mt-4 inline-flex items-center gap-1 font-mono tracking-[0.04em]">
        Read the comparison <ArrowRight size={10} />
      </span>
    </Link>
  );
}

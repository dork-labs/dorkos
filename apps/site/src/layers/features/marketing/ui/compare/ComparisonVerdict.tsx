import { ExternalLink } from 'lucide-react';
import type { Competitor } from '../../lib/comparisons';

/** One labelled fact in the summary row under the verdict. */
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-2xs text-warm-gray-light font-mono tracking-[0.12em] uppercase">
        {label}
      </dt>
      <dd className="text-charcoal mt-1 text-sm leading-relaxed">{value}</dd>
    </div>
  );
}

/**
 * The verdict box that leads a comparison page: the honest short answer, then
 * the plain facts (who makes it, what it is, what it costs, whether you can
 * read its code).
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonVerdict({ competitor }: { competitor: Competitor }) {
  return (
    <section
      aria-labelledby="short-answer"
      className="border-warm-gray-light/30 bg-cream-secondary rounded-lg border p-6 md:p-8"
    >
      <h2
        id="short-answer"
        className="text-2xs text-brand-orange font-mono tracking-[0.2em] uppercase"
      >
        The short answer
      </h2>
      <p className="text-warm-gray mt-4 text-lg leading-relaxed">{competitor.verdict}</p>

      <dl className="border-warm-gray-light/30 mt-8 grid grid-cols-1 gap-6 border-t pt-6 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Made by" value={competitor.maker} />
        <Fact label="What it is" value={competitor.category} />
        <Fact label="Price" value={competitor.pricing} />
        <Fact
          label="Source code"
          value={competitor.openSource ? 'Open, you can read it' : 'Closed, you cannot read it'}
        />
      </dl>

      <a
        href={competitor.homepage}
        target="_blank"
        rel="noopener noreferrer"
        className="text-warm-gray-light hover:text-brand-orange transition-smooth mt-6 inline-flex items-center gap-1 font-mono text-xs"
      >
        See {competitor.name} for yourself <ExternalLink size={10} />
      </a>
    </section>
  );
}

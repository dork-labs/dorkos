import type { Competitor } from '../../lib/comparisons';

/**
 * The questions people actually ask about these two products, answered in the
 * open. Every answer is on the page, not hidden behind a click, because that is
 * what readers and AI answer engines both pick up.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonFaq({ competitor }: { competitor: Competitor }) {
  return (
    <section aria-labelledby="questions" className="mt-16">
      <h2 id="questions" className="text-charcoal font-mono text-2xl font-bold tracking-tight">
        Questions people ask
      </h2>
      <dl className="mt-6 space-y-8">
        {competitor.faq.map((entry) => (
          <div key={entry.q}>
            <dt className="text-charcoal font-mono text-base font-semibold">{entry.q}</dt>
            <dd className="text-warm-gray mt-2 text-base leading-relaxed">{entry.a}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

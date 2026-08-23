import { CheckCircle } from 'lucide-react';
import { COMPARISON_FRAMING_COPY, dorkosAdvantages, type Competitor } from '../../lib/comparisons';

/** A titled list of reasons to pick one of the two products. */
function Column({ title, reasons }: { title: string; reasons: string[] }) {
  return (
    <div className="border-warm-gray-light/30 rounded-lg border p-6">
      <h3 className="text-charcoal font-mono text-base font-semibold">{title}</h3>
      {reasons.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-3">
              <CheckCircle size={16} className="text-brand-orange mt-1 shrink-0" strokeWidth={2} />
              <span className="text-warm-gray text-sm leading-relaxed">{reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-warm-gray-light mt-4 text-sm leading-relaxed">
          Nothing on this list right now. The table below has the full picture.
        </p>
      )}
    </div>
  );
}

/**
 * The two recommendation columns: when to reach for the other product, and when
 * to reach for DorkOS. Their side is written by the person who checked the
 * facts — an honest concession on a head-to-head page, a compliment on a runtime
 * page. The DorkOS side is derived from the dimensions DorkOS fully delivers and
 * they do not, so it can never overclaim.
 *
 * Renders nothing when the other product has no strengths listed, which is the
 * case for a product that has shut down.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonAudience({ competitor }: { competitor: Competitor }) {
  const copy = COMPARISON_FRAMING_COPY[competitor.framing];
  const theirStrengths = competitor.theirStrengths ?? [];
  if (theirStrengths.length === 0) return null;

  // Just the reason here: the table below carries what DorkOS actually does
  // about it, and repeating that sentence twice on one page helps nobody.
  const ourReasons = dorkosAdvantages(competitor).map(
    (dimension) => `you want ${dimension.wantPhrase}`
  );

  return (
    <section aria-labelledby="which-one" className="mt-16">
      <h2 id="which-one" className="text-charcoal font-mono text-2xl font-bold tracking-tight">
        {copy.recommendationHeading}
      </h2>
      {/* Their column reads first everywhere here: the concession before the
          pitch on a head-to-head page, the engine before what wraps it on a
          runtime page. */}
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <Column title={copy.theirReasonHeading(competitor.name)} reasons={theirStrengths} />
        <Column title={copy.ourReasonHeading} reasons={ourReasons} />
      </div>
    </section>
  );
}

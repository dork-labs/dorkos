import { CheckCircle } from 'lucide-react';
import { dorkosAdvantages, dorkosCellFor, type Competitor } from '../../lib/comparisons';

/** One reason to pick a product: the reason itself, and an optional detail line. */
interface Reason {
  text: string;
  detail?: string;
}

/** A titled list of reasons to pick one of the two products. */
function Column({ title, reasons }: { title: string; reasons: Reason[] }) {
  return (
    <div className="border-warm-gray-light/30 rounded-lg border p-6">
      <h3 className="text-charcoal font-mono text-base font-semibold">{title}</h3>
      {reasons.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {reasons.map((reason) => (
            <li key={reason.text} className="flex items-start gap-3">
              <CheckCircle size={16} className="text-brand-orange mt-1 shrink-0" strokeWidth={2} />
              <span>
                <span className="text-warm-gray block text-sm leading-relaxed">{reason.text}</span>
                {reason.detail && (
                  <span className="text-warm-gray-light mt-1 block text-xs leading-relaxed">
                    {reason.detail}
                  </span>
                )}
              </span>
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
 * The two honest recommendation columns: why you might pick the other product,
 * and why you might pick DorkOS. Their side is written by the person who checked
 * the facts; the DorkOS side is derived from the dimensions DorkOS fully
 * delivers and they do not, so it can never overclaim.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonAudience({ competitor }: { competitor: Competitor }) {
  const ourReasons: Reason[] = dorkosAdvantages(competitor).map((dimension) => ({
    text: `you want ${dimension.label.toLowerCase()}`,
    detail: dorkosCellFor(dimension).note,
  }));
  const theirReasons: Reason[] = competitor.theirStrengths.map((strength) => ({ text: strength }));

  return (
    <section aria-labelledby="which-one" className="mt-16">
      <h2 id="which-one" className="text-charcoal font-mono text-2xl font-bold tracking-tight">
        Which one is for you
      </h2>
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
        <Column title={`Use ${competitor.name} if`} reasons={theirReasons} />
        <Column title="Use DorkOS if" reasons={ourReasons} />
      </div>
    </section>
  );
}

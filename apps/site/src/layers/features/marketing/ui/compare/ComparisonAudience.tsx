import { CheckCircle } from 'lucide-react';
import { COMPARISON_FRAMING_COPY, dorkosAdvantages, type Competitor } from '../../lib/comparisons';

/** Which side a recommendation column speaks for, which is what colours its ticks. */
type ColumnSide = 'dorkos' | 'theirs';

/**
 * Tick colour per side. Green reads as "this is ours" at a glance, and the
 * other product keeps the page's ordinary accent rather than a second signal
 * colour that would look like a verdict on it.
 */
const TICK_CLASS: Record<ColumnSide, string> = {
  dorkos: 'text-brand-green',
  theirs: 'text-brand-orange',
};

/** A titled list of reasons to pick one of the two products. */
function Column({ title, reasons, side }: { title: string; reasons: string[]; side: ColumnSide }) {
  return (
    <div className="border-warm-gray-light/30 rounded-lg border p-6">
      <h3 className="text-charcoal font-mono text-base font-semibold">{title}</h3>
      {reasons.length > 0 ? (
        <ul className="mt-4 space-y-3">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-3">
              <CheckCircle
                size={16}
                className={`mt-1 shrink-0 ${TICK_CLASS[side]}`}
                strokeWidth={2}
              />
              <span className="text-warm-gray text-sm leading-relaxed">{reason}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-warm-gray mt-4 text-sm leading-relaxed">
          Nothing on this list right now. The table below has the full picture.
        </p>
      )}
    </div>
  );
}

/**
 * The two recommendation columns: when to reach for DorkOS, and when to reach
 * for the other product. The DorkOS side is derived from the dimensions DorkOS
 * fully delivers and they do not, so it can never overclaim. Their side is
 * written by the person who checked the facts — an honest concession on a
 * head-to-head page, a compliment on a runtime page.
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
      {/* DorkOS reads first in every framing, on the phone stack and the desktop
          grid alike: this is our page, and the answer it exists to give belongs
          at the top rather than after a paragraph about someone else. The table
          below still leads with the engine on a runtime page, where the
          before-and-after ordering is the point. */}
      {/* Each column ends where its own list ends. DorkOS's side is derived, so
          it is honestly shorter on most pages, and stretching it to match theirs
          left a panel of dead space that read as a weak answer rather than a
          short one. */}
      <div className="mt-6 grid grid-cols-1 items-start gap-6 md:grid-cols-2">
        <Column title={copy.ourReasonHeading} reasons={ourReasons} side="dorkos" />
        <Column
          title={copy.theirReasonHeading(competitor.name)}
          reasons={theirStrengths}
          side="theirs"
        />
      </div>
    </section>
  );
}

import Link from 'next/link';
import {
  COMPARISON_DIMENSIONS,
  COMPARISON_FRAMING_COPY,
  dorkosCellFor,
  type ComparisonCell,
  type Competitor,
} from '../../lib/comparisons';
import { VerdictMark } from './VerdictMark';

/** One product's longer answer under a criterion heading. */
function Side({
  label,
  detail,
  verdict,
}: {
  label: string;
  detail: string;
  verdict: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-charcoal font-mono text-sm font-semibold">{label}</span>
        {verdict}
      </div>
      <p className="text-warm-gray mt-2 text-sm leading-relaxed">{detail}</p>
    </div>
  );
}

/**
 * The deeper read on the points that have more to them than one table line.
 *
 * Only dimensions where at least one side wrote a `detail` get a section, so
 * this never repeats the table back at the reader. Renders nothing when no
 * dimension has one.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonCriteria({ competitor }: { competitor: Competitor }) {
  const copy = COMPARISON_FRAMING_COPY[competitor.framing];
  const sections = COMPARISON_DIMENSIONS.map((dimension) => ({
    dimension,
    ours: dorkosCellFor(dimension),
    theirs: competitor.cells[dimension.id] as ComparisonCell | undefined,
  })).filter((section) => section.ours.detail ?? section.theirs?.detail);

  if (sections.length === 0) return null;

  return (
    <div className="mt-16 space-y-12">
      {sections.map(({ dimension, ours, theirs }) => {
        const ourSide = ours.detail ? (
          <Side
            key="ours"
            label={copy.ourColumn}
            detail={ours.detail}
            verdict={<VerdictMark verdict={ours.verdict} />}
          />
        ) : null;
        const theirSide = theirs?.detail ? (
          <Side
            key="theirs"
            label={copy.theirColumn(competitor.name)}
            detail={theirs.detail}
            verdict={<VerdictMark verdict={theirs.verdict} />}
          />
        ) : null;

        return (
          <section key={dimension.id} aria-labelledby={`criterion-${dimension.id}`}>
            <h2
              id={`criterion-${dimension.id}`}
              className="text-charcoal font-mono text-2xl font-bold tracking-tight"
            >
              {dimension.label}
            </h2>
            {/* The question itself stays in the table row this links back to;
                printing it again here would say the same thing twice. */}
            <div className="border-warm-gray-light/30 mt-6 grid grid-cols-1 gap-6 border-l-2 pl-6 md:grid-cols-2">
              {copy.theirColumnFirst ? [theirSide, ourSide] : [ourSide, theirSide]}
            </div>
            <Link
              href={`#row-${dimension.id}`}
              className="text-warm-gray-light hover:text-brand-orange transition-smooth mt-4 inline-block font-mono text-xs underline underline-offset-2"
            >
              Back to the table
            </Link>
          </section>
        );
      })}
    </div>
  );
}

import {
  COMPARISON_DIMENSIONS,
  COMPARISON_FRAMING_COPY,
  dorkosCellFor,
  type Competitor,
} from '../../lib/comparisons';
import { VerdictMark } from './VerdictMark';

/** One product's answer under a criterion heading. */
function Side({ label, note, verdict }: { label: string; note: string; verdict: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-charcoal font-mono text-sm font-semibold">{label}</span>
        {verdict}
      </div>
      <p className="text-warm-gray mt-2 text-sm leading-relaxed">{note}</p>
    </div>
  );
}

/**
 * One section per comparison point, so a reader can go deeper than the table:
 * the question in plain words, then what each product actually does about it.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonCriteria({ competitor }: { competitor: Competitor }) {
  const copy = COMPARISON_FRAMING_COPY[competitor.framing];

  return (
    <div className="mt-16 space-y-12">
      {COMPARISON_DIMENSIONS.map((dimension) => {
        const ours = dorkosCellFor(dimension);
        const theirs = competitor.cells[dimension.id];
        return (
          <section key={dimension.id} aria-labelledby={`criterion-${dimension.id}`}>
            <h2
              id={`criterion-${dimension.id}`}
              className="text-charcoal font-mono text-2xl font-bold tracking-tight"
            >
              {dimension.label}
            </h2>
            <p className="text-warm-gray-light mt-2 text-base leading-relaxed">
              {dimension.question}
            </p>
            <div className="border-warm-gray-light/30 mt-6 grid grid-cols-1 gap-6 border-l-2 pl-6 md:grid-cols-2">
              <Side
                label={copy.ourColumn}
                note={ours.note}
                verdict={<VerdictMark verdict={ours.verdict} />}
              />
              {theirs && (
                <Side
                  label={copy.theirColumn(competitor.name)}
                  note={theirs.note}
                  verdict={<VerdictMark verdict={theirs.verdict} />}
                />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

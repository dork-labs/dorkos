import Link from 'next/link';
import { features } from '../../lib/features';
import {
  COMPARISON_DIMENSIONS,
  COMPARISON_FRAMING_COPY,
  dorkosCellFor,
  type Competitor,
} from '../../lib/comparisons';
import { HorizontalScrollFrame } from './HorizontalScrollFrame';
import { VerdictMark } from './VerdictMark';

/** Links to the feature pages that back DorkOS's answer on one dimension. */
function BackingFeatureLinks({ slugs }: { slugs: string[] }) {
  const backing = slugs
    .map((slug) => features.find((feature) => feature.slug === slug))
    .filter((feature) => feature !== undefined);

  return (
    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
      {backing.map((feature) => (
        <Link
          key={feature.slug}
          href={`/features/${feature.slug}`}
          className="text-warm-gray hover:text-brand-orange transition-smooth font-mono text-xs underline underline-offset-2"
        >
          {feature.name}
        </Link>
      ))}
    </span>
  );
}

/**
 * The side-by-side dimension table. DorkOS's column is derived from the feature
 * catalog and links to the feature pages behind each answer; the other product's
 * column links to the source backing any yes or partly. Scrolls sideways on a
 * phone instead of squashing the columns.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonTable({ competitor }: { competitor: Competitor }) {
  const copy = COMPARISON_FRAMING_COPY[competitor.framing];
  const columnHeaders = copy.theirColumnFirst
    ? [copy.theirColumn(competitor.name), copy.ourColumn]
    : [copy.ourColumn, copy.theirColumn(competitor.name)];

  return (
    <section aria-labelledby="side-by-side" className="mt-16">
      <h2 id="side-by-side" className="text-charcoal font-mono text-2xl font-bold tracking-tight">
        {copy.tableHeading}
      </h2>

      <HorizontalScrollFrame className="border-warm-gray-light/30 mt-6 overflow-x-auto rounded-lg border">
        {/* Fixed layout so the pinned label column keeps the width it is given:
            auto layout hands it a third of the table and leaves a phone almost
            no room for the column it labels. */}
        <table className="w-full min-w-[40rem] table-fixed border-collapse text-left sm:min-w-[46rem]">
          <thead>
            <tr className="border-warm-gray-light/30 bg-cream-secondary border-b">
              {/* Under fixed layout the first row sets every column width, so
                  the label column's width has to be declared here. Narrower on a
                  phone: a wide pinned label leaves no room for the column it
                  labels. */}
              <th
                scope="col"
                className="text-2xs text-warm-gray bg-cream-secondary sticky left-0 z-20 w-36 p-4 font-mono tracking-[0.12em] uppercase sm:w-56"
              >
                What you get
              </th>
              {columnHeaders.map((header) => (
                <th
                  key={header}
                  scope="col"
                  className="text-2xs text-charcoal p-4 font-mono tracking-[0.12em] uppercase"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARISON_DIMENSIONS.map((dimension) => {
              const ours = dorkosCellFor(dimension);
              const theirs = competitor.cells[dimension.id];
              const hasDetail = Boolean(ours.detail ?? theirs?.detail);
              const ourCell = (
                <td key="ours" className="w-1/3 p-4 align-top">
                  <VerdictMark verdict={ours.verdict} />
                  <span className="text-warm-gray mt-2 block text-sm leading-relaxed">
                    {ours.note}
                  </span>
                  <BackingFeatureLinks slugs={dimension.featureSlugs} />
                  {/* Lives in the cell, not the row header: a row header is the
                      row's accessible name, and a link inside it reads out with
                      every cell in the row. */}
                  {hasDetail && (
                    <Link
                      href={`#criterion-${dimension.id}`}
                      className="text-warm-gray hover:text-brand-orange transition-smooth mt-3 inline-block font-mono text-xs underline underline-offset-2"
                    >
                      More on {dimension.label.toLowerCase()}
                    </Link>
                  )}
                </td>
              );
              const theirCell = (
                <td key="theirs" className="w-1/3 p-4 align-top">
                  {theirs ? (
                    <>
                      <VerdictMark verdict={theirs.verdict} />
                      <span className="text-warm-gray mt-2 block text-sm leading-relaxed">
                        {theirs.note}
                      </span>
                      {theirs.source && (
                        <a
                          href={theirs.source}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-warm-gray hover:text-brand-orange transition-smooth mt-2 inline-block font-mono text-xs underline underline-offset-2"
                        >
                          Where this comes from
                        </a>
                      )}
                    </>
                  ) : (
                    <span className="text-warm-gray text-sm">Not checked yet.</span>
                  )}
                </td>
              );
              return (
                <tr key={dimension.id} className="border-warm-gray-light/20 border-b last:border-0">
                  <th
                    scope="row"
                    // Narrower where it is pinned over a small screen: a 224px
                    // label on a 340px scroller leaves almost no room for the
                    // column it is meant to label.
                    className="bg-cream-primary border-warm-gray-light/30 sticky left-0 z-10 w-36 border-r p-4 align-top sm:w-56"
                  >
                    {/* The anchor sits inside the row's leftmost cell. Inside,
                        because browsers ignore scroll-margin on a table cell and
                        the jump would land under the fixed header; leftmost,
                        because a target further right drags this frame sideways
                        and hides the label the reader came back for. */}
                    <span id={`row-${dimension.id}`} className="block scroll-mt-24" />
                    <span className="text-charcoal block font-mono text-sm font-semibold">
                      {dimension.label}
                    </span>
                    <span className="text-warm-gray mt-1 block text-xs leading-relaxed">
                      {dimension.question}
                    </span>
                  </th>
                  {copy.theirColumnFirst ? [theirCell, ourCell] : [ourCell, theirCell]}
                </tr>
              );
            })}
          </tbody>
        </table>
      </HorizontalScrollFrame>
    </section>
  );
}

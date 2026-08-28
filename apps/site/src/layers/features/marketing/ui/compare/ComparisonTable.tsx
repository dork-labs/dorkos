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

/** Names the side a cell belongs to, for the stacked layout where no column header is on screen. */
function CellHeading({ children }: { children: string }) {
  return (
    <span className="text-2xs text-charcoal mb-2 block font-mono tracking-[0.12em] uppercase sm:hidden">
      {children}
    </span>
  );
}

/**
 * The side-by-side dimension table. DorkOS's column is derived from the feature
 * catalog and links to the feature pages behind each answer; the other product's
 * column links to the source backing any yes or partly.
 *
 * Below `sm` the same markup reflows into one stacked block per dimension, each
 * cell labelled with the side it belongs to. Three columns cannot be read on a
 * phone at any scroll position — a pinned label wide enough to be useful leaves
 * less room than a column needs — so the columns stack rather than truncate.
 * The reflow costs less than it looks: Chromium still exposes the table, its
 * rows and its row headers at that width, and only the column-header and
 * row-group roles drop, which is what the per-cell headings replace.
 *
 * @param competitor - The product this page compares against.
 */
export function ComparisonTable({ competitor }: { competitor: Competitor }) {
  const copy = COMPARISON_FRAMING_COPY[competitor.framing];
  const ourHeader = copy.ourColumn;
  const theirHeader = copy.theirColumn(competitor.name);
  const columnHeaders = copy.theirColumnFirst ? [theirHeader, ourHeader] : [ourHeader, theirHeader];

  return (
    <section aria-labelledby="side-by-side" className="mt-16">
      <h2 id="side-by-side" className="text-charcoal font-mono text-2xl font-bold tracking-tight">
        {copy.tableHeading}
      </h2>

      <HorizontalScrollFrame className="border-warm-gray-light/30 mt-6 overflow-x-auto rounded-lg border">
        {/* A block below sm — no min-width, so nothing overflows and every cell
            is fully readable without scrolling. From sm up it is a real table
            with fixed layout, so the pinned label column keeps the width it is
            given instead of being handed a third of the table. */}
        <table className="block w-full border-collapse text-left sm:table sm:min-w-[46rem] sm:table-fixed">
          <thead className="hidden sm:table-header-group">
            <tr className="border-warm-gray-light/30 bg-cream-secondary border-b">
              {/* Under fixed layout the first row sets every column width, so
                  the label column's width has to be declared here. Narrower on a
                  phone: a wide pinned label leaves no room for the column it
                  labels. */}
              <th
                scope="col"
                className="text-2xs text-warm-gray bg-cream-secondary sticky left-0 z-20 w-56 p-4 font-mono tracking-[0.12em] uppercase"
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
          <tbody className="block sm:table-row-group">
            {COMPARISON_DIMENSIONS.map((dimension) => {
              const ours = dorkosCellFor(dimension);
              const theirs = competitor.cells[dimension.id];
              const hasDetail = Boolean(ours.detail ?? theirs?.detail);
              const ourCell = (
                <td
                  key="ours"
                  className="block w-full px-4 pb-4 align-top sm:table-cell sm:w-auto sm:p-4"
                >
                  <CellHeading>{ourHeader}</CellHeading>
                  <VerdictMark verdict={ours.verdict} />
                  <span className="text-warm-gray mt-2 block text-sm leading-relaxed">
                    {ours.note}
                  </span>
                  <BackingFeatureLinks slugs={dimension.featureSlugs} />
                  {/* Lives in the cell, not the row header: a row header is the
                      row's accessible name, and a link inside it reads out with
                      every cell in the row. The visible text stays short; the
                      dimension goes in the label so each link is still distinct
                      to a screen reader. */}
                  {hasDetail && (
                    <Link
                      href={`#criterion-${dimension.id}`}
                      aria-label={`More on ${dimension.label.toLowerCase()}`}
                      className="text-warm-gray hover:text-brand-orange transition-smooth mt-3 inline-block font-mono text-xs underline underline-offset-2"
                    >
                      More on this
                    </Link>
                  )}
                </td>
              );
              const theirCell = (
                <td
                  key="theirs"
                  className="block w-full px-4 pb-4 align-top sm:table-cell sm:w-auto sm:p-4"
                >
                  <CellHeading>{theirHeader}</CellHeading>
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
                <tr
                  key={dimension.id}
                  className="border-warm-gray-light/20 block border-b last:border-0 sm:table-row"
                >
                  {/* Pinned only from sm up, where there is room for it beside a
                      full column. Below that it is the stacked block's heading. */}
                  <th
                    scope="row"
                    className="bg-cream-secondary border-warm-gray-light/30 sm:bg-cream-primary block w-full p-4 text-left align-top sm:sticky sm:left-0 sm:z-10 sm:table-cell sm:w-56 sm:border-r"
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

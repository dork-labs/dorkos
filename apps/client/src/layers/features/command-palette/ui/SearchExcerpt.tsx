/**
 * A search excerpt with its matched words drawn out (spec `message-search` §8).
 *
 * @module features/command-palette/ui/SearchExcerpt
 */
import { splitExcerpt } from '../model/search-excerpt';

/** Props for {@link SearchExcerpt}. */
export interface SearchExcerptProps {
  /** `SearchHit.excerpt`, as the route returned it. Text, never HTML. */
  excerpt: string;
  className?: string;
}

/**
 * Render an excerpt, emphasising the words that matched.
 *
 * **Safe by construction, and that is the whole design.** Every run goes
 * through React's `createElement` pipeline as a string child, so it is escaped
 * whatever is in it — an excerpt carrying `<script>` renders the eleven
 * characters somebody typed and creates no element. There is deliberately no
 * `dangerouslySetInnerHTML` anywhere on this path to get wrong later; the marks
 * are parsed out in `model/search-excerpt` and re-applied as real elements.
 *
 * The mark styling matches `HighlightedText`, which draws ⌘K's own matches:
 * weight and colour rather than a highlighter block, because a dense list of
 * rows with yellow bars through it is harder to read, not easier.
 */
export function SearchExcerpt({ excerpt, className }: SearchExcerptProps) {
  const runs = splitExcerpt(excerpt);

  return (
    <span className={className}>
      {runs.map((run, i) =>
        run.matched ? (
          <mark key={i} className="text-foreground bg-transparent font-semibold">
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        )
      )}
    </span>
  );
}

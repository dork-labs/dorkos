/**
 * Running a message search from a box somebody is still typing in (spec
 * `message-search` §8, Amendment 1).
 *
 * Two rules come from the server rather than from taste, and both are imported
 * rather than written down again here:
 *
 * - **{@link SEARCH_DEBOUNCE_MS}.** The server cannot enforce it — it sees
 *   requests, not keystrokes — so it publishes the number and every caller
 *   holds to it. Without it, typing `dogs` fires four ranked queries and throws
 *   three away.
 * - **{@link SEARCH_MIN_QUERY_LENGTH}, counted over {@link searchTokens}.** A
 *   one-letter query is certainly useless and certainly expensive, so the route
 *   refuses it with a 400. This gate is the same check on this side of the
 *   wire: a box that fires on the first letter and swallows the refusal still
 *   paid for the request. Counting over the TOKENS rather than the raw string
 *   is what makes it a floor — `a,` and `  a ` are two characters and one
 *   letter of search, and both were 200s while this was a length check.
 *
 * The server's refusal is still handled, because a client-side gate is a
 * courtesy and never a guarantee: the floor could move, and a box that renders
 * a 400 as a crash would be the surface reporting a bug in itself.
 *
 * @module features/command-palette/model/use-message-search
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SEARCH_DEBOUNCE_MS,
  SEARCH_MIN_QUERY_LENGTH,
  searchTokens,
  type SearchHit,
  type SearchSourceWarning,
} from '@dorkos/shared/search-schemas';
import { useTransport } from '@/layers/shared/model';

/** How long a result stays fresh before a reopened box asks again. */
const SEARCH_STALE_MS = 30_000;

/**
 * The query key every message search is cached under.
 *
 * Module-private: nothing else reads or invalidates a search. The index is
 * derived and the box asks again on the next keystroke, so there is no mutation
 * anywhere that would need to reach in here.
 */
const searchKey = (q: string) => ['message-search', q] as const;

/**
 * Whether a query has a word long enough to search on.
 *
 * The same predicate `SearchQuerySchema` applies, reached through the same
 * tokenizer, so this side and the route cannot disagree about what counts as
 * two characters.
 *
 * @param raw - What is in the box.
 */
function isSearchable(raw: string): boolean {
  return searchTokens(raw).some((token) => token.length >= SEARCH_MIN_QUERY_LENGTH);
}

/** What the search box needs to draw itself. */
export interface MessageSearchState {
  /** The query the results on screen belong to. Empty before the first search. */
  submitted: string;
  /**
   * Something is typed, but there is no word long enough to search for. This is
   * NOT the same state as "nothing matched", and the box says so — the two look
   * identical from an empty list, which is the confusion this flag exists to
   * prevent.
   */
  tooShort: boolean;
  /** The hits, best first across every source. */
  results: SearchHit[];
  /** Sources that are behind, if any. Always an array. */
  warnings: SearchSourceWarning[];
  /** A search is on the wire. Results already on screen belong to an older query. */
  isSearching: boolean;
  /** The search failed. The box says what went wrong rather than showing nothing. */
  error: Error | null;
}

/**
 * Search messages for whatever is in the box, one debounce behind it.
 *
 * **Previous results are held while the next search runs** (`placeholderData`),
 * so the list does not blink empty between keystrokes. `isSearching` says when
 * what is on screen is one query behind, which is what the box dims on rather
 * than replacing a useful list with a spinner.
 *
 * @param raw - The live contents of the search box.
 * @param enabled - Whether to search at all. `false` while the box is closed,
 *   so a dialog that is not on screen holds no queries open.
 */
export function useMessageSearch(raw: string, enabled: boolean): MessageSearchState {
  const transport = useTransport();
  const debounced = useDebouncedValue(raw, SEARCH_DEBOUNCE_MS);

  // **Both values have to be searchable, and each one rules out a different
  // mistake.**
  //
  // The DEBOUNCED value gates the request: firing on the live one would send
  // `d` → `do` → `dog` as three searches, which is the debounce not being
  // applied to the case it was written for.
  //
  // The LIVE value gates the ANSWER, and it is the half that was missing. The
  // debounce trails by design, so for 200ms after the box is emptied — cleared,
  // deleted back below the floor, or closed and reopened — `debounced` still
  // holds the old query and still looks perfectly searchable. Gating on it
  // alone left the previous query's rows on screen under an empty input, and
  // suppressed the scope statement with them (the box draws it only when there
  // are no results), so every open after the first silently dropped the **G4**
  // commitment. Asking both is what makes "nothing is being searched" a state
  // this hook can report the instant it becomes true.
  const searchable = enabled && isSearchable(raw) && isSearchable(debounced);

  const { data, isFetching, error } = useQuery({
    queryKey: searchKey(debounced),
    queryFn: () => transport.search({ q: debounced }),
    enabled: searchable,
    staleTime: SEARCH_STALE_MS,
    // Hold the last answer across a key change so the list does not flash
    // empty on every keystroke that gets past the debounce.
    placeholderData: (previous) => previous,
    // One attempt. A refused query is refused deterministically, and a box
    // somebody is typing in gets a fresh chance on the next keystroke anyway —
    // retrying would only make the failure arrive later.
    retry: false,
  });

  // **Everything below is gated on `searchable`, and that gate is the whole
  // correctness of this hook's output.**
  //
  // TanStack hands back data for a query it is not running, from two directions
  // at once: `placeholderData` carries the previous observer's answer across a
  // key change, and a key with a warm cache entry answers from that cache even
  // while `enabled` is false. Both are the right defaults for a list that is
  // merely refetching. Here they are wrong, because "not searching" is a state
  // this box has to be able to DRAW — deleting back to one letter, clearing the
  // input, and closing and reopening all leave a key that is not being searched
  // while an older one still has an answer. Ungated, each of those showed the
  // last query's rows: stale results under an empty box, and — worse — the
  // scope statement suppressed on every open after the first, because the box
  // only draws it when there are no results (spec **G4**).
  //
  // So the answer is reported only when it belongs to the query now being
  // asked. `answered` is the same rule applied to the QUERY: a caller drawing
  // "No messages match X" needs the X the rows on screen belong to, and during
  // the debounce after a reopen the old one is still in `debounced`.
  const answered = searchable ? debounced : '';

  return {
    submitted: answered,
    tooShort: enabled && debounced.trim().length > 0 && !isSearchable(debounced),
    results: searchable ? (data?.results ?? []) : [],
    warnings: searchable ? (data?.warnings ?? []) : [],
    isSearching: searchable && isFetching,
    error: searchable && error instanceof Error ? error : null,
  };
}

/**
 * The value, `delay` milliseconds after it last changed.
 *
 * Local to this module on purpose: it is three lines, and the one thing worth
 * saying about it is which number it is given, which is the caller's job.
 *
 * @param value - The value to trail.
 * @param delay - How long to wait after the last change, in milliseconds.
 */
function useDebouncedValue(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return settled;
}

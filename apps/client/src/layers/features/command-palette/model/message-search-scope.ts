/**
 * What message search covers, in the words a person reads (spec
 * `message-search` §1.3 and **G4**).
 *
 * **This is a product commitment, not a caption.** G4 says somebody must be
 * able to learn what search does not cover without reading a spec, and the
 * three surprises are all of the shape "I know I wrote that": the runtime that
 * is not indexed yet, the tool output that never will be, and the word fragment
 * that matches nothing. A search box that stays silent about any of them reads
 * as broken rather than as bounded.
 *
 * The strings live here rather than inline in the component for one reason: a
 * test asserts them literally (`message-search-scope.test.ts`). Coverage moves
 * — Codex is in flight, OpenCode is planned — and a claim that drifts out of
 * date silently is worse than no claim at all. When a runtime lands, its line
 * moves from {@link SEARCH_SCOPE_GAPS} to {@link SEARCH_SCOPE_COVERED} and the
 * test moves with it, in the same commit.
 *
 * @module features/command-palette/model/message-search-scope
 */
import { SEARCH_MIN_QUERY_LENGTH } from '@dorkos/shared/search-schemas';

/** The heading over the whole statement. */
export const SEARCH_SCOPE_HEADING = 'What search covers';

/**
 * What is searchable today, and how current each one is.
 *
 * **Rooms are immediate and Claude Code is not, and the difference is stated**
 * rather than averaged into one vague sentence. DorkOS owns the room write, so
 * an entry is indexed as it is posted (spec Amendment 7). A Claude Code
 * transcript is a file somebody else writes, so it is picked up by a sweep that
 * runs every five minutes — the server's `SEARCH_RECONCILE_INTERVAL_MS`, which
 * this sentence tracks and cannot import.
 */
export const SEARCH_SCOPE_COVERED: readonly string[] = [
  'Your DorkOS channels and direct messages, the moment they are posted.',
  'Your Claude Code conversations, including the ones you ran from the terminal. A new message can take up to five minutes to show up here.',
];

/**
 * What search will not find, in the order somebody is likely to be surprised by
 * it.
 *
 * The runtimes go first because that gap is invisible: nothing about the box
 * suggests it reads two of your four runtimes and not the other two. Tool
 * output goes second because it is the largest thing missing and the one people
 * ask for by name — "the error the agent showed me" is tool output, and file
 * search answers it against files that are current. The word rule goes last
 * because it only bites once you have typed something and got nothing.
 */
export const SEARCH_SCOPE_GAPS: readonly string[] = [
  'Codex and OpenCode conversations are not searchable yet.',
  'Tool output is never searched. No error messages, no stack traces, no file contents, no diffs. Search reads what you and your agents said to each other.',
  'Search matches whole words. Typing "ogs" will not find "dogs". Type "dog*" to match the start of a word instead.',
];

/**
 * The same statement in one line, for the state where results are on screen.
 *
 * A person reading results does not need the full list, but the box should
 * still never be silent about its edges — this is what sits under a list of
 * hits, quietly, so "why is that not here" has an answer without a second
 * click.
 */
export const SEARCH_SCOPE_SUMMARY =
  'Searches what was said in channels, direct messages and Claude Code conversations. Not tool output, and not Codex or OpenCode yet.';

/**
 * What to say when somebody has typed, but not enough to search on.
 *
 * Derived from the server's own floor rather than written out, so the sentence
 * cannot promise a different number than the route enforces.
 */
export const SEARCH_TOO_SHORT = `Type at least ${SEARCH_MIN_QUERY_LENGTH} letters to search.`;

/** The placeholder in the box — it says what gets searched, in three words. */
export const SEARCH_PLACEHOLDER = 'Search what was said…';

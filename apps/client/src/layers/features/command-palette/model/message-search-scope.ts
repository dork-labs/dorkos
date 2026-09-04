/**
 * What message search covers, in the words a person reads (spec
 * `message-search` §1.3 and **G4**).
 *
 * **This is a product commitment, not a caption.** G4 says somebody must be
 * able to learn what search does not cover without reading a spec, and the two
 * remaining surprises are both of the shape "I know I wrote that": the tool
 * output that never will be indexed, and the word fragment that matches
 * nothing. A search box that stays silent about either reads as broken rather
 * than as bounded.
 *
 * The strings live here rather than inline in the component for one reason: a
 * test asserts them literally, including each list's LENGTH
 * (`message-search-scope-copy.test.tsx`, DOR-1556), so a coverage claim can
 * neither drift stale nor quietly over-claim. Codex (DOR-683) and OpenCode
 * (DOR-688) both moved from {@link SEARCH_SCOPE_GAPS} to
 * {@link SEARCH_SCOPE_COVERED} in DOR-1556, and every source this index
 * registers is covered as of that move — so the likelier next edit here is a
 * NEW source added to {@link SEARCH_SCOPE_COVERED} rather than another
 * gaps-to-covered migration, and it still needs the same test-and-copy commit.
 *
 * @module features/command-palette/model/message-search-scope
 */
import { SEARCH_MIN_QUERY_LENGTH } from '@dorkos/shared/search-schemas';

/**
 * What is searchable today, and how current each one is.
 *
 * **Rooms are immediate and the three runtimes are not, and the difference is
 * stated** rather than averaged into one vague sentence. DorkOS owns the room
 * write, so an entry is indexed as it is posted (spec Amendment 7). A Claude
 * Code, Codex or OpenCode conversation is a file (or, for OpenCode, a database)
 * somebody else writes, so it is picked up by a sweep that runs every five
 * minutes — the server's `SEARCH_RECONCILE_INTERVAL_MS`, which this sentence
 * tracks and cannot import. All three runtimes share that same sweep (DOR-683,
 * DOR-688), so one sentence covers them rather than three near-duplicates.
 */
export const SEARCH_SCOPE_COVERED: readonly string[] = [
  'Your DorkOS channels and direct messages, the moment they are posted.',
  'Your Claude Code, Codex and OpenCode conversations, including the ones you ran outside DorkOS. A new message can take up to five minutes to show up here.',
];

/**
 * What search will not find, in the order somebody is likely to be surprised by
 * it.
 *
 * Tool output goes first because it is the largest thing missing and the one
 * people ask for by name — "the error the agent showed me" is tool output, and
 * file search answers it against files that are current. The word rule goes
 * last because it only bites once you have typed something and got nothing.
 */
export const SEARCH_SCOPE_GAPS: readonly string[] = [
  'Tool output is never searched. No error messages, no stack traces, no file contents, no diffs. Search reads what you and your agents said to each other.',
  'Search matches whole words. Typing "ogs" will not find "dogs". Type "dog*" to match the start of a word instead.',
];

/**
 * The same statement in one line — the whole default view of the box's scope.
 *
 * **This is what is ON SCREEN; the lists above are what a click reveals**
 * (DOR-1757). It used to be the results-only variant, with all four bullets
 * showing in every other state, so a person met four multi-clause sentences
 * before typing anything. One line answers "does this thing even look at what I
 * mean" for the case that comes up, names the largest gap out loud, and doubles
 * as the disclosure that opens the rest.
 */
export const SEARCH_SCOPE_SUMMARY =
  'Searches what was said in channels and direct messages, and in Claude Code, Codex and OpenCode conversations. Not tool output.';

/**
 * The one thing that is different about searching from inside Obsidian
 * (DOR-1563).
 *
 * **Added to the list rather than replacing anything**: everything else on it is
 * as true in the embed as in a browser, because both read the same index through
 * the same access rules. What differs is who keeps that index current. The embed
 * opens the database strictly for reading — it will not write to a file the
 * DorkOS app may be writing, and it will not spend the vault's own thread
 * walking transcripts — so a conversation held while only Obsidian was open is
 * not findable there until the app runs.
 *
 * Stating it is the whole point. A search box that quietly returned less than
 * the browser's for the same words is the "I know I wrote that" surprise this
 * statement exists to prevent, and it is the one gap a person can actually do
 * something about.
 */
export const SEARCH_SCOPE_EMBED_GAP =
  'In Obsidian, this shows what DorkOS has already indexed. Open the DorkOS app to pick up anything said since.';

/**
 * What to say when somebody has typed, but not enough to search on.
 *
 * Derived from the server's own floor rather than written out, so the sentence
 * cannot promise a different number than the route enforces.
 */
export const SEARCH_TOO_SHORT = `Type at least ${SEARCH_MIN_QUERY_LENGTH} letters to search.`;

/** The placeholder in the box — it says what gets searched, in three words. */
export const SEARCH_PLACEHOLDER = 'Search what was said…';

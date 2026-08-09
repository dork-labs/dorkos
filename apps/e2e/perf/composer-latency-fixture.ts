/**
 * The document the composer latency budget is measured on.
 *
 * The spec's budget names a shape, not a string: **4 000 characters containing
 * 20 mentions**. Generating it from a seed rather than pasting a blob keeps two
 * things true — the shape is checked (the assertions below run at import time,
 * so a drifting generator fails loudly instead of quietly measuring a 3 000
 * character document), and the same text comes back next quarter when somebody
 * re-runs the measurement to see whether it moved.
 *
 * Deliberately prose-shaped rather than 4 000 `a`s: the serializer walks nodes
 * and marks, so word boundaries, punctuation and paragraph breaks are the work.
 * A single unbroken run of one character would measure a document the product
 * never sees and would flatter the number.
 */

/** How long the document must be, per the spec's Performance section. */
export const FIXTURE_LENGTH = 4000;

/** How many `@handle` mentions it must contain, same source. */
export const FIXTURE_MENTIONS = 20;

/** Handles cycled through the text. Short, so they cost characters honestly. */
const HANDLES = ['ana', 'kai', 'priya', 'ike'] as const;

/** Words the filler is built from — ordinary prose, no markdown syntax. */
const WORDS = [
  'the',
  'agent',
  'finished',
  'its',
  'turn',
  'and',
  'left',
  'a',
  'note',
  'about',
  'what',
  'it',
  'changed',
  'in',
  'the',
  'worktree',
  'before',
  'anyone',
  'looked',
  'again',
] as const;

/**
 * Build the fixture: prose with a mention every so often, cut to length.
 *
 * The mentions are spread evenly rather than clustered, because a caret near a
 * pill is the case the position map has to work hardest on and one clump would
 * leave most of the document trivial.
 */
function buildFixture(): string {
  const parts: string[] = [];
  let mentionsPlaced = 0;
  let word = 0;
  // A mention roughly every N words, sized so all 20 land inside 4 000 chars.
  const wordsPerMention = 12;

  while (parts.join(' ').length < FIXTURE_LENGTH + 40) {
    if (word > 0 && word % wordsPerMention === 0 && mentionsPlaced < FIXTURE_MENTIONS) {
      parts.push(`@${HANDLES[mentionsPlaced % HANDLES.length]}`);
      mentionsPlaced++;
    } else {
      parts.push(WORDS[word % WORDS.length]!);
      // A sentence break every so often, so the document is more than one line.
      if (word > 0 && word % 25 === 0) parts.push('.\n');
    }
    word++;
  }

  return parts.join(' ').slice(0, FIXTURE_LENGTH);
}

/** The 4 000-character, 20-mention document. */
export const LATENCY_FIXTURE: string = buildFixture();

// Checked at import time: a fixture that quietly stopped matching the spec's
// shape would make every number measured against it meaningless.
if (LATENCY_FIXTURE.length !== FIXTURE_LENGTH) {
  throw new Error(`fixture is ${LATENCY_FIXTURE.length} chars, expected ${FIXTURE_LENGTH}`);
}
const mentionCount = (LATENCY_FIXTURE.match(/@[a-z]+/g) ?? []).length;
if (mentionCount !== FIXTURE_MENTIONS) {
  throw new Error(`fixture has ${mentionCount} mentions, expected ${FIXTURE_MENTIONS}`);
}

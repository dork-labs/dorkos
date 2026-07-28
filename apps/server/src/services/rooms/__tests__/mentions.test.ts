import { describe, it, expect } from 'vitest';
import {
  advertisedHandle,
  claimNames,
  resolveMentions,
  type MentionCandidate,
} from '../mentions.js';

const roster: MentionCandidate[] = [
  { authorId: 'author-ana', names: ['ana', 'Ana Reyes'] },
  { authorId: 'author-bo', names: ['bo-builder', 'Bo'] },
  { authorId: 'author-dorian', names: ['Dorian'] },
];

describe('resolveMentions', () => {
  it('resolves a handle to its author id', () => {
    expect(resolveMentions('hey @ana can you look', roster)).toEqual(['author-ana']);
  });

  it('is case-insensitive', () => {
    expect(resolveMentions('@ANA @Bo', roster)).toEqual(['author-ana', 'author-bo']);
  });

  it('resolves a handle containing a hyphen', () => {
    expect(resolveMentions('@bo-builder ping', roster)).toEqual(['author-bo']);
  });

  it('leaves an unresolvable @name as plain text', () => {
    expect(resolveMentions('mail me at @nobody', roster)).toEqual([]);
  });

  it('does not resolve a display name containing a space', () => {
    // `@Ana Reyes` would be ambiguous between one member and two without an
    // autocomplete that writes a delimiter, so only `@ana` addresses her.
    expect(resolveMentions('@Ana Reyes said so', roster)).toEqual(['author-ana']);
  });

  it('de-duplicates, keeping first-mention order', () => {
    expect(resolveMentions('@bo @ana @bo again', roster)).toEqual(['author-bo', 'author-ana']);
  });

  it('shaves trailing sentence punctuation off a handle', () => {
    expect(resolveMentions('thanks @ana.', roster)).toEqual(['author-ana']);
  });

  it('resolves nothing from an empty roster', () => {
    expect(resolveMentions('@ana @bo', [])).toEqual([]);
  });

  it('resolves a handle before a display name when both could match', () => {
    const colliding: MentionCandidate[] = [
      { authorId: 'author-handle', names: ['bo'] },
      { authorId: 'author-display', names: ['bo-builder', 'bo'] },
    ];
    expect(resolveMentions('@bo', colliding)).toEqual(['author-handle']);
  });

  it('ignores an @ that starts with punctuation', () => {
    expect(resolveMentions('@-ana @.bo', roster)).toEqual([]);
  });
});

/** One member answering to `names`, the roster shape the helpers take. */
function only(names: string[]): MentionCandidate[] {
  return [{ authorId: 'author-x', names }];
}

/** The handle offered to the sole member of a roster made of `names`. */
function offeredTo(names: string[]): string | undefined {
  const roster = only(names);
  return advertisedHandle(roster[0]!, claimNames(roster));
}

/**
 * Every name a picker might be tempted to offer, and whether it survives being
 * typed after an `@`. Kept as one table so the two claims below — what
 * `advertisedHandle` picks, and what `resolveMentions` accepts — are made
 * against exactly the same inputs.
 */
const NAMES = [
  'ana',
  'bo-builder',
  'mio-clicker-pm',
  'esp32-learning',
  'agent.v2',
  'agent_v2',
  'ana.',
  'DorkOS',
  '144mono',
  // Whitespace anywhere is fatal: `@Mio Clicker PM` matches only `@Mio`.
  'Mio Clicker PM',
  'Art Blocks Analytics',
  'Ana Reyes',
  ' leading',
  'trailing ',
  // A handle must open with a letter or a digit.
  '-ana',
  '.bo',
  '_cy',
  '',
  '   ',
];

describe('advertisedHandle', () => {
  it('picks an agent handle over the display name beside it', () => {
    expect(offeredTo(['mio-clicker-pm', 'Mio Clicker PM'])).toBe('mio-clicker-pm');
  });

  it('falls through a spaced handle to a display name that works', () => {
    // The real shape behind this: `agents.name` is not always a slug, so the
    // preferred name is sometimes the unusable one.
    expect(offeredTo(['Art Blocks Analytics', 'analytics'])).toBe('analytics');
  });

  it('returns undefined when every name a member answers to has a space in it', () => {
    // Honest rather than helpful: there is no string to insert, and offering
    // `@Art` would address nobody while looking like it addressed somebody.
    expect(offeredTo(['Art Blocks Analytics'])).toBeUndefined();
  });

  it('returns undefined for an empty name list', () => {
    expect(offeredTo([])).toBeUndefined();
  });

  it('trims a name before offering it', () => {
    expect(offeredTo([' ana '])).toBe('ana');
  });

  it('withholds a name an earlier member already owns', () => {
    // Bo's handle is unusable, so its display name would be next in line — but
    // Ana already answers to `ana` through HER display name, which she never
    // advertises. Offering it to Bo would address Ana.
    const roster: MentionCandidate[] = [
      { authorId: 'author-ana', names: ['ana-pm', 'Ana'] },
      { authorId: 'author-bo', names: ['Bo The Second', 'Ana'] },
    ];
    const claims = claimNames(roster);
    expect(advertisedHandle(roster[0]!, claims)).toBe('ana-pm');
    expect(advertisedHandle(roster[1]!, claims)).toBeUndefined();
  });

  it('offers a later member the first name it does own', () => {
    // Losing one name is not losing them all.
    const roster: MentionCandidate[] = [
      { authorId: 'author-ana', names: ['ana'] },
      { authorId: 'author-bo', names: ['ana', 'bo'] },
    ];
    expect(advertisedHandle(roster[1]!, claimNames(roster))).toBe('bo');
  });

  /**
   * The invariant the whole contract reduces to, over a roster built to break
   * it: **every handle offered reaches the member it was offered for.**
   *
   * Stated over the roster rather than over one member, because the defect this
   * replaces was invisible per member — each one's handle was individually
   * typeable, and only the roster as a whole showed one of them addressing
   * somebody else.
   */
  it('never offers a handle that resolves to a different member', () => {
    const roster: MentionCandidate[] = [
      { authorId: 'a', names: ['ana-pm', 'Ana'] },
      { authorId: 'b', names: ['Bo The Second', 'Ana'] },
      { authorId: 'c', names: ['ana', 'Cy'] },
      { authorId: 'd', names: ['Dee Dee', 'Dee Dee'] },
      { authorId: 'e', names: ['ANA', 'Echo'] },
    ];
    const claims = claimNames(roster);

    let offeredCount = 0;
    for (const candidate of roster) {
      const handle = advertisedHandle(candidate, claims);
      if (handle === undefined) continue;
      offeredCount += 1;
      expect(resolveMentions(`@${handle}`, roster)).toEqual([candidate.authorId]);
    }
    // A roster where nothing is offered would satisfy the loop vacuously.
    expect(offeredCount).toBe(3);
  });

  /**
   * The property the picker rests on: **a handle this function offers is a
   * handle `resolveMentions` resolves, and one it withholds is one that would
   * not have resolved.**
   *
   * `WHOLE_HANDLE` and `MENTION_PATTERN` are two literals in one module, and
   * nothing in the type system keeps them in step. This is what does. Without
   * it, widening one pattern and not the other ships a picker whose every
   * insertion silently posts as plain text — which is precisely the failure the
   * picker exists to remove.
   */
  it.each(NAMES)('offers %o exactly when resolving @-it works', (name) => {
    const offered = offeredTo([name]);
    // Probed with the TRIMMED name, because both sides trim: `resolveMentions`
    // keys its roster on `name.trim()`, so surrounding whitespace is not part of
    // any name and `@ leading` is not a string a picker would ever write. The
    // untrimmed form is unresolvable for a reason that has nothing to do with
    // whether the member is addressable.
    const typed = name.trim();
    const resolved = resolveMentions(`@${typed}`, only([name]));
    expect(offered !== undefined).toBe(resolved.length === 1);
    // And when it IS offered, the offered string is the one that resolves —
    // not merely some substring of the name that happens to match.
    if (offered !== undefined) {
      expect(resolveMentions(`@${offered}`, only([name]))).toEqual(['author-x']);
    }
  });
});

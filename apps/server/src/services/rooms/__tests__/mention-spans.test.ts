/**
 * Mention SPANS — the per-occurrence positions the client draws pills from.
 *
 * The deduped `mentions` list and the `unreachable` set are proved byte-for-byte
 * unchanged by `mentions.test.ts`, which this slice does not touch. This file
 * proves only the additive output: a span lands on exactly the `@handle` the
 * resolver used, repeats are NOT collapsed, a quoted or unreachable name earns
 * none, and the whole thing survives a write to SQLite and a read back.
 */
import { describe, it, expect } from 'vitest';
import { resolveAddressing, type MentionCandidate } from '../mentions.js';
import { agentLookupFor, createRoomHarness } from './room-test-harness.js';

const roster: MentionCandidate[] = [
  { authorId: 'author-ana', names: ['ana', 'Ana Reyes'] },
  { authorId: 'author-bo', names: ['bo-builder', 'Bo'] },
];

/** The spans a message resolves to against a live roster and no ghosts. */
function spansOf(text: string, live: MentionCandidate[] = roster) {
  return resolveAddressing(text, { live, unreachable: [] }).spans;
}

describe('mention spans', () => {
  it('locates a mention at its exact offset and length in the raw text', () => {
    const text = 'hey @ana can you look';
    const spans = spansOf(text);
    expect(spans).toEqual([{ offset: 4, length: 4, authorId: 'author-ana' }]);
    // The offset indexes the RAW body, so the slice is the token itself.
    const [span] = spans;
    expect(text.slice(span!.offset, span!.offset + span!.length)).toBe('@ana');
  });

  it('emits one span per occurrence — a pill per @handle, never deduped', () => {
    const text = '@ana ping @ana again';
    const result = resolveAddressing(text, { live: roster, unreachable: [] });
    expect(result.spans).toEqual([
      { offset: 0, length: 4, authorId: 'author-ana' },
      { offset: 10, length: 4, authorId: 'author-ana' },
    ]);
    // The deduped mentions set still collapses the two to one, order preserved.
    expect(result.mentions).toEqual(['author-ana']);
  });

  it('carries the second occurrence to its own later offset', () => {
    const text = 'first @bo-builder then @bo-builder';
    expect(spansOf(text)).toEqual([
      { offset: 6, length: 11, authorId: 'author-bo' },
      { offset: 23, length: 11, authorId: 'author-bo' },
    ]);
  });

  describe('quoted text draws no pill, exactly as it addresses nobody', () => {
    it('a blockquote line', () => {
      expect(spansOf('> can @ana look at this?')).toEqual([]);
    });

    it('a fenced code block', () => {
      expect(spansOf(['```', '@ana', '```'].join('\n'))).toEqual([]);
    });

    it('an inline code span', () => {
      expect(spansOf('the literal `@ana` is not a person')).toEqual([]);
    });
  });

  it('spans only the resolved handle when trailing punctuation was shaved', () => {
    const text = 'thanks @ana.';
    const spans = spansOf(text);
    expect(spans).toEqual([{ offset: 7, length: 4, authorId: 'author-ana' }]);
    const [span] = spans;
    // The pill covers `@ana`; the full stop that ended the sentence is left out.
    expect(text.slice(span!.offset, span!.offset + span!.length)).toBe('@ana');
    expect(text[span!.offset + span!.length]).toBe('.');
  });

  it('covers the whole token when a member literally owns the punctuated name', () => {
    // The mirror of the shave: `ana.` is a real handle here, so the resolver
    // takes the EXACT token and the pill covers the full stop with it.
    const dotted: MentionCandidate[] = [{ authorId: 'author-dotted', names: ['ana.'] }];
    const text = 'thanks @ana.';
    expect(spansOf(text, dotted)).toEqual([{ offset: 7, length: 5, authorId: 'author-dotted' }]);
    expect(text.slice(7, 12)).toBe('@ana.');
  });

  it('draws no pill for an @name only an unreachable ghost owns', () => {
    // A ghost claims no live pill, so `@ana are you there?` reaches nobody to
    // draw over — the same split the dispatcher reads from `unreachable`.
    const result = resolveAddressing('@ana are you there?', {
      live: [],
      unreachable: [{ authorId: 'ghost-ana', names: ['ana'] }],
    });
    expect(result.mentions).toEqual([]);
    expect(result.unreachable).toEqual(['ghost-ana']);
    expect(result.spans).toEqual([]);
  });

  /**
   * The corpus `mentions.test.ts` already pins for `mentions`, re-checked here
   * for POSITIONS. Two non-circular invariants: every span slices back to a
   * whitespace-free `@` token in the raw body (an offset computed against the
   * old stripped text would land mid-word, or on a space, in the multi-line
   * cases), and the deduped authors of the spans, in first-seen order, ARE the
   * `mentions` set (a dropped, doubled or ghost span would break the tie).
   */
  const CORPUS: string[] = [
    'hey @ana can you look',
    '@ana ping @ana again',
    'thanks @ana.',
    '> can @ana and @bo-builder look?',
    ['Dorian said:', '', '> @ana can you check the deploy?', '', 'Any luck @bo-builder?'].join(
      '\n'
    ),
    ['```yaml', 'owner: @ana', 'reviewer: @bo-builder', '```', 'so @bo-builder takes it'].join(
      '\n'
    ),
    '`@ana` — over to you @bo-builder',
    ['````', '```', '@ana', '```', '````', 'over to @bo-builder'].join('\n'),
  ];

  it.each(CORPUS)('positions every pill on its own token and agrees with mentions: %o', (text) => {
    const { mentions, spans } = resolveAddressing(text, { live: roster, unreachable: [] });
    for (const span of spans) {
      const sliced = text.slice(span.offset, span.offset + span.length);
      expect(sliced.startsWith('@')).toBe(true);
      expect(/\s/.test(sliced)).toBe(false);
    }
    const firstSeen: string[] = [];
    for (const span of spans) if (!firstSeen.includes(span.authorId)) firstSeen.push(span.authorId);
    expect(firstSeen).toEqual(mentions);
  });
});

describe('mention spans survive the write and read back', () => {
  it('persists spans on the entry and re-reads them from SQLite', () => {
    const agents = agentLookupFor({
      '/agents/ana': { name: 'ana', displayName: 'Ana', responseMode: 'silent' },
      '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'silent' },
    });
    const { service, human } = createRoomHarness({ agents });
    const room = service.createRoom(
      { kind: 'channel', title: 'Spans', members: [], agentPaths: [] },
      human
    );
    const ana = service.addMember(room.id, human, { agentPath: '/agents/ana' }).authorId;
    const bo = service.addMember(room.id, human, { agentPath: '/agents/bo' }).authorId;

    const text = 'hey @ana and @ana again, over to @bo';
    const expected = [
      { offset: text.indexOf('@ana'), length: 4, authorId: ana },
      { offset: text.indexOf('@ana', 5), length: 4, authorId: ana },
      { offset: text.indexOf('@bo'), length: 3, authorId: bo },
    ];

    const written = service.post(room.id, { authorId: human, text });
    expect(written.mentionSpans).toEqual(expected);
    // The deduped mentions are unchanged by any of this.
    expect(written.mentions).toEqual([ana, bo]);

    // The row, read back through the deserializing path, carries the same spans.
    const reread = service
      .listEntries(room.id, human, { limit: 10 })
      .find((entry) => entry.id === written.id);
    expect(reread?.mentionSpans).toEqual(expected);
    expect(reread?.mentions).toEqual([ana, bo]);
  });
});

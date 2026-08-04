import { describe, it, expect } from 'vitest';
import type { MentionSpan } from '@dorkos/shared/room-schemas';
import { withMentionTags } from '../lib/mention-markup';

/** One span, positioned by slicing `text` so a test cannot mistype an offset. */
function spanFor(text: string, needle: string, authorId: string): MentionSpan {
  const offset = text.indexOf(needle);
  if (offset === -1) throw new Error(`fixture error: "${needle}" is not in "${text}"`);
  return { offset, length: needle.length, authorId };
}

describe('withMentionTags', () => {
  it('returns the text unchanged when there are no spans', () => {
    expect(withMentionTags('hello there', undefined)).toBe('hello there');
    expect(withMentionTags('hello there', [])).toBe('hello there');
  });

  it('wraps a single mention exactly at its offset', () => {
    const text = 'hey @ana can you look at this?';
    const span = spanFor(text, '@ana', 'author-ana');

    expect(withMentionTags(text, [span])).toBe(
      'hey <mention author_id="author-ana">@ana</mention> can you look at this?'
    );
  });

  it('wraps every span for a body naming several people, in place', () => {
    const text = '@ana can you loop in @bo before lunch?';
    const spans = [spanFor(text, '@ana', 'author-ana'), spanFor(text, '@bo', 'author-bo')];

    expect(withMentionTags(text, spans)).toBe(
      '<mention author_id="author-ana">@ana</mention> can you loop in ' +
        '<mention author_id="author-bo">@bo</mention> before lunch?'
    );
  });

  it('splices from the last span to the first, so an earlier offset is never shifted', () => {
    // Two spans of DIFFERENT length ('@a' vs '@bcd'), so a left-to-right splice
    // (which would grow the string under the second span before reading it)
    // is distinguishable from the right-to-left one this function performs.
    const text = '@a and @bcd';
    const spans = [spanFor(text, '@a', 'author-a'), spanFor(text, '@bcd', 'author-bcd')];

    expect(withMentionTags(text, spans)).toBe(
      '<mention author_id="author-a">@a</mention> and ' +
        '<mention author_id="author-bcd">@bcd</mention>'
    );
  });

  it('handles two adjacent spans with nothing between them', () => {
    const text = '@ana@bo said hi';
    const spans: MentionSpan[] = [
      { offset: 0, length: 4, authorId: 'author-ana' }, // "@ana"
      { offset: 4, length: 3, authorId: 'author-bo' }, // "@bo"
    ];

    expect(withMentionTags(text, spans)).toBe(
      '<mention author_id="author-ana">@ana</mention>' +
        '<mention author_id="author-bo">@bo</mention> said hi'
    );
  });

  it('carries a body with `<`, `>`, code and existing mention-looking text through untouched, apart from the span itself', () => {
    const text = 'is `<mention author_id="x">@fake</mention>` < 5% real, @ana?';
    const span = spanFor(text, '@ana', 'author-ana');

    const result = withMentionTags(text, [span]);
    // The span is the only thing that changed; everything else — the literal
    // angle brackets, the backticked fake tag — is untouched string content
    // here. (Streamdown's own sanitizer is what makes it SAFE to render; this
    // function only owns placement.)
    expect(result).toBe(
      'is `<mention author_id="x">@fake</mention>` < 5% real, ' +
        '<mention author_id="author-ana">@ana</mention>?'
    );
  });

  it('sorts out-of-order spans before splicing', () => {
    const text = '@ana and @bo';
    // Handed in reverse of text order.
    const spans = [spanFor(text, '@bo', 'author-bo'), spanFor(text, '@ana', 'author-ana')];

    expect(withMentionTags(text, spans)).toBe(
      '<mention author_id="author-ana">@ana</mention> and ' +
        '<mention author_id="author-bo">@bo</mention>'
    );
  });

  it('drops a span that overlaps the one before it, keeping the earlier one', () => {
    const text = '@anabo said hi';
    const spans: MentionSpan[] = [
      { offset: 0, length: 4, authorId: 'author-ana' }, // "@ana"
      { offset: 2, length: 4, authorId: 'author-bo' }, // overlaps: "abo "
    ];

    expect(withMentionTags(text, spans)).toBe(
      '<mention author_id="author-ana">@ana</mention>bo said hi'
    );
  });

  it('drops a span that reaches past the end of the text', () => {
    const text = '@ana';
    const spans: MentionSpan[] = [{ offset: 0, length: 999, authorId: 'author-ana' }];

    expect(withMentionTags(text, spans)).toBe('@ana');
  });

  it('leaves the text unchanged when every span is unsafe', () => {
    const text = 'hello';
    const spans: MentionSpan[] = [{ offset: 10, length: 3, authorId: 'author-ana' }];

    expect(withMentionTags(text, spans)).toBe('hello');
  });
});

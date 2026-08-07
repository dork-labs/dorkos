import { describe, it, expect } from 'vitest';
import { resolveMentions, type MentionCandidate } from '../mentions.js';
import { addressableHandles } from '../handles/author-handles.js';

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

  describe('quoted text addresses nobody', () => {
    // "Mentions resolve once, at write time" was not true of anything quoted:
    // re-stating somebody's message re-addressed everyone it named, minutes or
    // days later. The room's own late answer is the case that bit — it quotes
    // the question it is answering — but the rule is general, because a person
    // quoting a colleague to disagree with them is not summoning the four
    // agents that colleague pinged.

    it('resolves nothing inside a blockquote', () => {
      expect(resolveMentions('> can @ana and @bo look at this?', roster)).toEqual([]);
    });

    it('resolves what the author wrote around a quote, and nothing inside it', () => {
      const text = ['Dorian said:', '', '> @ana can you check the deploy?', '', 'Any luck @bo?'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual(['author-bo']);
    });

    it('resolves nothing inside a fenced code block', () => {
      const text = ['Here is the config:', '```yaml', 'owner: @ana', 'reviewer: @bo', '```'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual([]);
    });

    it('closes a fence again, so text after it still addresses people', () => {
      const text = ['```', '@ana', '```', 'so @bo should take it'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual(['author-bo']);
    });

    it('treats an unclosed fence as ordinary text, not as a hole in the message', () => {
      // A running toggle read the first ``` as "everything after this is code",
      // so one stray or unterminated fence — somebody pasting a snippet and
      // forgetting to close it — swallowed every mention in the rest of the
      // message. Silently: the post looks addressed and reaches nobody.
      //
      // An opener with no closer is not a code block. It is a line that starts
      // with backticks, and what follows is the author talking.
      const text = ['```js', 'const x = 1;', 'and @bo please take this'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual(['author-bo']);
    });

    it('lets a shorter fence sit inside a longer one without closing it', () => {
      // CommonMark's rule, and the reason the scan matches a CLOSER rather than
      // toggling: a ``` inside a ```` block is content. Toggling instead paired
      // the outer opener with the inner one, ending the block early and letting
      // the code after it address people.
      const text = ['````', '```', '@ana', '```', '````', 'over to @bo'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual(['author-bo']);
    });

    it('keeps a nested pair quoted when the outer fence never closes', () => {
      // The outer ```` opens and is never closed, so it is ordinary text — but
      // the inner ``` pair really does close, and what it holds really is code.
      // A closed-region model gets both right at once; a toggle got neither.
      const text = ['````', '```', '@ana', '```', 'so @bo should take it'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual(['author-bo']);
    });

    it('does not let a line with an info string close a fence', () => {
      // ```` ```js ```` opens a block; it never closes one. Accepting it as a
      // closer would end this block three lines early and hand `@bo` back to
      // the resolver as though the author had written it.
      const text = ['```', '@ana', '```js', '@bo', '```'];
      expect(resolveMentions(text.join('\n'), roster)).toEqual([]);
    });

    it('resolves nothing inside an inline code span', () => {
      expect(resolveMentions('the literal `@ana` is not a person', roster)).toEqual([]);
    });

    it('still resolves a handle beside an inline code span', () => {
      expect(resolveMentions('`@ana` — over to you @bo', roster)).toEqual(['author-bo']);
    });
  });
});

describe('addressableHandles', () => {
  /**
   * The G5 invariant, and the one Buzz fails: **every handle a surface offers
   * reaches the member it was offered for.**
   *
   * Stated over the roster rather than over one member, because the defect this
   * replaced was invisible per member — each name was individually typeable, and
   * only the roster as a whole showed one of them addressing somebody else. The
   * unique index makes that impossible now, and this is what pins the picker,
   * the agent's roster and the resolver to the SAME projection rather than to
   * three that happen to agree.
   */
  it('offers only handles that resolve back to their own member', () => {
    const candidates: MentionCandidate[] = [
      { authorId: 'a', names: ['ana'] },
      { authorId: 'b', names: ['bo-builder'] },
      { authorId: 'c', names: ['144x.co'] },
      // A ghost: on the roster, claiming nothing. Its author row still carries a
      // handle, so a surface reading the column instead of this projection would
      // offer a mention that reaches nobody.
      { authorId: 'ghost', names: [] },
    ];
    const handles = addressableHandles(candidates);

    expect(handles.has('ghost')).toBe(false);
    expect(handles.size).toBe(3);
    for (const [authorId, handle] of handles) {
      expect(resolveMentions('@' + handle, candidates)).toEqual([authorId]);
    }
  });

  it('prefers the handle over a platform name threaded in beside it', () => {
    // A bridged room appends the bot's Telegram username AFTER the agent's own
    // handle, so first-claimant-wins keeps the real handle the offered one.
    const candidates: MentionCandidate[] = [{ authorId: 'a', names: ['ana', 'anabot'] }];
    expect(addressableHandles(candidates).get('a')).toBe('ana');
    // The extra name still resolves — it is an address, just not the advertised one.
    expect(resolveMentions('@anabot hi', candidates)).toEqual(['a']);
  });
});

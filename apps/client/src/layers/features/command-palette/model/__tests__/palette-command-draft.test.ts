import { describe, it, expect } from 'vitest';
// Deliberately reaching into another feature, and only a test may. The claim
// under test is an AGREEMENT between two features — the palette writes composer
// text, the chat send funnel decides whether that text is a command — and an
// agreement asserted against a re-typed copy of the rule is not asserted at
// all. This is the real recognizer the draft will meet.
import { isNativeCommandContent } from '@/layers/features/chat/model/native-commands';
import { composeCommandDraft } from '../palette-command-draft';

describe('composeCommandDraft', () => {
  it('writes the command with a trailing space into an empty composer', () => {
    // The space is where an argument goes.
    expect(composeCommandDraft('/compact', '')).toBe('/compact ');
    expect(composeCommandDraft('/compact', '   ')).toBe('/compact ');
  });

  it('puts the command FIRST and makes the existing draft its argument', () => {
    // Both recognizers anchor at position 0 — the client's `splitSlashCommand`
    // on `content.trim()`, the server's `detectSlashCommandName` on
    // `content.trimStart()`. A command appended to a draft is not a command at
    // all; it is prose, and it reaches the model as prose.
    expect(composeCommandDraft('/compact', 'focus on the API changes')).toBe(
      '/compact focus on the API changes'
    );
  });

  it('replaces a draft that is itself a command, keeping that command’s arguments', () => {
    // Picking a command while one is already typed means "this one instead".
    // Stacking them (`/compact /clear`) would hand the old command to the new
    // one as argument text, which means nothing to either.
    expect(composeCommandDraft('/compact', '/clear')).toBe('/compact ');
    expect(composeCommandDraft('/clear', '/compact focus on the API changes')).toBe(
      '/clear focus on the API changes'
    );
  });

  it('does not mistake a file path for a command to replace', () => {
    // `/etc/hosts` fails the command shape (the segment is followed by `/`, not
    // whitespace), so it is ordinary text and survives as the argument. Treating
    // any leading slash as a command would silently delete it.
    expect(composeCommandDraft('/compact', '/etc/hosts')).toBe('/compact /etc/hosts');
  });

  it('never leaves text the person typed behind', () => {
    for (const draft of ['ship it', 'look at /etc/hosts', 'a/b', '/compact keep this']) {
      const composed = composeCommandDraft('/clear', draft);
      const kept = draft.replace(/^\/\S+\s*/, '').trim();
      if (kept) expect(composed).toContain(kept);
    }
  });

  describe('what the send funnel makes of the result', () => {
    // The whole point: not "the string looks right" but "the command runs".
    it('is recognized as the command, whatever was already in the composer', () => {
      for (const draft of ['', 'focus on the API changes', '/clear', '/etc/hosts']) {
        expect(isNativeCommandContent(composeCommandDraft('/compact', draft))).toBe(true);
      }
    });

    it('proves the old append order was NOT recognized', () => {
      // The bug this rule replaces, stated as the fact that made it a bug.
      expect(isNativeCommandContent('ship it /compact ')).toBe(false);
    });
  });
});

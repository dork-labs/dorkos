import { describe, expect, it } from 'vitest';
import { mentionCandidates, resolveCommunityMentions } from '../content/mentions.js';

const roster = [
  { id: 'member-ana', handle: 'ana' },
  { id: 'agent-build', handle: 'build.bot' },
];

describe('write-time community mentions', () => {
  it('resolves only joined handles once, case-insensitively, in source order', () => {
    expect(
      resolveCommunityMentions('@BUILD.BOT then @ana and @build.bot @unknown', roster)
    ).toEqual(['agent-build', 'member-ana']);
  });

  it('ignores quoted and code text while keeping ordinary nearby addresses', () => {
    const text = [
      '> @ana quoted',
      '`@build.bot` @ana',
      '```',
      '@build.bot',
      '```',
      '@build.bot now',
    ].join('\n');
    expect(resolveCommunityMentions(text, roster)).toEqual(['member-ana', 'agent-build']);
  });

  it('does not let sentence punctuation change a reached handle', () => {
    expect(resolveCommunityMentions('thanks @ana. and @build.bot,', roster)).toEqual([
      'member-ana',
      'agent-build',
    ]);
  });

  it('resolves the same over only the handles a post could address as over the whole roster', () => {
    // Purpose: fails if a post that reads only its candidate handles (not a 20,000-row roster)
    // could resolve a mention differently.
    const everyone = [
      ...roster,
      { id: 'member-bo', handle: 'bo' },
      { id: 'member-bo-dot', handle: 'bo.' },
      ...Array.from({ length: 50 }, (_, n) => ({ id: `member-${n}`, handle: `person${n}` })),
    ];
    for (const text of [
      'thanks @ana. and @build.bot, @BO @bo. @nobody',
      '> @ana quoted `@person3` @person7.',
      'no mentions at all',
    ]) {
      const candidates = new Set(mentionCandidates(text));
      const narrowed = everyone.filter((member) => candidates.has(member.handle.toLowerCase()));
      expect(resolveCommunityMentions(text, narrowed), text).toEqual(
        resolveCommunityMentions(text, everyone)
      );
    }
    expect(mentionCandidates('no mentions at all')).toEqual([]);
  });
});

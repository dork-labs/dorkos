import { describe, expect, it } from 'vitest';
import { resolveCommunityMentions } from '../mentions.js';

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
});

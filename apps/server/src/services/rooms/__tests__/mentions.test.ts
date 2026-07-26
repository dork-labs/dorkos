import { describe, it, expect } from 'vitest';
import { resolveMentions, type MentionCandidate } from '../mentions.js';

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

import { describe, it, expect } from 'vitest';
import { hashToHslColor } from '../favicon-utils';
import { resolveIdentityFace, type IdentityRecord } from '../identity-face';

const RECORD: IdentityRecord = {
  id: 'author-ana',
  kind: 'agent',
  displayName: 'Ana',
  emoji: '📦',
  color: '#ff0000',
};

describe('resolveIdentityFace', () => {
  it('prefers the override, so an agent looks like itself everywhere', () => {
    // The manifest is the freshest source there is: the record's emoji and
    // colour are a server-side cache that goes stale the moment an agent is
    // renamed or recoloured.
    const face = resolveIdentityFace({
      record: RECORD,
      override: { color: '#6366f1', emoji: '🔍' },
    });

    expect(face.color).toBe('#6366f1');
    expect(face.emoji).toBe('🔍');
  });

  it('takes each half of the override on its own', () => {
    // An override that carries a colour and no emoji must not delete the
    // record's emoji on the way past. Red if the ladder is ever written as
    // "whole override or whole record".
    const face = resolveIdentityFace({ record: RECORD, override: { color: '#6366f1' } });

    expect(face.color).toBe('#6366f1');
    expect(face.emoji).toBe('📦');
  });

  it('falls to the record when there is nothing fresher', () => {
    expect(resolveIdentityFace({ record: RECORD }).color).toBe('#ff0000');
    expect(resolveIdentityFace({ record: RECORD, override: null }).emoji).toBe('📦');
  });

  it('hashes the id when nothing else has a colour, and hashes no emoji', () => {
    // The same hash `resolveAgentVisual` uses, so an identity nobody could
    // resolve still reads as one identity across every list. And a letter, not
    // an invented emoji: the letter admits we do not know this face.
    const face = resolveIdentityFace({
      record: { id: 'author-x', kind: 'human', displayName: 'Zoë' },
    });

    expect(face.color).toBe(hashToHslColor('author-x'));
    expect(face.emoji).toBeUndefined();
    expect(face.fallback).toBe('Z');
  });

  it('hashes no emoji for an agent either, however tempting that looks', () => {
    // The rung that belongs one layer up, pinned where it would be added by
    // mistake. An agent SHOULD always show a face — but only a caller holding
    // its manifest id can invent one, and this function's callers do not all
    // hold that: `MemberList` passes author-row ids, which hash differently, so
    // hashing here draws one agent two faces in one room (DOR-1122 review).
    // `teamMemberFace` owns the rung; see `entities/team`.
    const face = resolveIdentityFace({
      record: { id: 'agent-warden', kind: 'agent', displayName: 'Warden' },
    });

    expect(face.emoji).toBeUndefined();
    expect(face.fallback).toBe('W');
  });

  it('gives two different ids two different colours', () => {
    // A parity assertion is worthless if the source it compares answers the
    // same thing for everything.
    const one = resolveIdentityFace({
      record: { id: 'author-a', kind: 'human', displayName: 'A' },
    });
    const two = resolveIdentityFace({
      record: { id: 'author-b', kind: 'human', displayName: 'B' },
    });

    expect(one.color).not.toBe(two.color);
  });

  it('still answers a letter for a nameless identity', () => {
    // A display name is `min(1)` on the wire, but a roster row rendering
    // mid-flight has handed this an empty string before. A blank disc reads as
    // a rendering bug; `?` reads as a missing name.
    expect(
      resolveIdentityFace({ record: { id: 'author-void', kind: 'system', displayName: '' } })
        .fallback
    ).toBe('?');
  });

  describe('the photo, the fourth cached field', () => {
    it("carries the record's photo through beside its emoji", () => {
      // Both travel: this resolver decides nothing about which face wins — the
      // disc does — so an identity with a photo AND an emoji must arrive with
      // both intact.
      const face = resolveIdentityFace({
        record: { ...RECORD, imageUrl: '/api/profile/avatar/author-ana?v=abc' },
      });

      expect(face.imageUrl).toBe('/api/profile/avatar/author-ana?v=abc');
      expect(face.emoji).toBe('📦');
    });

    it('prefers a fresher photo from the override', () => {
      const face = resolveIdentityFace({
        record: { ...RECORD, imageUrl: '/stale.png' },
        override: { imageUrl: '/fresh.png' },
      });

      expect(face.imageUrl).toBe('/fresh.png');
    });

    it('takes the photo on its own axis, like the colour and the emoji', () => {
      // An override carrying only a colour must not delete the record's photo
      // on the way past — the failure the per-half ladder above exists for.
      const face = resolveIdentityFace({
        record: { ...RECORD, imageUrl: '/photo.png' },
        override: { color: '#6366f1' },
      });

      expect(face.imageUrl).toBe('/photo.png');
      expect(face.color).toBe('#6366f1');
    });

    it('leaves it undefined when nobody has one, which is everybody today', () => {
      expect(resolveIdentityFace({ record: RECORD }).imageUrl).toBeUndefined();
    });
  });

  it('passes the kind and the origin straight through', () => {
    // Both are the disc's to interpret. Red if this function ever starts
    // deciding a badge — the divergence it exists to end was two surfaces each
    // deciding one.
    const face = resolveIdentityFace({
      record: { id: 'author-m', kind: 'human', displayName: 'Miguel' },
      origin: { platform: 'telegram' },
    });

    expect(face.kind).toBe('human');
    expect(face.origin).toEqual({ platform: 'telegram' });
    expect(face).not.toHaveProperty('badge');
  });
});

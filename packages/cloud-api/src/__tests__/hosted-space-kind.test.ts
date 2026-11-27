/**
 * The kind of a hosted space: a team space or a community.
 *
 * Pins that the kind round-trips, that a start request or a listed space with
 * no kind reads as a community (so an older app and an older service keep
 * working), and that a kind from a later release reads as unrecognised.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as contract from '../index.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/**
 * Reads one conformance fixture.
 *
 * @param rel - The fixture path relative to `fixtures/v1`.
 */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

/** The first community in the list fixture, an active one. */
function activeCommunity(): Record<string, unknown> {
  return (fixture('communities/list.json').items as Array<Record<string, unknown>>)[0];
}

describe('a team space or a community', () => {
  it('starts a team space when asked, and round-trips the kind', () => {
    const request = contract.CommunityStartRequestSchema.parse(
      fixture('communities/start-request-team.json')
    );
    expect(request.kind).toBe('team');
    expect(request).toEqual(fixture('communities/start-request-team.json'));
  });

  it('reads a start request with no kind as a community, so an older app still parses', () => {
    const { kind: _kind, ...older } = fixture('communities/start-request.json');
    expect(contract.CommunityStartRequestSchema.parse(older).kind).toBe('community');
  });

  it('refuses a start request for a kind it does not know', () => {
    expect(
      contract.CommunityStartRequestSchema.safeParse({
        idempotencyKey: 'k',
        name: 'Acme',
        kind: 'guild',
      }).success
    ).toBe(false);
  });

  it('carries the kind on each listed space, and reads a space with none as a community', () => {
    const list = contract.HostedCommunityListResponseSchema.parse(fixture('communities/list.json'));
    expect(list.items.map((community) => community.kind)).toEqual([
      'community',
      'community',
      'community',
      'team',
      'community',
    ]);
    const { kind: _kind, ...older } = activeCommunity();
    expect(contract.HostedCommunitySchema.parse(older).kind).toBe('community');
  });

  it('reads a kind from a later release as unrecognised, and keeps the rest of the page', () => {
    const parsed = contract.HostedCommunitySchema.parse({ ...activeCommunity(), kind: 'guild' });
    expect(parsed.kind).toBe(contract.UNRECOGNISED);
    expect(
      contract.HostedCommunitySchema.safeParse({ ...activeCommunity(), kind: 7 }).success
    ).toBe(false);
  });
});

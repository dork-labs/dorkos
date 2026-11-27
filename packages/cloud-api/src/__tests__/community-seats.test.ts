/**
 * The seat preview for one invite to a hosted space.
 *
 * The fixtures test proves each example round-trips. This file pins that the
 * preview carries numbers and the service's words and nothing priced, that it
 * asks for nothing but the space, and that the refusal the app shows before a
 * link is made carries the service's words and a link to open.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as contract from '../index.js';
import { v1Path } from '../routes.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/**
 * Reads one conformance fixture.
 *
 * @param rel - The fixture path relative to `fixtures/v1`.
 */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

const preview = contract.CommunitySeatPreviewSchema;

describe('the seat preview for one invite', () => {
  it('reads null seats included as no fixed number, and refuses a negative or fractional count', () => {
    const example = fixture('communities/seat-preview.json');
    expect(preview.parse({ ...example, seatsIncluded: null }).seatsIncluded).toBeNull();
    expect(preview.safeParse({ ...example, seatsIncluded: -1 }).success).toBe(false);
    expect(preview.safeParse({ ...example, seatsUsed: 1.5 }).success).toBe(false);
  });

  it('puts no rule between addsSeat and seats included: with no fixed number, either answer parses', () => {
    const uncounted = preview.parse(fixture('communities/seat-preview-uncounted.json'));
    const eachCounted = preview.parse(fixture('communities/seat-preview-each-counted.json'));
    expect([uncounted.seatsIncluded, uncounted.addsSeat]).toEqual([null, false]);
    expect([eachCounted.seatsIncluded, eachCounted.addsSeat]).toEqual([null, true]);
    const fits = fixture('communities/seat-preview.json');
    expect(preview.safeParse({ ...fits, seatsUsed: 9, addsSeat: false }).success).toBe(true);
  });

  it('needs the service`s words for the line and for who pays', () => {
    const example = fixture('communities/seat-preview.json');
    for (const field of ['summary', 'payer'] as const) {
      expect(preview.safeParse({ ...example, [field]: '' }).success).toBe(false);
      const { [field]: _dropped, ...without } = example;
      expect(preview.safeParse(without).success).toBe(false);
    }
  });

  it('carries no price, amount or plan', () => {
    const fields = Object.keys(preview.shape);
    expect(
      fields.filter((field) => /micro|amount|price|cost|plan|billing|tier|currency/i.test(field))
    ).toEqual([]);
  });

  it('is asked of the space alone, on a path no other route can claim', () => {
    expect(v1Path.communitySeatPreview('c1')).toBe('/v1/communities/c1/seat-preview');
    expect(v1Path.communitySeatPreview('moves/m1')).toBe('/v1/communities/moves%2Fm1/seat-preview');
    for (const fixed of ['moves', 'name-check', 'sign-in', '..']) {
      expect(() => v1Path.communitySeatPreview(fixed)).toThrow(TypeError);
    }
  });

  it('refuses one more person with the service`s words and a link to open', () => {
    const refusal = contract.ProblemSchema.parse(fixture('problem/seat-preview-refused.json'));
    expect(refusal.code).toBe('person_seat_required');
    expect(refusal.title).toBeTruthy();
    expect(refusal.detail).toBeTruthy();
    expect(refusal.actionUrl).toMatch(/^https:\/\//);
    expect(refusal.actionLabel).toBeTruthy();
  });
});

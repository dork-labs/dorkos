/**
 * The adopt wire shapes, and the one field a page branches on.
 *
 * `rule` is a closed set rather than a string: the row draws a sentence today,
 * but the whole point of carrying the rule beside the sentence is that a surface
 * can act on it — and a surface cannot branch on `string`. Closing it here is
 * also what makes the route's own answer checkable, because the route assigns
 * the engine's refusals straight into this shape.
 *
 * @module __tests__/harness-adopt-schemas
 */
import { describe, expect, it } from 'vitest';
import { HarnessAdoptRefusalSchema } from '../harness-schemas.js';

describe('HarnessAdoptRefusalSchema', () => {
  it('accepts every rule the engine can refuse with, including the two run-level ones', () => {
    // The two at the end are `AdoptBlocked`'s, not `AdoptRefusalRule`'s: a
    // blocked run comes back as the refusal for the name that was asked about,
    // so the wire set is the union of both and neither half may be forgotten.
    const rules = [
      'not-adoptable',
      'hostile-path',
      'room-seeded-name',
      'target-exists',
      'source-is-symlink',
      'unreadable-frontmatter',
      'not-on-allowlist',
      'claude-only-wrong-root',
      'cross-device',
      'link-blocked',
      'manifest-unwritable',
      'canonical-layer-ignored',
      'auto-adopt-not-permitted',
    ];
    expect(rules).toHaveLength(13);

    const refused = rules.filter(
      (rule) =>
        !HarnessAdoptRefusalSchema.safeParse({ name: 'x', source: '', reason: 'because', rule })
          .success
    );
    expect(refused).toEqual([]);
  });

  it('rejects a rule nothing in the engine can produce', () => {
    // Seeded defect: leave `rule` as `z.string()` and this passes — the field
    // becomes documentation rather than a contract, and the generated OpenAPI
    // tells a client to expect any string at all.
    expect(
      HarnessAdoptRefusalSchema.safeParse({
        name: 'x',
        source: '',
        reason: 'because',
        rule: 'made-up',
      }).success
    ).toBe(false);
  });
});

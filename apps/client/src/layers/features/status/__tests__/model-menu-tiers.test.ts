/**
 * The tri-state guard on the model menu, tested directly on the predicate
 * rather than through a mounted popover.
 *
 * `ModelOption`'s capability flags are three-valued: `true` and `false` are
 * claims a runtime made, and ABSENT means nobody checked. Only OpenCode reports
 * them; claude-code and codex leave most of them absent by construction. So the
 * whole menu rests on one distinction — `=== false` versus falsy. Loosen
 * `canDoAgentWork` from `!== false` to a truthy test and every claude-code and
 * codex model in the catalog silently falls into "Can't do agent work", because
 * their flag is missing, not negative. Nothing about that failure looks like a
 * bug in this file; it looks like the picker deciding Opus cannot use tools.
 *
 * That is why these assertions pass `undefined` explicitly instead of relying on
 * a fixture that happens to omit the field: the point under test is the value
 * `undefined`, so it is written down.
 */
import { describe, it, expect } from 'vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { groupByTier, modelLimitationNote } from '../lib/model-menu-tiers';

/**
 * A model option carrying only what the menu reads. Capability flags are left to
 * the caller so every case states its own tri-state value.
 *
 * @param overrides - Fields this case cares about.
 */
function model(overrides: Partial<ModelOption> & { value: string }): ModelOption {
  return {
    displayName: overrides.value,
    description: '',
    ...overrides,
  };
}

/**
 * The group slug a single model lands in.
 *
 * @param m - The model option to place.
 */
function groupOf(m: ModelOption): string {
  const groups = groupByTier([m]);
  expect(groups).toHaveLength(1);
  return groups[0]!.slug;
}

describe('capability flags are tri-state, and absent is not "no"', () => {
  // ---- supportsToolUse: the grouping decision ----

  it('keeps a model whose tool support is UNREPORTED out of "Can\'t do agent work"', () => {
    // The claude-code / codex shape before this ticket: no flag at all. Mutating
    // `canDoAgentWork` to `Boolean(model.supportsToolUse)` (or `!!`, or
    // `model.supportsToolUse === true`) makes this red — and that mutation is
    // exactly the regression the whole file guards.
    expect(groupOf(model({ value: 'claude-opus-4-6', supportsToolUse: undefined }))).toBe(
      'more-models'
    );
    expect(
      groupOf(model({ value: 'claude-opus-4-6', tier: 'frontier', supportsToolUse: undefined }))
    ).toBe('frontier');
  });

  it('demotes only a model that explicitly reported it CANNOT call tools', () => {
    expect(groupOf(model({ value: 'chat-only', tier: 'frontier', supportsToolUse: false }))).toBe(
      'no-tools'
    );
  });

  it('leaves a model that explicitly reported it CAN call tools in its own tier', () => {
    expect(groupOf(model({ value: 'capable', tier: 'frontier', supportsToolUse: true }))).toBe(
      'frontier'
    );
  });

  it('never sweeps a whole unreporting catalog into one group', () => {
    // The shape of the real failure: a claude-code catalog, every flag absent.
    // Under a falsy predicate all four collapse into `no-tools`.
    const catalog = [
      model({ value: 'claude-opus-4-6', tier: 'flagship' }),
      model({ value: 'claude-sonnet-4-6', tier: 'balanced' }),
      model({ value: 'gpt-5.5', tier: 'flagship' }),
      model({ value: 'mystery' }),
    ];
    expect(groupByTier(catalog).map((g) => g.slug)).not.toContain('no-tools');
  });

  // ---- The per-card note reads the same three values ----

  it('says nothing about a model that reported no capabilities at all', () => {
    expect(
      modelLimitationNote(
        model({
          value: 'claude-opus-4-6',
          supportsToolUse: undefined,
          supportsImageOutput: undefined,
        })
      )
    ).toBeNull();
  });

  it('warns about images only when a runtime actually claimed them', () => {
    // Inverting the image test to `!== false` — the same loosening, pointed the
    // other way — makes the `undefined` case red instead of null.
    expect(modelLimitationNote(model({ value: 'm', supportsImageOutput: undefined }))).toBeNull();
    expect(modelLimitationNote(model({ value: 'm', supportsImageOutput: false }))).toBeNull();
    expect(modelLimitationNote(model({ value: 'm', supportsImageOutput: true }))).toBe(
      'Makes images, and DorkOS cannot show them yet.'
    );
  });

  it('warns about tools only when a runtime actually denied them', () => {
    expect(modelLimitationNote(model({ value: 'm', supportsToolUse: undefined }))).toBeNull();
    expect(modelLimitationNote(model({ value: 'm', supportsToolUse: true }))).toBeNull();
    expect(modelLimitationNote(model({ value: 'm', supportsToolUse: false }))).toBe(
      "Can't use tools, so it can't read files or run commands."
    );
  });
});

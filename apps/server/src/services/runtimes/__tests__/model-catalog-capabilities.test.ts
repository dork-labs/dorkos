/**
 * Capability flags on the static model catalogs DorkOS hand-writes.
 *
 * `ModelOption.supportsToolUse` / `supportsVision` / `supportsImageOutput` are
 * three-valued on purpose: `true` and `false` are claims, ABSENT means nobody
 * checked, and the client's model menu keys on `=== false` so that an
 * unreporting runtime is never quietly told it cannot do agent work. That
 * contract has two halves, and only one of them lives in the client. The half
 * asserted here is the producer's: a catalog may say yes, may say no, or may say
 * nothing — but whatever it says has to be a real boolean.
 *
 * `null` is the specific value this rules out, because it is the one that
 * divides the two consumer idioms against each other: `x !== false` reads `null`
 * as capable while `x ?? false` reads it as incapable, so a single `null`
 * leaking in (a JSON round-trip, a nullable upstream field) makes two surfaces
 * disagree about the same model with neither of them wrong.
 *
 * Asserted over the REAL exported catalog rather than a fixture, for the reason
 * its sibling `model-catalog-labels.test.ts` gives: a fixture can only fail when
 * someone edits the fixture, which is no invariant at all.
 */
import { describe, it, expect } from 'vitest';
import type { ModelOption } from '@dorkos/shared/types';
import { CODEX_MODELS } from '../codex/runtime-constants.js';

/**
 * Static catalogs DorkOS authors itself, so every field in them is a claim
 * DorkOS makes rather than one a backend reported. Claude Code's catalog is
 * built by a mapper over live SDK rows and is covered where that mapper lives
 * (`claude-code/__tests__/runtime-cache.test.ts`); OpenCode's comes from its
 * sidecar. A new runtime shipping a hand-written catalog belongs on this list.
 */
const STATIC_CATALOGS: Record<string, readonly ModelOption[]> = {
  codex: CODEX_MODELS,
};

/** The three flags whose absence must stay distinguishable from a `false`. */
const CAPABILITY_FLAGS = ['supportsToolUse', 'supportsVision', 'supportsImageOutput'] as const;

describe('static model catalogs answer capability questions in booleans or not at all', () => {
  for (const [runtime, catalog] of Object.entries(STATIC_CATALOGS)) {
    it(`states every ${runtime} capability as a real boolean or leaves it absent`, () => {
      expect(catalog.length).toBeGreaterThan(0);
      for (const model of catalog) {
        for (const flag of CAPABILITY_FLAGS) {
          const value = model[flag] as unknown;
          expect(
            value === undefined || typeof value === 'boolean',
            `${runtime} model "${model.value}" reports ${flag} as ${JSON.stringify(value)}. It must be true, false, or absent — anything else (null especially) is read as "capable" by the model menu and as "incapable" by every \`?? false\` reader.`
          ).toBe(true);
        }
      }
    });
  }

  it('claims tool use and denies image output for every Codex model', () => {
    // The claim this ticket added (DOR-1672). Codex drives a tool-calling agent
    // loop, so a model that could not call tools could not be in this catalog;
    // and none of the GPT-5.x reasoning models returns generated images. Both are
    // knowable, so both are stated rather than left blank.
    //
    // Deleting either line from `CODEX_MODEL_CAPABILITIES` makes this red. If a
    // future model genuinely differs, override the flag on ITS entry — do not
    // weaken the shared constant and do not delete this test.
    for (const model of CODEX_MODELS) {
      expect(model.supportsToolUse, `${model.value} must claim tool use`).toBe(true);
      expect(model.supportsImageOutput, `${model.value} must deny image output`).toBe(false);
      expect(model.supportsVision, `${model.value} must claim vision`).toBe(true);
    }
  });
});

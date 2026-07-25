/**
 * The status line promises that every label DorkOS itself writes fits its
 * character bound outright — the bound exists for strings a third party hands us,
 * not for our own catalogs. A model name is the easiest place for that promise to
 * quietly stop being true, because a catalog gains an entry in one file and the
 * bound lives in another: `GPT-5.3 Codex` is 13 characters, and against a bound of
 * 12 a Codex session on a wide desktop read `GPT-5.3 Cod…` for a release (DOR-452).
 *
 * So the invariant is asserted here, over the real catalogs, rather than over a
 * fixture in the client's own test file — a fixture can only fail when someone
 * edits the fixture, which is no invariant at all.
 */
import { describe, it, expect } from 'vitest';
import { STATUS_VALUE_MAX_CHARS } from '@dorkos/shared/constants';
import type { ModelOption } from '@dorkos/shared/types';
import { CODEX_MODELS } from '../codex/runtime-constants.js';

/**
 * Every static model catalog DorkOS authors itself. Runtimes that resolve their
 * catalog at runtime are deliberately absent: Claude Code's comes from the SDK and
 * OpenCode's from its sidecar's provider list, so those names are third-party
 * strings the status line bounds on the way out rather than promises DorkOS makes.
 * A new runtime that ships a hand-written catalog belongs on this list.
 */
const FIRST_PARTY_CATALOGS: Record<string, readonly ModelOption[]> = {
  codex: CODEX_MODELS,
};

describe('first-party model catalogs fit the status line', () => {
  for (const [runtime, catalog] of Object.entries(FIRST_PARTY_CATALOGS)) {
    it(`keeps every ${runtime} model display name within the status value bound`, () => {
      expect(catalog.length).toBeGreaterThan(0);
      for (const model of catalog) {
        expect(
          Array.from(model.displayName).length,
          `${runtime} model "${model.value}" renders as "${model.displayName}" (${model.displayName.length} chars), which the status line would truncate. Shorten the name, or raise STATUS_VALUE_MAX_CHARS and the slot cost derived from it.`
        ).toBeLessThanOrEqual(STATUS_VALUE_MAX_CHARS);
      }
    });
  }
});

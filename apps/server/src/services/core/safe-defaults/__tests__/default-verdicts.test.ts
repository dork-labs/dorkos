import { describe, it, expect } from 'vitest';
import {
  NO_RISK_DEFAULTS,
  SAFE_DEFAULTS,
  PERMISSIVE_DEFAULTS,
  verdictFor,
} from '../default-verdicts.js';
import { PROTECTIVE_CARRYOVERS } from '../protected-state.js';
import { configSchemaLeafPaths } from '../../operator/config-disclosure.js';

/**
 * The drift guard. It exists so the safe-defaults principle can be FAILED: a
 * config field added without a stated verdict turns this file red, at the moment
 * it is added rather than at the next audit.
 */
describe('config default verdicts cover the whole schema', () => {
  const leaves = configSchemaLeafPaths();
  const classified = [...NO_RISK_DEFAULTS, ...SAFE_DEFAULTS, ...Object.keys(PERMISSIVE_DEFAULTS)];

  it('classifies every leaf of UserConfigSchema', () => {
    const missing = leaves.filter((path) => verdictFor(path) === undefined);
    expect(
      missing,
      `Unclassified config default(s). Every default must state what it does for the person who ` +
        `never touches it. Add each path to NO_RISK_DEFAULTS, SAFE_DEFAULTS, or PERMISSIVE_DEFAULTS ` +
        `(with a reason) in safe-defaults/default-verdicts.ts:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('classifies nothing that is not a leaf — a rename must not leave a stale verdict', () => {
    const known = new Set(leaves);
    const stale = classified.filter((path) => !known.has(path));
    expect(
      stale,
      `Verdict(s) for path(s) that no longer exist in UserConfigSchema:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });

  it('gives each leaf exactly one verdict', () => {
    const seen = new Set<string>();
    const duplicates = classified.filter((path) =>
      seen.has(path) ? true : (seen.add(path), false)
    );
    expect(duplicates, `Path(s) classified twice:\n  ${duplicates.join('\n  ')}`).toEqual([]);
  });

  it('makes every permissive default carry a real argument', () => {
    for (const [path, reason] of Object.entries(PERMISSIVE_DEFAULTS)) {
      expect(reason.length, `${path}: a permissive default needs a stated reason`).toBeGreaterThan(
        60
      );
    }
  });

  it('keeps the permissive list short enough to actually read', () => {
    // Not a style rule. A registry where the permissive list has grown to
    // dozens of entries has stopped being a set of reviewed trades and become
    // a rubber stamp, which is the failure mode this whole mechanism has.
    expect(Object.keys(PERMISSIVE_DEFAULTS).length).toBeLessThanOrEqual(15);
  });
});

describe('verdicts and wipe-carryover agree', () => {
  it('only carries leaves that can actually lose something', () => {
    // A carryover rule for a leaf whose default is already protective can never
    // fire; a carryover rule for a no-risk leaf is protecting a preference.
    for (const entry of PROTECTIVE_CARRYOVERS) {
      const verdict = verdictFor(entry.path);
      expect(
        verdict,
        `${entry.path} has a carryover rule but verdict "${verdict}". A carryover only makes ` +
          `sense where the default sits on the permissive side, or where a person can tighten ` +
          `a bound below it.`
      ).not.toBe('no-risk');
    }
  });

  it('carries every Tier 1 telemetry channel that defaults ON', () => {
    // The reported defect in one assertion: a channel that defaults ON and has
    // no carryover rule is a privacy choice a wipe can silently reverse.
    const tier1 = Object.keys(PERMISSIVE_DEFAULTS).filter((path) => path.startsWith('telemetry.'));
    const carried = new Set(PROTECTIVE_CARRYOVERS.map((entry) => entry.path));
    for (const path of tier1) {
      expect(carried, `${path} defaults ON but would not survive a config wipe`).toContain(path);
    }
  });
});

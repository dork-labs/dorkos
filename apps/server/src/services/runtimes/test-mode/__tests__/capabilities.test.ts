/**
 * Contract tests for `TEST_MODE_CAPABILITIES`.
 *
 * Guards the DELIBERATE DIFFERENCE from `CLAUDE_CODE_CAPABILITIES`: if a
 * future edit makes the two shapes converge (overlapping permission-mode
 * ids or overlapping `features` keys), these tests fail and force the
 * editor to justify the convergence. The browser leg in
 * `apps/e2e/tests/chat/runtime-capability-parity.ts` relies on the ids not
 * overlapping. Single-constant echoes were removed: they restated the
 * declaration and could only fail when someone edited it on purpose.
 */
import { describe, it, expect } from 'vitest';
import { TEST_MODE_CAPABILITIES } from '../runtime-constants.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../claude-code/runtime-constants.js';
import { builtInScenarioNames } from '../scenario-store.js';

describe('TEST_MODE_CAPABILITIES', () => {
  it('lists only real built-in scenarios under features.testModeScenarios', () => {
    const scenarios = TEST_MODE_CAPABILITIES.features.testModeScenarios as string[];
    expect(scenarios.length).toBeGreaterThan(0);

    // Checked against the store itself, not against a literal. A hardcoded
    // expected list here was a SECOND copy of the register this test exists to
    // police, so the two could only ever drift together or fail for the wrong
    // reason — which is what happened when `long-turn` was published.
    //
    // A subset, deliberately, not equality: the store also holds the `demo-*`
    // and `q3-*` families, which are capture- and measurement-only and are not
    // advertised as capabilities. What must never happen is the reverse — a
    // capability naming a scenario nothing serves.
    const known = builtInScenarioNames();
    expect(scenarios.filter((name) => !known.includes(name))).toEqual([]);
  });
});

describe('cross-runtime capability contract', () => {
  it('test-mode and claude-code permission-mode ids do not overlap', () => {
    const claudeIds = new Set(CLAUDE_CODE_CAPABILITIES.permissionModes.values.map((v) => v.id));
    const testModeIds = new Set(TEST_MODE_CAPABILITIES.permissionModes.values.map((v) => v.id));
    const overlap = [...testModeIds].filter((id) => claudeIds.has(id));
    expect(overlap).toEqual([]);
  });

  it('test-mode and claude-code features keys do not overlap', () => {
    const claudeKeys = new Set(Object.keys(CLAUDE_CODE_CAPABILITIES.features));
    const testModeKeys = new Set(Object.keys(TEST_MODE_CAPABILITIES.features));
    const overlap = [...testModeKeys].filter((k) => claudeKeys.has(k));
    expect(overlap).toEqual([]);
  });
});

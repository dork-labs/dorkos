/**
 * The orderings the Wi-Fi checks share (DOR-3037): a mode, a permission state,
 * a Files & commands stop and a settings patch, each judged raise or not by
 * the product's own ranks. Where a result cannot be told, it is a raise.
 */
import { describe, expect, it } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import {
  modeRaises,
  presetRaises,
  stateRaises,
  stopRaises,
  trustStopPatchRaises,
} from '../sessions/wifi-raise-guard.js';

const MODES = CLAUDE_CODE_CAPABILITIES.permissionModes;

describe('modeRaises', () => {
  it('reads a looser mode as a raise, and the same or stricter as not', () => {
    expect(modeRaises(MODES, 'default', 'bypassPermissions')).toBe(true);
    expect(modeRaises(MODES, 'default', 'acceptEdits')).toBe(true);
    expect(modeRaises(MODES, 'default', 'auto')).toBe(true);
    expect(modeRaises(MODES, 'bypassPermissions', 'default')).toBe(false);
    expect(modeRaises(MODES, 'default', 'plan')).toBe(false);
    expect(modeRaises(MODES, 'default', 'default')).toBe(false);
  });

  it('measures from the runtime default when nothing is stored, and refuses an unknown id', () => {
    expect(modeRaises(MODES, null, 'plan')).toBe(false);
    expect(modeRaises(MODES, null, 'bypassPermissions')).toBe(true);
    expect(modeRaises(MODES, 'default', 'made-up')).toBe(true);
  });
});

describe('stateRaises and stopRaises', () => {
  it('ranks Allowed below Ask below Blocked', () => {
    expect(stateRaises('ask', 'allowed')).toBe(true);
    expect(stateRaises('ask', 'blocked')).toBe(false);
    expect(stateRaises('blocked', undefined)).toBe(true);
  });

  it('ranks Full autonomy below Act below Ask first, and reads unknowns strictly', () => {
    expect(stopRaises('act', 'autonomy')).toBe(true);
    expect(stopRaises('autonomy', 'ask')).toBe(false);
    expect(stopRaises(null, 'act')).toBe(true);
    expect(stopRaises(null, 'ask')).toBe(false);
    expect(stopRaises('ask', null)).toBe(true);
  });
});

describe('presetRaises', () => {
  it('takes only Careful, and only without agents brought along', () => {
    expect(presetRaises('careful', undefined)).toBe(false);
    expect(presetRaises('trusted', undefined)).toBe(true);
    expect(presetRaises('careful', ['agent-1'])).toBe(true);
  });
});

describe('trustStopPatchRaises', () => {
  const stored = { defaultTrustStop: 'act' as const, claudeCode: { defaultTrustStop: null } };

  it('reads a patch without stops as no raise', () => {
    expect(trustStopPatchRaises({ ui: { theme: 'dark' } }, stored)).toBe(false);
  });

  it('refuses loosening everyone’s stop, or a runtime that follows it', () => {
    expect(trustStopPatchRaises({ runtimes: { defaultTrustStop: 'autonomy' } }, stored)).toBe(true);
    expect(
      trustStopPatchRaises({ runtimes: { claudeCode: { defaultTrustStop: 'autonomy' } } }, stored)
    ).toBe(true);
    // Unsetting a runtime's own Ask first falls back to everyone's Act.
    expect(
      trustStopPatchRaises(
        { runtimes: { codex: { defaultTrustStop: null } } },
        { defaultTrustStop: 'act', codex: { defaultTrustStop: 'ask' } }
      )
    ).toBe(true);
  });

  it('takes tightening', () => {
    expect(trustStopPatchRaises({ runtimes: { defaultTrustStop: 'ask' } }, stored)).toBe(false);
    expect(
      trustStopPatchRaises({ runtimes: { claudeCode: { defaultTrustStop: 'ask' } } }, stored)
    ).toBe(false);
  });
});

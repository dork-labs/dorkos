/**
 * A session carried over to another runtime never starts with more power than
 * the source (spec `claude-account-fleet` D9, step 4c): one test per runtime
 * pair, against the profiles the runtimes really declare.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import { carriedStop, crossRuntimePermissionMode } from '../carry-over-power.js';

const PROFILES = {
  'claude-code': CLAUDE_CODE_CAPABILITIES.permissionModes,
  codex: CODEX_CAPABILITIES.permissionModes,
  opencode: OPENCODE_CAPABILITIES.permissionModes,
} as const;

type Runtime = keyof typeof PROFILES;

/** The id a runtime declares at a stop (first declared wins). */
function modeAt(runtime: Runtime, stop: 'ask' | 'act'): string {
  return PROFILES[runtime].values.find((d) => d.stop === stop && d.axis !== 'working')!.id;
}

/** The id a runtime declares for autonomy. */
function autonomyMode(runtime: Runtime): string {
  return PROFILES[runtime].values.find((d) => d.stop === 'autonomy')!.id;
}

const PAIRS: [Runtime, Runtime][] = [
  ['claude-code', 'codex'],
  ['claude-code', 'opencode'],
  ['codex', 'claude-code'],
  ['codex', 'opencode'],
  ['opencode', 'claude-code'],
  ['opencode', 'codex'],
];

describe('crossRuntimePermissionMode', () => {
  it.each(PAIRS)(
    '%s → %s keeps the stop, caps autonomy at act, and reads unknown as ask',
    (from, to) => {
      const map = (mode: string | undefined) =>
        crossRuntimePermissionMode(mode, PROFILES[from], PROFILES[to]);

      // The same stop, in the target's own vocabulary.
      expect(map(modeAt(from, 'ask'))).toBe(modeAt(to, 'ask'));
      expect(map(modeAt(from, 'act'))).toBe(modeAt(to, 'act'));
      // Autonomy (bypass) is never carried across runtimes.
      expect(map(autonomyMode(from))).toBe(modeAt(to, 'act'));
      expect(map(autonomyMode(from))).not.toBe(autonomyMode(to));
      // A mode the source does not declare reads as ask.
      expect(map('not-a-mode')).toBe(modeAt(to, 'ask'));
    }
  );

  it('reads Claude Code’s plan (a way of working) as ask', () => {
    expect(carriedStop('plan', PROFILES['claude-code'])).toBe('ask');
  });

  it('reads a session with no stored mode at its runtime’s default', () => {
    expect(carriedStop(undefined, PROFILES['claude-code'])).toBe('ask');
  });

  it('falls back to the target’s most restrictive mode when it has none at the stop', () => {
    const noAct: PermissionModeDescriptor[] = PROFILES.codex.values.filter((d) => d.stop !== 'act');
    expect(
      crossRuntimePermissionMode('acceptEdits', PROFILES['claude-code'], { values: noAct })
    ).toBe(modeAt('codex', 'ask'));
  });
});

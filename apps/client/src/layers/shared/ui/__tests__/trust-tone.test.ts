/**
 * The colour economy, pinned.
 *
 * Two things are worth a test here and the rest is taste.
 *
 * **First, that the answer comes from what a runtime DECLARED and not from a
 * mode id.** Pinning that needs care, because DorkOS NORMALIZES ids: Claude and
 * Codex both declare their top stop as `bypassPermissions` and Codex carries its
 * own spelling in `native` instead, so a pair of those two proves nothing — an
 * `id === 'bypassPermissions'` implementation would satisfy both and the test
 * would sit there green through exactly the regression it exists to catch.
 * `test-mode`'s `always-allow` is the shipped autonomy stop whose id is
 * genuinely different, so it is the fixture that carries the property. Codex
 * stays for the case beside it: same normalized id, different `native`.
 *
 * **Second, that red is gone**: no tone this module can return paints one,
 * because the whole point of the flip is that a red left anywhere on a trust
 * setting teaches people to stop reading red.
 */
import { describe, it, expect } from 'vitest';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';

import { TRUST_TONE_TEXT, trustTone, trustToneAccent, trustToneText } from '../trust-tone';

/** Claude Code's top stop, as `runtime-constants.ts` declares it. */
const CLAUDE_AUTONOMY: PermissionModeDescriptor = {
  id: 'bypassPermissions',
  label: 'Bypass permissions',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs everything without asking, including outside this project.',
};

/**
 * Codex's top stop. The SAME normalized id as Claude's, with the runtime's own
 * word in `native` — which is exactly why this fixture cannot carry the
 * id-independence property on its own.
 */
const CODEX_AUTONOMY: PermissionModeDescriptor = {
  id: 'bypassPermissions',
  label: 'Full access',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Runs everything without asking, anywhere on your machine, network included.',
  native: 'danger-full-access',
};

/**
 * `test-mode`'s top stop, verbatim from its shipped profile
 * (`services/runtimes/test-mode/runtime-constants.ts`). The id no client name
 * list has ever heard of, and the one fixture here that can actually catch an
 * implementation reading ids instead of semantics.
 */
const TEST_MODE_AUTONOMY: PermissionModeDescriptor = {
  id: 'always-allow',
  label: 'Always allow',
  stop: 'autonomy',
  asks: 'never',
  reach: 'everything',
  promise: 'Approves every request without asking. For tests only.',
};

/** Codex's middle stop — sits at "ask when risky" and never asks. */
const CODEX_WORKSPACE_WRITE: PermissionModeDescriptor = {
  id: 'acceptEdits',
  label: 'Workspace write',
  stop: 'act',
  asks: 'never',
  reach: 'edit',
  promise: 'Edits and runs commands in this project without asking.',
};

/** The resting state — the stop that stops for you. */
const ASK_FIRST: PermissionModeDescriptor = {
  id: 'default',
  label: 'Ask first',
  stop: 'ask',
  asks: 'always',
  reach: 'edit',
  promise: 'Asks before it changes anything.',
};

/** Codex's read-only default: never asks, because it has nothing to ask about. */
const CODEX_READ_ONLY: PermissionModeDescriptor = {
  id: 'default',
  label: 'Read only',
  stop: 'ask',
  asks: 'never',
  reach: 'read',
  promise: 'Reads your project and answers. Cannot change anything.',
};

describe('trustTone', () => {
  it('reads full power as power, whatever the runtime calls it', () => {
    // `always-allow` is the one that matters: an implementation keyed on
    // `bypassPermissions` passes the first two and fails here.
    expect(trustTone(CLAUDE_AUTONOMY)).toBe('power');
    expect(trustTone(CODEX_AUTONOMY)).toBe('power');
    expect(trustTone(TEST_MODE_AUTONOMY)).toBe('power');
  });

  it('reads a top stop whose id no name list knows', () => {
    // Stated on its own as well as in the sweep above, so a future edit that
    // trims the sweep back to the two familiar ids cannot quietly retire the
    // property this whole file exists for.
    expect(TEST_MODE_AUTONOMY.id).not.toBe(CLAUDE_AUTONOMY.id);
    expect(trustTone(TEST_MODE_AUTONOMY)).toBe('power');
    expect(trustToneText(TEST_MODE_AUTONOMY)).toBe('text-status-success');
    expect(trustToneAccent(TEST_MODE_AUTONOMY)).toBe('text-status-success');
  });

  it('keeps amber for a runtime that asks less than its stop promised', () => {
    expect(trustTone(CODEX_WORKSPACE_WRITE)).toBe('divergent');
  });

  it('leaves the cautious choice unmarked — nothing shames it', () => {
    expect(trustTone(ASK_FIRST)).toBe('neutral');
  });

  it('says nothing about a mode that can only read', () => {
    expect(trustTone(CODEX_READ_ONLY)).toBe('neutral');
  });

  it('makes no claim before the runtime has answered', () => {
    expect(trustTone(undefined)).toBe('neutral');
  });
});

describe('the classes each tone paints', () => {
  it('paints full power in the success token, not a hand-picked green', () => {
    expect(TRUST_TONE_TEXT.power).toBe('text-status-success');
  });

  it('spends no red on any trust setting', () => {
    for (const className of Object.values(TRUST_TONE_TEXT)) {
      expect(className).not.toMatch(/red/);
    }
  });

  it('paints only full power where a surface already has a colour', () => {
    expect(trustToneAccent(CLAUDE_AUTONOMY)).toBe('text-status-success');
    // The strip is one word wide; the caption inside the popover carries the
    // amber and the sentence that explains it.
    expect(trustToneAccent(CODEX_WORKSPACE_WRITE)).toBe('');
    expect(trustToneAccent(ASK_FIRST)).toBe('');
  });

  it('paints muted where a surface owns its whole colour', () => {
    expect(trustToneText(ASK_FIRST)).toBe('text-muted-foreground');
    expect(trustToneText(CODEX_WORKSPACE_WRITE)).toContain('amber');
    expect(trustToneText(CLAUDE_AUTONOMY)).toBe('text-status-success');
  });
});

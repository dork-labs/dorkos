/**
 * The two constants the autonomy doors publish, pinned by VALUE.
 *
 * Both leave this package as bare strings that nothing type-checks:
 *
 * - `AUTONOMY_ACK_REQUIRED_CODE` is compared as a literal by the cockpit
 *   (`ChatStatusSection.tsx`) and by `dorkos config set`, which reaches the
 *   server only through a specifier esbuild rewrites at bundle time and so
 *   cannot import a constant at all.
 * - `AUTONOMY_DEFAULT_ACK_MESSAGE` is the sentence BOTH the cockpit and the
 *   terminal show a person, so it is user-facing copy, not an internal token.
 *
 * A rename or a rewording is therefore a change in places the compiler cannot
 * see. This file is what makes that deliberate instead of silent (DOR-1247).
 */
import { describe, it, expect } from 'vitest';
import { AUTONOMY_ACK_REQUIRED_CODE, AUTONOMY_DEFAULT_ACK_MESSAGE } from '../autonomy-consent.js';

describe('the autonomy door’s published constants', () => {
  it('keeps the refusal code its two literal consumers compare against', () => {
    // If you are changing this, change `ChatStatusSection.tsx` and
    // `packages/cli/src/config-commands.ts` in the same commit.
    expect(AUTONOMY_ACK_REQUIRED_CODE).toBe('AUTONOMY_ACK_REQUIRED');
  });

  it('keeps the sentence the cockpit and the terminal both show', () => {
    expect(AUTONOMY_DEFAULT_ACK_MESSAGE).toBe(
      'Starting every new session in Full autonomy needs you to confirm what it means first.'
    );
  });
});

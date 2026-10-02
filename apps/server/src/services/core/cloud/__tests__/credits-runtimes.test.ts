/**
 * Where a runtime's own sign-in stands, as the credits defaults read it: only
 * "no sign-in at all" is a gap a new link may fill (ADR 261001-000811).
 */
import { describe, expect, it } from 'vitest';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { signInStateOf } from '../credits-runtimes.js';

const CLI: DependencyCheck = { name: 'Claude Code CLI', description: 'cli', status: 'satisfied' };
const auth = (over: Partial<DependencyCheck>): DependencyCheck => ({
  name: 'Claude Code authentication',
  description: 'auth',
  status: 'satisfied',
  ...over,
});

describe('signInStateOf', () => {
  it('reads a ready runtime as working', () => {
    expect(signInStateOf('claude-code', [CLI, auth({})])).toBe('working');
  });

  it('reads a sign-in that ran out (a known deadline) as needing attention, never a gap', () => {
    expect(
      signInStateOf('claude-code', [
        CLI,
        auth({ status: 'missing', expiresAt: '2026-09-01T00:00:00.000Z' }),
      ])
    ).toBe('needs-attention');
    expect(signInStateOf('claude-code', [CLI, auth({ status: 'outdated' })])).toBe(
      'needs-attention'
    );
  });

  it('reads no sign-in at all as none', () => {
    expect(signInStateOf('claude-code', [CLI, auth({ status: 'missing' })])).toBe('none');
  });

  it('reads anything it cannot classify as needing attention, which fills nothing', () => {
    expect(signInStateOf('claude-code', [{ ...CLI, status: 'missing' }])).toBe('needs-attention');
  });
});

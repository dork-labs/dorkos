/**
 * Where a runtime's own sign-in stands, as the credits defaults and every
 * surface that offers DorkOS credits read it: only "no sign-in at all" is a gap
 * credits may lead in or be filled into (ADR 261001-000811).
 */
import { describe, expect, it } from 'vitest';
import { deriveRuntimeSignIn, type DependencyCheck } from '../agent-runtime.js';

const CLI: DependencyCheck = { name: 'Claude Code CLI', description: 'cli', status: 'satisfied' };
const auth = (over: Partial<DependencyCheck>): DependencyCheck => ({
  name: 'Claude Code authentication',
  description: 'auth',
  status: 'satisfied',
  ...over,
});

describe('deriveRuntimeSignIn', () => {
  it('reads a ready runtime as working', () => {
    expect(deriveRuntimeSignIn('claude-code', [CLI, auth({})])).toBe('working');
  });

  it('reads a sign-in that ran out (a known deadline) as needing attention, never a gap', () => {
    expect(
      deriveRuntimeSignIn('claude-code', [
        CLI,
        auth({ status: 'missing', expiresAt: '2026-09-01T00:00:00.000Z' }),
      ])
    ).toBe('needs-attention');
    expect(deriveRuntimeSignIn('claude-code', [CLI, auth({ status: 'outdated' })])).toBe(
      'needs-attention'
    );
  });

  it('reads no sign-in at all as none', () => {
    expect(deriveRuntimeSignIn('claude-code', [CLI, auth({ status: 'missing' })])).toBe('none');
  });

  it('reads anything it cannot classify as needing attention, which fills nothing', () => {
    expect(deriveRuntimeSignIn('claude-code', [{ ...CLI, status: 'missing' }])).toBe(
      'needs-attention'
    );
  });
});

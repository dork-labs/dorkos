/**
 * Where a runtime's own sign-in stands, as the credits defaults read it: only
 * "no sign-in at all" is a gap a new link may fill (ADR 261001-000811).
 */
import { describe, expect, it, vi } from 'vitest';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';

// What the gap fill saw when it ran: whether the first token had arrived yet.
const order = vi.hoisted(() => ({ steps: [] as string[], tokenArrived: false }));
vi.mock('../credits-defaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../credits-defaults.js')>()),
  fillCreditsGaps: vi.fn(async () => {
    order.steps.push(order.tokenArrived ? 'fill after the token' : 'fill before the token');
    return [];
  }),
}));
vi.mock('../../runtime-registry.js', () => ({ runtimeRegistry: { listRuntimes: () => [] } }));

import { fillCreditsGapsOnNewLink, signInStateOf } from '../credits-runtimes.js';

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

describe('filling the gaps on a new link', () => {
  it('waits for the link’s first token, so the formats it serves decide what is filled', async () => {
    order.steps = [];
    order.tokenArrived = false;
    await fillCreditsGapsOnNewLink('acct-1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.tokenArrived = true;
      return true;
    });
    expect(order.steps).toEqual(['fill after the token']);
  });

  it('still fills after a wait that gave up, on what is known then (Claude Code only)', async () => {
    order.steps = [];
    order.tokenArrived = false;
    await fillCreditsGapsOnNewLink('acct-1', async () => false);
    expect(order.steps).toEqual(['fill before the token']);
  });
});

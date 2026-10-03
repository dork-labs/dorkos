/**
 * A new link fills the credits gaps only after its first token, so the formats
 * it serves decide what is filled (ADR 261001-000811). Where a runtime's own
 * sign-in stands is `deriveRuntimeSignIn`, tested in `@dorkos/shared`.
 */
import { describe, expect, it, vi } from 'vitest';

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

import { fillCreditsGapsOnNewLink } from '../credits-runtimes.js';

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

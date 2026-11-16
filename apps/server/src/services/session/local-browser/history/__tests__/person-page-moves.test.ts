import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { PersonPageMoves } from '../person-page-moves.js';

/** A tab whose history can't be read: any step that got that far would say so. */
function unreadablePage() {
  const newCDPSession = vi.fn(async () => {
    throw new Error('the step reached the page');
  });
  const page = { context: () => ({ newCDPSession }), once: vi.fn() } as unknown as Page;
  return { page, newCDPSession };
}

describe('PersonPageMoves.step', () => {
  it('takes the page first, then waits out an agent action already running', async () => {
    const { page, newCDPSession } = unreadablePage();
    const takeOver = vi.fn();
    const moves = new PersonPageMoves({
      mode: () => 'new-window',
      attachment: () => undefined,
      appOrigins: () => [],
      agentActing: () => true,
    });
    await expect(moves.step(page, 'back', takeOver)).rejects.toMatchObject({ code: 'busy' });
    expect(takeOver).toHaveBeenCalledOnce();
    // The page never moved while the agent's action could still move it.
    expect(newCDPSession).not.toHaveBeenCalled();
  });

  it('moves once no agent action is running', async () => {
    const { page, newCDPSession } = unreadablePage();
    const moves = new PersonPageMoves({
      mode: () => 'new-window',
      attachment: () => undefined,
      appOrigins: () => [],
      agentActing: () => false,
    });
    await expect(moves.step(page, 'back', vi.fn())).rejects.toThrow('the step reached the page');
    expect(newCDPSession).toHaveBeenCalled();
  });
});

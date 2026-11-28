/**
 * The server wakes the waiting agent after a hand back, with fixed text only (DOR-3112), as one
 * wake per hand-off (spec `turns-survive-restarts` §6.3, T7). What the wake does after that is
 * the run record's, proven in `services/runs/__tests__/wake-chat.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LocalBrowserHandoff } from '@dorkos/shared/local-browser';
import type { WakeRequest } from '@dorkos/shared/turn-port';
import { logger } from '../../../../lib/logger.js';
import { HANDED_BACK_MESSAGE, handBackWake } from '../hand-back-wake/index.js';

const handoff = (outcome: LocalBrowserHandoff['outcome']): LocalBrowserHandoff => ({
  id: 'h1',
  sessionId: 'chat-1',
  agentName: 'Ana',
  agentId: 'agent-ana',
  agentFolder: '/agents/ana',
  profileId: null,
  reason: 'wall',
  site: 'checkout.made-up-shop.example',
  askedAt: '2026-11-11T12:00:00.000Z',
  outcome,
});

/** The listener over a door that keeps what it was asked to save. */
function listen(save: (request: WakeRequest) => boolean = () => true) {
  const wakes: WakeRequest[] = [];
  const listener = handBackWake({
    wake: (request) => {
      wakes.push(request);
      return save(request);
    },
  });
  return { listener, wakes };
}

describe('handBackWake', () => {
  it('saves one wake per hand-off, keyed by its id, as the person’s message to their chat', () => {
    const { listener, wakes } = listen();
    listener(handoff('handed-back'));
    expect(wakes).toEqual([
      {
        sourceKind: 'hand-back',
        eventId: 'h1',
        start: {
          sessionId: 'chat-1',
          content: HANDED_BACK_MESSAGE,
          origin: { kind: 'interactive' },
          tier: 'owner',
        },
      },
    ]);
  });

  it('carries nothing from the handoff but its chat: no site, agent or address', () => {
    const { listener, wakes } = listen();
    listener(handoff('handed-back'));
    const sent = JSON.stringify(wakes);
    for (const fromPage of ['made-up-shop', 'http', 'Ana', '/agents/ana'])
      expect(sent).not.toContain(fromPage);
  });

  it('wakes nothing on Stop, a closed window, or a handoff still open', () => {
    const { listener, wakes } = listen();
    listener(handoff('stopped'));
    listener(handoff('window-closed'));
    listener(handoff(null));
    expect(wakes).toEqual([]);
  });

  it('never throws when the wake cannot be saved', () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const { listener } = listen(() => {
        throw new Error('disk full');
      });
      expect(() => listener(handoff('handed-back'))).not.toThrow();
      expect(warning).toHaveBeenCalledWith('[Browser] Couldn’t wake the agent after a hand back', {
        handoffId: 'h1',
        error: 'disk full',
      });
    } finally {
      warning.mockRestore();
    }
  });
});

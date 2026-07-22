import { describe, it, expect } from 'vitest';
import {
  orderAgentCards,
  MAX_AGENT_CARDS,
  type DashboardAgentCard,
} from '../lib/order-agent-cards';

function card(path: string, lastActivityIso: string | null): DashboardAgentCard {
  return {
    path,
    displayName: path,
    color: '#000',
    emoji: '🤖',
    attention: 'inactive',
    lastActivityIso,
  };
}

describe('orderAgentCards', () => {
  it('puts the default agent first, even when it has no activity', () => {
    const cards = [
      card('/agents/a', '2026-07-22T10:00:00.000Z'),
      card('/agents/default', null),
      card('/agents/b', '2026-07-22T09:00:00.000Z'),
    ];
    const ordered = orderAgentCards(cards, '/agents/default');
    expect(ordered.map((c) => c.path)).toEqual(['/agents/default', '/agents/a', '/agents/b']);
  });

  it('orders non-default agents by most-recent activity first', () => {
    const cards = [
      card('/agents/old', '2026-07-20T00:00:00.000Z'),
      card('/agents/new', '2026-07-22T00:00:00.000Z'),
      card('/agents/mid', '2026-07-21T00:00:00.000Z'),
    ];
    const ordered = orderAgentCards(cards, '/agents/none');
    expect(ordered.map((c) => c.path)).toEqual(['/agents/new', '/agents/mid', '/agents/old']);
  });

  it('sorts never-active agents after active ones', () => {
    const cards = [card('/agents/never', null), card('/agents/active', '2026-07-22T00:00:00.000Z')];
    const ordered = orderAgentCards(cards, '/agents/none');
    expect(ordered.map((c) => c.path)).toEqual(['/agents/active', '/agents/never']);
  });

  it('is stable for equal recency (preserves input order)', () => {
    const cards = [card('/agents/x', null), card('/agents/y', null), card('/agents/z', null)];
    const ordered = orderAgentCards(cards, '/agents/none');
    expect(ordered.map((c) => c.path)).toEqual(['/agents/x', '/agents/y', '/agents/z']);
  });

  it('does not mutate its input', () => {
    const cards = [card('/agents/a', null), card('/agents/default', null)];
    orderAgentCards(cards, '/agents/default');
    expect(cards.map((c) => c.path)).toEqual(['/agents/a', '/agents/default']);
  });

  it('caps the visible fleet at six', () => {
    expect(MAX_AGENT_CARDS).toBe(6);
  });
});

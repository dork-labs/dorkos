/**
 * Who can lift a file cap (DOR-3703, M4, the PM's row note): only an ordinary
 * turn of the agent's own counts. A heartbeat beat, a scheduled run, and a
 * spin-off or a message a run started never do.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const sessions = vi.hoisted(() => [] as { id: string; updatedAt: string }[]);
vi.mock('../../../session/catalog/recent-sessions.js', () => ({
  listRecentSessions: async () => ({ sessions, agentActivity: {}, warnings: [] }),
}));

import { liveOrdinaryTurns, setBeatSessionSource } from '../file-cap/ordinary-turns.js';
import {
  noteChatTurnStarted,
  resetChatStartedTurns,
} from '../../../session/chat-messages/chat-started-turns.js';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const recent = new Date(NOW - 60_000).toISOString();

/** The store's scheduled runs: only `ses-run`. */
const store = {
  resolveTaskOrigins: (ids: string[]) =>
    new Map(ids.filter((id) => id === 'ses-run').map((id) => [id, {}] as const)),
} as never;

describe('ordinary turns for the row note', () => {
  afterEach(() => {
    sessions.length = 0;
    setBeatSessionSource(null);
    resetChatStartedTurns();
  });

  it('does not count beats, the run, or a chat a run’s message started', async () => {
    setBeatSessionSource(() => new Set(['ses-beat']));
    noteChatTurnStarted('ses-messaged', NOW, [{ fromSessionId: 'ses-run' }]);
    sessions.push(
      { id: 'ses-beat', updatedAt: recent },
      { id: 'ses-run', updatedAt: recent },
      { id: 'ses-messaged', updatedAt: recent }
    );
    expect(await liveOrdinaryTurns(store, () => NOW)('/agents/a', 'agent-a')).toBe(false);
  });

  it('counts a chat a person had with it lately, and not one older than a week', async () => {
    sessions.push({ id: 'ses-old', updatedAt: new Date(NOW - 8 * 86_400_000).toISOString() });
    expect(await liveOrdinaryTurns(store, () => NOW)('/agents/a', 'agent-a')).toBe(false);
    sessions.push({ id: 'ses-person', updatedAt: recent });
    expect(await liveOrdinaryTurns(store, () => NOW)('/agents/a', 'agent-a')).toBe(true);
  });
});

// @vitest-environment jsdom
/**
 * The hint over a channel's composer when no agent is in it (DOR-2823): shown
 * for an agentless local channel, and nowhere it would be wrong.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import {
  REACTION_FREQUENTS_DEFAULT,
  type RoomRosterEntry,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import { NoAgentHint } from '../ui/NoAgentHint';

afterEach(cleanup);

const HINT = 'No agent is in this channel to answer. Add one to get answers here.';

const you: RoomRosterEntry = {
  roomId: 'room-1',
  authorId: 'author-you',
  responseMode: 'always',
  joinedAt: '2026-10-10T09:00:00.000Z',
  joinedSeq: 0,
  lastReadSeq: 0,
  author: { id: 'author-you', kind: 'human', displayName: 'You', handle: null },
  origin: 'local',
};

const ana: RoomRosterEntry = {
  ...you,
  authorId: 'author-ana',
  responseMode: 'engaged',
  author: { id: 'author-ana', kind: 'agent', displayName: 'Ana', handle: 'ana' },
};

function roomWith(overrides: Partial<RoomWithRoster> = {}): RoomWithRoster {
  return {
    id: 'room-1',
    kind: 'channel',
    slug: 'general',
    title: '#general',
    topic: null,
    archived: false,
    ambientMaxEntries: 30,
    createdAt: '2026-10-10T09:00:00.000Z',
    lastActivityAt: '2026-10-10T10:00:00.000Z',
    members: [you],
    viewerAuthorId: 'author-you',
    reactionFrequents: [...REACTION_FREQUENTS_DEFAULT],
    ...overrides,
  };
}

function hint(): HTMLElement | null {
  return screen.queryByTestId('no-agent-hint');
}

describe('NoAgentHint', () => {
  it('says why nothing answers in a channel with no agent in it', () => {
    render(<NoAgentHint room={roomWith()} hasEntries onAddAgents={() => {}} />);
    expect(hint()).toHaveTextContent(HINT);
  });

  it('opens the agent picker from "Add one"', async () => {
    const onAddAgents = vi.fn();
    render(<NoAgentHint room={roomWith()} hasEntries onAddAgents={onAddAgents} />);
    await userEvent.click(screen.getByRole('button', { name: 'Add one' }));
    expect(onAddAgents).toHaveBeenCalledOnce();
  });

  it('is gone once an agent is in the channel', () => {
    render(
      <NoAgentHint room={roomWith({ members: [you, ana] })} hasEntries onAddAgents={() => {}} />
    );
    expect(hint()).toBeNull();
  });

  it('never shows in a DM', () => {
    render(
      <NoAgentHint room={roomWith({ kind: 'dm', slug: null })} hasEntries onAddAgents={() => {}} />
    );
    expect(hint()).toBeNull();
  });

  it('never shows in a channel bridged to an outside chat', () => {
    render(
      <NoAgentHint
        room={roomWith({ bridge: { visibility: 'full', platformTitle: 'Ops' } })}
        hasEntries
        onAddAgents={() => {}}
      />
    );
    expect(hint()).toBeNull();
  });

  it('leaves an empty channel to its own empty state', () => {
    render(<NoAgentHint room={roomWith()} hasEntries={false} onAddAgents={() => {}} />);
    expect(hint()).toBeNull();
  });

  it('stays out of an archived channel', () => {
    render(<NoAgentHint room={roomWith({ archived: true })} hasEntries onAddAgents={() => {}} />);
    expect(hint()).toBeNull();
  });
});

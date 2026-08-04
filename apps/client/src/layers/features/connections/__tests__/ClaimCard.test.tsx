/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import type { UnclaimedChat } from '@dorkos/shared/relay-schemas';
import { ClaimCard } from '../ui/ClaimCard';

afterEach(cleanup);

const AGENTS = [
  { id: 'dorkbot', name: 'DorkBot' },
  { id: 'auditor', name: 'security-auditor' },
];

function chat(overrides: Partial<UnclaimedChat> = {}): UnclaimedChat {
  return {
    id: 'uc-1',
    adapterId: 'telegram-1',
    chatId: '998877',
    channelType: 'dm',
    chatKind: 'dm',
    platformChatType: null,
    senderName: 'Miguel',
    senderId: '42',
    chatTitle: null,
    status: 'pending',
    messageCount: 1,
    firstSeenAt: '2026-08-03T10:00:00.000Z',
    lastSeenAt: '2026-08-03T10:00:00.000Z',
    decidedAt: null,
    decidedAgentId: null,
    ...overrides,
  };
}

function renderCard(c: UnclaimedChat, handlers: Partial<Record<string, () => void>> = {}) {
  const onClaim = vi.fn();
  const onIgnore = vi.fn();
  const onBlock = vi.fn();
  const onLeave = vi.fn();
  render(
    <ClaimCard
      chat={c}
      agentOptions={AGENTS}
      onClaim={onClaim}
      onIgnore={onIgnore}
      onBlock={onBlock}
      onLeave={onLeave}
      {...handlers}
    />
  );
  return { onClaim, onIgnore, onBlock, onLeave };
}

describe('ClaimCard', () => {
  it('names who wrote, without ever quoting them', () => {
    renderCard(chat());

    expect(screen.getByText('Miguel messaged your bot')).toBeInTheDocument();
    // The whole point: the card is built from identity metadata, so there is
    // no path by which a stranger's words could appear on this surface.
    expect(screen.getByText(/nothing has been read/i)).toBeInTheDocument();
  });

  it('says who added the bot, and to what, for a group', () => {
    renderCard(chat({ chatKind: 'group', senderName: 'Ana', chatTitle: 'Release train' }));

    expect(screen.getByText('Ana added your bot to “Release train”')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
  });

  it('falls back to a neutral subject rather than a blank when nobody is named', () => {
    renderCard(chat({ senderName: null }));

    expect(screen.getByText('Someone messaged your bot')).toBeInTheDocument();
  });

  it('counts repeats without re-notifying about them', () => {
    renderCard(chat({ messageCount: 7 }));

    expect(screen.getByText(/7 messages so far/i)).toBeInTheDocument();
  });

  it('cannot answer until an agent is chosen', () => {
    renderCard(chat());

    expect(screen.getByRole('button', { name: 'Answer in a channel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Answer privately' })).toBeDisabled();
  });

  it("offers 'Answer in a channel' as the primary action, calling onClaim with bridge: true", () => {
    const onClaim = vi.fn();
    render(
      <ClaimCard
        chat={chat()}
        agentOptions={[AGENTS[0]!]}
        onClaim={onClaim}
        onIgnore={vi.fn()}
        onBlock={vi.fn()}
        onLeave={vi.fn()}
      />
    );

    const answer = screen.getByRole('button', { name: 'Answer in a channel' });
    expect(answer).toBeEnabled();
    fireEvent.click(answer);
    expect(onClaim).toHaveBeenCalledWith('dorkbot', true);
  });

  it("offers 'Answer privately' as the secondary action, calling onClaim with bridge: false", () => {
    const onClaim = vi.fn();
    render(
      <ClaimCard
        chat={chat()}
        agentOptions={[AGENTS[0]!]}
        onClaim={onClaim}
        onIgnore={vi.fn()}
        onBlock={vi.fn()}
        onLeave={vi.fn()}
      />
    );

    const answerPrivately = screen.getByRole('button', { name: 'Answer privately' });
    expect(answerPrivately).toBeEnabled();
    fireEvent.click(answerPrivately);
    expect(onClaim).toHaveBeenCalledWith('dorkbot', false);
  });

  it('a group chat offers a single Join action that always bridges (DOR-883)', () => {
    renderCard(
      chat({
        chatKind: 'group',
        platformChatType: 'supergroup',
        senderName: 'Ana',
        chatTitle: 'Release train',
      })
    );

    expect(screen.getByText('Ana added your bot to “Release train”')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer in a channel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer privately' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });

  it('Join claims with bridge: true once an agent is picked', () => {
    const onClaim = vi.fn();
    render(
      <ClaimCard
        chat={chat({ chatKind: 'group', platformChatType: 'group' })}
        agentOptions={[AGENTS[0]!]}
        onClaim={onClaim}
        onIgnore={vi.fn()}
        onBlock={vi.fn()}
        onLeave={vi.fn()}
      />
    );

    // A single agent option pre-selects (`ClaimCard`'s own `useState` default),
    // so Join is enabled without any Select interaction.
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onClaim).toHaveBeenCalledWith('dorkbot', true);
  });

  it('Leave calls onLeave for a group', () => {
    const { onLeave } = renderCard(chat({ chatKind: 'group', platformChatType: 'group' }));

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onLeave).toHaveBeenCalled();
  });

  it('a broadcast channel offers only Ignore and Leave — no agent picker, no Join (DOR-883, DOR-907)', () => {
    renderCard(
      chat({
        chatKind: 'group',
        platformChatType: 'channel',
        senderName: 'Ana',
        chatTitle: 'Announcements',
      })
    );

    expect(screen.getByText('Ana added your bot to “Announcements”')).toBeInTheDocument();
    expect(screen.getByText(/broadcast channel/i)).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Block' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ignore' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
  });

  it('offers ignore and block without needing an agent first', () => {
    const { onIgnore, onBlock } = renderCard(chat());

    fireEvent.click(screen.getByRole('button', { name: 'Ignore' }));
    expect(onIgnore).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Block' }));
    expect(onBlock).toHaveBeenCalled();
  });

  it('locks every decision while one is in flight', () => {
    renderCard(chat(), { isDeciding: true } as never);

    expect(screen.getByRole('button', { name: 'Ignore' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Block' })).toBeDisabled();
  });

  it('locks Leave while a decision is in flight, for a group', () => {
    renderCard(chat({ chatKind: 'group', platformChatType: 'group' }), {
      isDeciding: true,
    } as never);

    expect(screen.getByRole('button', { name: 'Leave' })).toBeDisabled();
  });
});

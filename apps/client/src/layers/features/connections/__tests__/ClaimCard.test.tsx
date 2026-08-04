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
  render(
    <ClaimCard
      chat={c}
      agentOptions={AGENTS}
      onClaim={onClaim}
      onIgnore={onIgnore}
      onBlock={onBlock}
      {...handlers}
    />
  );
  return { onClaim, onIgnore, onBlock };
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
      />
    );

    const answerPrivately = screen.getByRole('button', { name: 'Answer privately' });
    expect(answerPrivately).toBeEnabled();
    fireEvent.click(answerPrivately);
    expect(onClaim).toHaveBeenCalledWith('dorkbot', false);
  });

  it('a group chat keeps its single Join action, unaffected by the primary/secondary split', () => {
    const onClaim = vi.fn();
    render(
      <ClaimCard
        chat={chat({ chatKind: 'group', senderName: 'Ana', chatTitle: 'Release train' })}
        agentOptions={[AGENTS[0]!]}
        onClaim={onClaim}
        onIgnore={vi.fn()}
        onBlock={vi.fn()}
      />
    );

    expect(screen.queryByRole('button', { name: 'Answer in a channel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer privately' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(onClaim).toHaveBeenCalledWith('dorkbot', false);
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
});

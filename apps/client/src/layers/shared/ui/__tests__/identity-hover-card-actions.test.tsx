// @vitest-environment jsdom
/**
 * The identity card's role, status and actions (DOR-3074): Message, Profile and
 * a session, and a click on the trigger opening the card where asked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { IdentityHoverCard, type IdentityHoverCardProps } from '../identity-hover-card';

afterEach(cleanup);

const SCOUT = { kind: 'agent' as const, displayName: 'Scout', handle: 'scout' };

function renderCard(props: Partial<IdentityHoverCardProps> = {}) {
  render(
    <IdentityHoverCard identity={SCOUT} {...props}>
      <span>Scout</span>
    </IdentityHoverCard>
  );
  return screen.getByText('Scout');
}

describe('IdentityHoverCard with actions', () => {
  it('draws the kind and role, the status, and Message before Profile', async () => {
    const user = userEvent.setup();
    const trigger = renderCard({
      about: { role: 'Reviews pull requests', status: 'Working in #launch' },
      actions: { onMessage: vi.fn(), onViewProfile: vi.fn() },
    });

    await user.hover(trigger);

    expect(await screen.findByText('Agent · Reviews pull requests')).toBeInTheDocument();
    expect(screen.getByText('Working in #launch')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').map((button) => button.textContent);
    expect(buttons).toEqual(['Message', 'Profile']);
    // The actions replace the single footer, never sit beside it.
    expect(screen.queryByText('View profile')).not.toBeInTheDocument();
  });

  it('runs the action pressed and closes the card', async () => {
    const user = userEvent.setup();
    const onMessage = vi.fn();
    const trigger = renderCard({ actions: { onMessage } });

    await user.hover(trigger);
    await user.click(await screen.findByRole('button', { name: 'Message' }));

    expect(onMessage).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
  });

  it('offers the session here only when handed one', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    const trigger = renderCard({
      actions: { onMessage: vi.fn(), session: { label: 'Session in #design', onOpen } },
    });

    await user.hover(trigger);
    await user.click(await screen.findByRole('button', { name: 'Session in #design' }));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('opens on a click of the trigger when asked to', async () => {
    const user = userEvent.setup({ delay: null });
    const trigger = renderCard({ openOnClick: true, actions: { onMessage: vi.fn() } });

    await user.click(trigger);

    expect(await screen.findByRole('button', { name: 'Message' })).toBeInTheDocument();
  });

  it('says when it opens, so a caller can wait to read until somebody looks', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const trigger = renderCard({ onOpenChange });

    await user.hover(trigger);
    await screen.findByText('View profile');

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('draws exactly today’s card when handed neither', async () => {
    const user = userEvent.setup();
    const trigger = renderCard();

    await user.hover(trigger);

    expect(await screen.findByText('View profile')).toBeInTheDocument();
    expect(screen.queryByText(/^Agent/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Message' })).not.toBeInTheDocument();
  });
});

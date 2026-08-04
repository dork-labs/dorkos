// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { IdentityHoverCard, type IdentityHoverCardDescriptor } from '../identity-hover-card';

afterEach(cleanup);

/** Opens the card by hovering its trigger, and waits for the content to mount. */
async function openOn(identity: IdentityHoverCardDescriptor) {
  const user = userEvent.setup();
  render(
    <IdentityHoverCard identity={identity}>
      <button type="button">{identity.displayName}</button>
    </IdentityHoverCard>
  );
  await user.hover(screen.getByRole('button', { name: identity.displayName }));
  return screen.findByText('View profile');
}

describe('IdentityHoverCard', () => {
  it('shows the @handle subtitle when there is one, and omits it entirely when there is not', async () => {
    await openOn({ kind: 'human', displayName: 'Ana', handle: 'ana' });
    expect(screen.getByText('@ana')).toBeInTheDocument();

    cleanup();
    await openOn({ kind: 'human', displayName: 'Ana' });
    expect(screen.queryByText(/^@/)).not.toBeInTheDocument();
  });

  it('marks "View profile" with a muted "soon" tag rather than making it clickable', async () => {
    await openOn({ kind: 'human', displayName: 'Ana', handle: 'ana' });
    expect(screen.getByText('View profile').closest('button, a')).toBeNull();
    expect(screen.getByText('soon')).toBeInTheDocument();
  });

  it("shows an agent's runtime/model and working chips, never a person's", async () => {
    await openOn({
      kind: 'agent',
      displayName: 'Warden',
      agent: { runtime: 'Claude Code', model: 'Opus 4.8', working: { forMs: 134_000 } },
    });

    expect(screen.getByText('Claude Code · Opus 4.8')).toBeInTheDocument();
    expect(screen.getByText(/^Working ·/)).toBeInTheDocument();
  });

  it("shows a person's origin chip, and an external platform name for a bridged person", async () => {
    await openOn({ kind: 'human', displayName: 'Priya', origin: { platform: 'Telegram' } });
    expect(screen.getByText('Telegram')).toBeInTheDocument();

    cleanup();
    await openOn({ kind: 'human', displayName: 'Ana', origin: 'local' });
    expect(screen.getByText('On this machine')).toBeInTheDocument();
  });
});

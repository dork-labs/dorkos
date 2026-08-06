// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TIMING } from '@/layers/shared/lib';
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

/**
 * Holds a pointer down on the trigger for the long-press threshold, the way
 * a finger does — `pointerType` decides whether this reads as a touch or a
 * mouse holding its button down.
 */
function pressAndHold(target: HTMLElement, pointerType: 'touch' | 'mouse') {
  vi.useFakeTimers();
  try {
    fireEvent.pointerDown(target, { button: 0, clientX: 10, clientY: 10, pointerType });
    act(() => {
      vi.advanceTimersByTime(TIMING.LONG_PRESS_MS + 50);
    });
  } finally {
    vi.useRealTimers();
  }
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

  describe('touch', () => {
    it('opens the same card on a touch long-press', async () => {
      render(
        <IdentityHoverCard identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}>
          <button type="button">Ana</button>
        </IdentityHoverCard>
      );

      pressAndHold(screen.getByRole('button', { name: 'Ana' }), 'touch');

      expect(await screen.findByText('View profile')).toBeInTheDocument();
      expect(screen.getByText('@ana')).toBeInTheDocument();
    });

    it('does not open on a quick tap — only a sustained hold opens it', () => {
      render(
        <IdentityHoverCard identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}>
          <button type="button">Ana</button>
        </IdentityHoverCard>
      );
      const trigger = screen.getByRole('button', { name: 'Ana' });

      fireEvent.pointerDown(trigger, { button: 0, clientX: 10, clientY: 10, pointerType: 'touch' });
      fireEvent.pointerUp(trigger);

      expect(screen.queryByText('View profile')).not.toBeInTheDocument();
    });

    it('never opens from a mouse holding the trigger down — long-press is touch-only', () => {
      // Hover already opens the card for a mouse, faster than any hold
      // threshold. This proves the long-press path itself doesn't ALSO fire
      // for a mouse button held down without a hover — the desktop pointer
      // gets no new way to open the card, only the one it already had.
      render(
        <IdentityHoverCard identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}>
          <button type="button">Ana</button>
        </IdentityHoverCard>
      );

      pressAndHold(screen.getByRole('button', { name: 'Ana' }), 'mouse');

      expect(screen.queryByText('View profile')).not.toBeInTheDocument();
    });

    it('does not open on a plain, hover-less click — no fake click affordance', () => {
      render(
        <IdentityHoverCard identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}>
          <button type="button">Ana</button>
        </IdentityHoverCard>
      );

      fireEvent.click(screen.getByRole('button', { name: 'Ana' }));

      expect(screen.queryByText('View profile')).not.toBeInTheDocument();
    });

    it('still opens on keyboard focus — the long-press wiring does not cost keyboard access', async () => {
      const user = userEvent.setup();
      render(
        <IdentityHoverCard identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}>
          <button type="button">Ana</button>
        </IdentityHoverCard>
      );

      await user.tab();
      expect(screen.getByRole('button', { name: 'Ana' })).toHaveFocus();
      expect(await screen.findByText('View profile')).toBeInTheDocument();
    });
  });
});

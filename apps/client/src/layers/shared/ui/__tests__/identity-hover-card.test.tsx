// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TIMING, LONG_PRESS_DRIFT_PX } from '@/layers/shared/lib';
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

/** A trigger button on its own — the shape every touch test below shares. */
function renderTrigger(
  identity: IdentityHoverCardDescriptor = { kind: 'human', displayName: 'Ana', handle: 'ana' }
): HTMLElement {
  render(
    <IdentityHoverCard identity={identity}>
      <button type="button">{identity.displayName}</button>
    </IdentityHoverCard>
  );
  return screen.getByRole('button', { name: identity.displayName });
}

/**
 * Runs `run` with fake timers installed for its ENTIRE duration — render
 * included, not just around whatever later calls `advanceTimersByTime`.
 *
 * **The trap this avoids:** Radix's `DismissableLayer` schedules its own real
 * `setTimeout(0)` the moment a card's content mounts, to arm
 * outside-pointerdown dismissal one tick after open (so it doesn't catch the
 * same press that opened it — see `@radix-ui/react-dismissable-layer`).
 * Faking the clock only AFTER that timer is already scheduled — e.g. inside a
 * helper called after `render` — leaves it running on the real clock,
 * invisible to `advanceTimersByTime`. That silently hands the wrong answer to
 * whatever a later test asserts about close behaviour. Installing fake timers
 * before `render` keeps every timer Radix schedules, from mount onward, on
 * the one fake clock this helper advances.
 *
 * Tests that assert actual dismiss behaviour (outside tap, Escape) use real
 * timers instead — see `realLongPressOpen` below — because that is the one
 * case fake time cannot stand in for even with this fix: `waitFor`'s own
 * polling needs the real clock to observe Radix's real timer firing.
 */
function withFakeTimers<T>(run: () => T): T {
  vi.useFakeTimers();
  try {
    return run();
  } finally {
    vi.useRealTimers();
  }
}

/** Presses `target` down and holds it past the long-press threshold, under fake time. */
function pressAndHold(target: HTMLElement, pointerType: 'touch' | 'mouse' | 'pen') {
  fireEvent.pointerDown(target, { button: 0, clientX: 10, clientY: 10, pointerType });
  act(() => {
    vi.advanceTimersByTime(TIMING.LONG_PRESS_MS + 50);
  });
}

/**
 * Holds a REAL touch press on `target` until the long-press threshold has
 * genuinely elapsed, then waits for the card to appear. Deliberately real
 * time rather than `advanceTimersByTime`: the lifecycle tests that use this
 * assert close behaviour riding Radix's own real `setTimeout(0)` arming (see
 * `withFakeTimers`'s doc) — faking the clock here would be asserting against
 * a listener that was never actually armed.
 */
async function realLongPressOpen(target: HTMLElement, findText = 'View profile') {
  fireEvent.pointerDown(target, { button: 0, clientX: 10, clientY: 10, pointerType: 'touch' });
  await screen.findByText(findText, {}, { timeout: TIMING.LONG_PRESS_MS + 500 });
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
    it('opens the same card on a touch long-press', () => {
      withFakeTimers(() => {
        const trigger = renderTrigger();
        pressAndHold(trigger, 'touch');
        expect(screen.getByText('View profile')).toBeInTheDocument();
        expect(screen.getByText('@ana')).toBeInTheDocument();
      });
    });

    it('opens on a pen long-press too — a stylus has no hover to open it with either', () => {
      withFakeTimers(() => {
        const trigger = renderTrigger();
        pressAndHold(trigger, 'pen');
        expect(screen.getByText('View profile')).toBeInTheDocument();
      });
    });

    it('does not open on a quick tap — releasing before the threshold cancels it', () => {
      withFakeTimers(() => {
        const trigger = renderTrigger();

        fireEvent.pointerDown(trigger, {
          button: 0,
          clientX: 10,
          clientY: 10,
          pointerType: 'touch',
        });
        fireEvent.pointerUp(trigger);
        // Advance PAST the threshold anyway — the only way to prove release
        // actually cancelled the timer, rather than this simply running
        // before a timer that was never given the chance to fire.
        act(() => {
          vi.advanceTimersByTime(TIMING.LONG_PRESS_MS + 50);
        });

        expect(screen.queryByText('View profile')).not.toBeInTheDocument();
      });
    });

    it('does not open when the pointer drifts past the hold — a scroll, not a hold', () => {
      withFakeTimers(() => {
        const trigger = renderTrigger();

        fireEvent.pointerDown(trigger, {
          button: 0,
          clientX: 10,
          clientY: 10,
          pointerType: 'touch',
        });
        fireEvent.pointerMove(trigger, {
          button: 0,
          clientX: 10,
          clientY: 10 + LONG_PRESS_DRIFT_PX + 5,
          pointerType: 'touch',
        });
        act(() => {
          vi.advanceTimersByTime(TIMING.LONG_PRESS_MS + 50);
        });

        expect(screen.queryByText('View profile')).not.toBeInTheDocument();
      });
    });

    it('never opens from a mouse holding the trigger down — long-press is touch/pen-only', () => {
      // Hover already opens the card for a mouse, faster than any hold
      // threshold. This proves the long-press path itself doesn't ALSO fire
      // for a mouse button held down without a hover — the desktop pointer
      // gets no new way to open the card, only the one it already had.
      withFakeTimers(() => {
        const trigger = renderTrigger();
        pressAndHold(trigger, 'mouse');
        expect(screen.queryByText('View profile')).not.toBeInTheDocument();
      });
    });

    it('does not open on a plain, hover-less click — no fake click affordance', () => {
      const trigger = renderTrigger();
      fireEvent.click(trigger);
      expect(screen.queryByText('View profile')).not.toBeInTheDocument();
    });

    it('still opens on keyboard focus — the long-press wiring does not cost keyboard access', async () => {
      const user = userEvent.setup();
      const trigger = renderTrigger();

      await user.tab();

      expect(trigger).toHaveFocus();
      expect(await screen.findByText('View profile')).toBeInTheDocument();
    });
  });

  describe('touch — open lifecycle (real timers)', () => {
    it('stays open once the finger lifts — release does not close it', async () => {
      const trigger = renderTrigger();
      await realLongPressOpen(trigger);

      fireEvent.pointerUp(trigger);

      expect(screen.getByText('View profile')).toBeInTheDocument();
    });

    it('closes on a pointer press outside the card', async () => {
      const trigger = renderTrigger();
      await realLongPressOpen(trigger);
      fireEvent.pointerUp(trigger);

      fireEvent.pointerDown(document.body);

      await waitFor(() => expect(screen.queryByText('View profile')).not.toBeInTheDocument());
    });

    it('closes on Escape', async () => {
      const trigger = renderTrigger();
      await realLongPressOpen(trigger);
      fireEvent.pointerUp(trigger);

      fireEvent.keyDown(document, { key: 'Escape' });

      await waitFor(() => expect(screen.queryByText('View profile')).not.toBeInTheDocument());
    });

    it('keeps only one card open at a time — opening a second closes the first', async () => {
      render(
        <div>
          <IdentityHoverCard identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}>
            <button type="button">Ana</button>
          </IdentityHoverCard>
          <IdentityHoverCard identity={{ kind: 'human', displayName: 'Bo', handle: 'bo' }}>
            <button type="button">Bo</button>
          </IdentityHoverCard>
        </div>
      );
      const anaTrigger = screen.getByRole('button', { name: 'Ana' });
      const boTrigger = screen.getByRole('button', { name: 'Bo' });

      await realLongPressOpen(anaTrigger, '@ana');
      fireEvent.pointerUp(anaTrigger);
      expect(screen.getByText('@ana')).toBeInTheDocument();

      await realLongPressOpen(boTrigger, '@bo');
      fireEvent.pointerUp(boTrigger);

      expect(screen.getByText('@bo')).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByText('@ana')).not.toBeInTheDocument());
    });
  });
});

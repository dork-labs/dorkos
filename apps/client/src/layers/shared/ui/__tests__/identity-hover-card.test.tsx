// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TIMING, LONG_PRESS_DRIFT_PX } from '@/layers/shared/lib/constants';
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
    // And it does not DRESS as one either. Brand orange means interaction or
    // action; an inert line wearing it is an affordance wired to nothing —
    // the first thing an architect reading the source notices.
    expect(screen.getByText('View profile').className).not.toContain('text-brand');
    expect(screen.getByText('View profile').className).toContain('text-muted-foreground');
  });

  it('gives "View profile" the brand colour back once it is a real control', async () => {
    // Orange is earned by doing something. The wired branch does.
    const user = userEvent.setup();
    render(
      <IdentityHoverCard
        identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}
        onViewProfile={vi.fn()}
      >
        <button type="button">Ana</button>
      </IdentityHoverCard>
    );
    await user.hover(screen.getByRole('button', { name: 'Ana' }));

    const viewProfile = await screen.findByRole('button', { name: 'View profile' });
    expect(viewProfile.className).toContain('text-brand');
  });

  it('turns "View profile" into a real control once a destination is supplied', async () => {
    const onViewProfile = vi.fn();
    const user = userEvent.setup();
    render(
      <IdentityHoverCard
        identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}
        onViewProfile={onViewProfile}
      >
        <button type="button">Ana</button>
      </IdentityHoverCard>
    );
    await user.hover(screen.getByRole('button', { name: 'Ana' }));

    const viewProfile = await screen.findByRole('button', { name: 'View profile' });
    // The deferred marker is what a wired footer must no longer be able to show:
    // "soon" beside a button that works is a promise the product already kept.
    expect(screen.queryByText('soon')).not.toBeInTheDocument();

    await user.click(viewProfile);
    expect(onViewProfile).toHaveBeenCalledTimes(1);
  });

  it('refocuses the trigger before opening the profile, not the footer button (DOR-1274 adversarial review)', async () => {
    // Clicking the footer moves native browser focus onto the FOOTER first —
    // default click behaviour, before `onClick` ever runs — and the footer is
    // portalled inside `HoverCardContent`, which unmounts the instant this
    // card closes. Anything downstream that captures `document.activeElement`
    // when `onViewProfile` fires (`useProfileDeepLink`'s `open()`) would grab
    // a node already gone by the time it is asked for back, unless this
    // component puts focus back on its OWN trigger first. Asserted by reading
    // `document.activeElement` from inside `onViewProfile` itself — the exact
    // moment the downstream capture would run.
    let activeElementAtCallTime: Element | null = null;
    const onViewProfile = vi.fn(() => {
      activeElementAtCallTime = document.activeElement;
    });
    const user = userEvent.setup();
    render(
      <IdentityHoverCard
        identity={{ kind: 'human', displayName: 'Ana', handle: 'ana' }}
        onViewProfile={onViewProfile}
      >
        <button type="button">Ana</button>
      </IdentityHoverCard>
    );
    const trigger = screen.getByRole('button', { name: 'Ana' });
    await user.hover(trigger);

    const viewProfile = await screen.findByRole('button', { name: 'View profile' });
    await user.click(viewProfile);

    expect(onViewProfile).toHaveBeenCalledTimes(1);
    expect(activeElementAtCallTime).toBe(trigger);
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

  it('pulses the avatar itself while an agent works, and only there', async () => {
    // The card drew its own dot inside the chip — a third hand-rolled copy of
    // the same eight lines, and two marks for one fact. It rides
    // `IdentityAvatar`'s `working` slot now. Red if a second pulse comes back,
    // and red if the disc stops carrying the one that is left.
    await openOn({
      kind: 'agent',
      displayName: 'Warden',
      agent: { working: { forMs: 134_000 } },
    });

    expect(document.querySelectorAll('.animate-ping')).toHaveLength(1);
    expect(document.querySelector('[data-slot="identity-avatar"] .animate-ping')).not.toBeNull();

    cleanup();
    await openOn({ kind: 'agent', displayName: 'Warden' });
    expect(document.querySelector('.animate-ping')).toBeNull();
  });

  it('asks one question about working, so the dot and the chip can never disagree', () => {
    // The disc tested `working !== undefined` and the chip tested it for truth.
    // Anything present-but-falsy — a resolver that fills the field with `null`
    // when there is no turn — lit a pulsing "working right now" dot beside no
    // chip at all, which is a claim the card itself does not repeat.
    const withNullWorking = {
      kind: 'agent',
      displayName: 'Warden',
      agent: { working: null },
    } as unknown as IdentityHoverCardDescriptor;

    return openOn(withNullWorking).then(() => {
      expect(document.querySelector('[data-slot="identity-avatar"] .animate-ping')).toBeNull();
      expect(screen.queryByText(/^Working ·/)).not.toBeInTheDocument();
    });
  });

  it("draws the identity's photo on the card's disc, and the emoji when there is none", async () => {
    // The descriptor field the one production caller (`MentionPillRenderer`)
    // fills. Red if the card stops passing it down: the message gutter reads
    // the same render cache, so a card that dropped the photo would describe
    // somebody with a different face than the messages beside it.
    const PHOTO = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    await openOn({ kind: 'human', displayName: 'Dorian', emoji: '🐙', imageUrl: PHOTO });

    const disc = document.querySelector('[data-slot="identity-avatar"]')!;
    expect(disc.querySelector('img')).toHaveAttribute('src', PHOTO);
    expect(disc).not.toHaveTextContent('🐙');

    cleanup();
    await openOn({ kind: 'human', displayName: 'Dorian', emoji: '🐙' });

    const without = document.querySelector('[data-slot="identity-avatar"]')!;
    expect(without.querySelector('img')).toBeNull();
    expect(without).toHaveTextContent('🐙');
  });

  it("shows a person's origin chip, and an external platform name for a bridged person", async () => {
    await openOn({ kind: 'human', displayName: 'Priya', origin: { platform: 'Telegram' } });
    expect(screen.getByText('Telegram')).toBeInTheDocument();

    cleanup();
    await openOn({ kind: 'human', displayName: 'Ana', origin: 'local' });
    expect(screen.getByText('On this machine')).toBeInTheDocument();
  });

  describe('owner attribution — the managed-by chip', () => {
    it('shows "Managed by @handle" for an agent with an addressable owner', async () => {
      await openOn({
        kind: 'agent',
        displayName: 'Warden',
        agent: { managedBy: { displayName: 'Dorian', handle: 'dorian' } },
      });

      expect(screen.getByText('Managed by @dorian')).toBeInTheDocument();
    });

    it('falls back to the display name rather than a bare "@" when the owner has no handle', async () => {
      await openOn({
        kind: 'agent',
        displayName: 'Warden',
        agent: { managedBy: { displayName: 'Dorian', handle: null } },
      });

      expect(screen.getByText('Managed by Dorian')).toBeInTheDocument();
      expect(screen.queryByText(/^Managed by @/)).not.toBeInTheDocument();
    });

    it('draws no chip at all when the agent has no known owner', async () => {
      await openOn({ kind: 'agent', displayName: 'Warden', agent: { runtime: 'Claude Code' } });

      expect(screen.queryByText(/^Managed by/)).not.toBeInTheDocument();
    });

    it('never shows the chip for a person, even one that happens to carry the field', async () => {
      // `managedBy` only ever means something on an agent; a human descriptor
      // has no `agent` field to carry it, so this pins that the chip is gated
      // on `kind`, not just on the field being present.
      await openOn({ kind: 'human', displayName: 'Ana', handle: 'ana' });

      expect(screen.queryByText(/^Managed by/)).not.toBeInTheDocument();
    });
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
      // Rides Radix's own cross-instance dismissal, not any bookkeeping of
      // this component's own: pressing Bo's trigger is an outside `pointerdown`
      // for Ana's still-open `DismissableLayer`, which closes it the same way
      // it would close for a press anywhere else outside it.
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

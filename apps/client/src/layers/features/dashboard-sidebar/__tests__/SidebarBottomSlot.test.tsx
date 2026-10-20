// @vitest-environment jsdom
/**
 * The cockpit's bottom-slot PRIORITY: getting started > update > identity
 * prompt > profile prompt > the DorkOS community offer > promo (spec
 * `sidebar-simplification` D4, DOR-2873).
 *
 * `bottom-slot.test.tsx` proves the arbiter picks the first candidate whose
 * `show` is true. That is a mechanism; this is the product decision — that a
 * blocked setup beats a version nudge beats a profile nicety beats marketing —
 * and it lives in the ORDER of the array `SidebarBottomSlot` builds. Nothing
 * else in the suite reads that order, so reordering it silently changed what
 * the panel offers on day one until this existed.
 *
 * The four gates are mocked because each is a different server read; what is
 * under test is which card wins when several qualify at once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ── The four gates, each independently switchable ──
let gettingStarted = false;
let updateReady = false;
let updateKind: 'command' | 'desktop-install-failed' = 'command';
let identityVisible = false;
let profileVisible = false;
let promoQualifies = false;
/** The first run's offer to join the official DorkOS space is due (DOR-2873). */
let spaceOffer = false;
/** Its connection list is still loading, so it may yet become due. */
let spaceOfferPending = false;

// A settled panel, so these cases are about what they are named after rather
// than about the boot gate. The gate's own behaviour is covered in
// `model/boot/__tests__` (spec `sidebar-simplification` D6).
vi.mock('../model/boot/use-boot-state', () => ({
  useBootState: () => ({ phase: 'settled', settled: true, fleetKnown: true, startedWarm: false }),
}));

vi.mock('@/layers/features/onboarding', () => ({
  useOnboarding: () => ({
    shouldShowGettingStarted: gettingStarted,
    dismiss: vi.fn(),
    isLoading: false,
  }),
  useIdentityPrompt: () => ({ visible: identityVisible }),
  useProfilePrompt: () => ({ visible: profileVisible }),
  ProgressCard: () => <div data-testid="card-getting-started" />,
  IdentityPromptCard: () => <div data-testid="card-identity-prompt" />,
  ProfilePromptCard: () => <div data-testid="card-profile-prompt" />,
  useFirstRunSpaceOffer: () => ({ due: spaceOffer, pending: spaceOfferPending }),
}));

vi.mock('@/layers/entities/community', () => ({
  OfficialSpaceOfferCard: () => <div data-testid="card-official-space-offer" />,
}));

vi.mock('@/layers/features/feature-promos', () => ({
  usePromoCandidate: () => ({
    id: 'promo:test',
    show: promoQualifies,
    render: () => <div data-testid="card-promo" />,
  }),
}));

vi.mock('@/layers/entities/config', () => ({
  useConfig: () => ({ isLoading: false }),
}));

/**
 * The readiness the slot is gating on this test.
 *
 * A kind rather than a boolean because the gate is `kind !== 'none'`, and a
 * failed desktop install has to clear it exactly as a waiting restart does
 * (spec `desktop-updater-overhaul` D5) — a new kind that resolved to `none`
 * would be invisible however good its copy was.
 */
function currentUpdate(): { kind: string; latestVersion?: string; downloadFresh?: () => void } {
  if (!updateReady) return { kind: 'none' };
  if (updateKind === 'desktop-install-failed') {
    return { kind: 'desktop-install-failed', downloadFresh: vi.fn() };
  }
  return { kind: 'command', latestVersion: '9.9.9' };
}

vi.mock('../ui/bottom-slot/use-update-ready', () => ({
  useUpdateReady: () => currentUpdate(),
}));

vi.mock('../ui/bottom-slot/UpdatePill', () => ({
  UpdatePill: () => <div data-testid="card-update" />,
}));

import { SidebarBottomSlot } from '../ui/bottom-slot/SidebarBottomSlot';

/** Every card the slot can draw, in the priority order under test. */
const RUNGS = [
  'getting-started',
  'update',
  'identity-prompt',
  'profile-prompt',
  'official-space-offer',
  'promo',
] as const;

/** Which card the slot actually drew, or `null`. */
function drawn(): string | null {
  for (const rung of RUNGS) {
    if (screen.queryByTestId(`card-${rung}`) !== null) return rung;
  }
  return null;
}

beforeEach(() => {
  gettingStarted = false;
  updateReady = false;
  updateKind = 'command';
  identityVisible = false;
  profileVisible = false;
  promoQualifies = false;
  spaceOffer = false;
  spaceOfferPending = false;
});

afterEach(() => cleanup());

describe('SidebarBottomSlot priority', () => {
  it('gives the slot to getting started when every card qualifies', () => {
    gettingStarted = updateReady = identityVisible = profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('getting-started');
  });

  it('falls to the update pill once getting started is done', () => {
    updateReady = profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('update');
  });

  it('gives the slot to a failed desktop install, exactly as to a waiting update', () => {
    updateKind = 'desktop-install-failed';
    updateReady = profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('update');
  });

  it('asks who you are before what you do (DOR-677)', () => {
    identityVisible = profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('identity-prompt');
  });

  it('falls to the profile prompt once there is no update waiting', () => {
    profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('profile-prompt');
  });

  it('offers a promo only when nothing above it wants the slot', () => {
    promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('promo');
  });

  it('draws nothing when no card qualifies', () => {
    render(<SidebarBottomSlot />);
    expect(drawn()).toBeNull();
  });

  it('peels rung by rung, in exactly this order', () => {
    // The ladder as one assertion, so a reordering shows up as a diff of the
    // whole sequence rather than as one confusing failure.
    const winners: (string | null)[] = [];
    for (let peeled = 0; peeled < RUNGS.length; peeled++) {
      // Everything from `peeled` down still qualifies; everything above it is
      // done. So the winner must be exactly `RUNGS[peeled]`.
      gettingStarted = peeled <= 0;
      updateReady = peeled <= 1;
      identityVisible = peeled <= 2;
      profileVisible = peeled <= 3;
      spaceOffer = peeled <= 4;
      promoQualifies = true;
      render(<SidebarBottomSlot />);
      winners.push(drawn());
      cleanup();
    }
    expect(winners).toEqual([...RUNGS]);
  });

  describe('the offer to join the DorkOS community (DOR-2873)', () => {
    it('waits for the name and role prompts once the card is gone, then takes the slot', () => {
      identityVisible = profileVisible = spaceOffer = promoQualifies = true;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBe('identity-prompt');
      cleanup();

      // The name was answered or skipped; the role question is next.
      identityVisible = false;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBe('profile-prompt');
      cleanup();

      // Both answered or skipped: the community comes before marketing.
      profileVisible = false;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBe('official-space-offer');
    });

    it('rides inside the Getting started card while it shows, never here as well', () => {
      gettingStarted = spaceOffer = true;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBe('getting-started');
      expect(screen.queryByTestId('card-official-space-offer')).toBeNull();
    });

    it('takes its turn once the Getting started card is dismissed', () => {
      spaceOffer = promoQualifies = true;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBe('official-space-offer');
    });

    it('holds a promo back while the offer may still arrive, so the two never swap', () => {
      promoQualifies = spaceOfferPending = true;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBeNull();
      cleanup();

      // The list answered: joined or skipped elsewhere, so the promo has its turn.
      spaceOfferPending = false;
      render(<SidebarBottomSlot />);
      expect(drawn()).toBe('promo');
    });

    it('stays dormant while the offer is not due (no official space, joined or skipped)', () => {
      render(<SidebarBottomSlot />);
      expect(drawn()).toBeNull();
    });
  });
});

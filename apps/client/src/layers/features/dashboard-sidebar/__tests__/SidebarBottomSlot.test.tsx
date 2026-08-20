// @vitest-environment jsdom
/**
 * The cockpit's bottom-slot PRIORITY: getting started > update > profile prompt
 * > promo (spec `sidebar-simplification` D4).
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
let profileVisible = false;
let promoQualifies = false;

vi.mock('@/layers/features/onboarding', () => ({
  useOnboarding: () => ({
    shouldShowGettingStarted: gettingStarted,
    dismiss: vi.fn(),
    isLoading: false,
  }),
  useProfilePrompt: () => ({ visible: profileVisible }),
  ProgressCard: () => <div data-testid="card-getting-started" />,
  ProfilePromptCard: () => <div data-testid="card-profile-prompt" />,
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

vi.mock('../ui/bottom-slot/use-update-ready', () => ({
  useUpdateReady: () =>
    updateReady ? { kind: 'command', latestVersion: '9.9.9' } : { kind: 'none' },
}));

vi.mock('../ui/bottom-slot/UpdatePill', () => ({
  UpdatePill: () => <div data-testid="card-update" />,
}));

import { SidebarBottomSlot } from '../ui/bottom-slot/SidebarBottomSlot';

/** Every card the slot can draw, in the priority order under test. */
const RUNGS = ['getting-started', 'update', 'profile-prompt', 'promo'] as const;

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
  profileVisible = false;
  promoQualifies = false;
});

afterEach(() => cleanup());

describe('SidebarBottomSlot priority', () => {
  it('gives the slot to getting started when all four qualify', () => {
    gettingStarted = updateReady = profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('getting-started');
  });

  it('falls to the update pill once getting started is done', () => {
    updateReady = profileVisible = promoQualifies = true;
    render(<SidebarBottomSlot />);
    expect(drawn()).toBe('update');
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
      profileVisible = peeled <= 2;
      promoQualifies = true;
      render(<SidebarBottomSlot />);
      winners.push(drawn());
      cleanup();
    }
    expect(winners).toEqual([...RUNGS]);
  });
});

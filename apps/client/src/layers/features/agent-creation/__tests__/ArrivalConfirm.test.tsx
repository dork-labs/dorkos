/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { PreviewSchedule } from '@dorkos/shared/marketplace-schemas';
import { ResponsiveDialog, ResponsiveDialogContent } from '@/layers/shared/ui';
import type { CreationSeed } from '@/layers/shared/model';
import { ArrivalConfirm } from '../ui/ArrivalConfirm';

// ---------------------------------------------------------------------------
// jsdom polyfill — ResponsiveDialogContent reads useIsMobile (matchMedia).
// ---------------------------------------------------------------------------

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSeed(overrides: Partial<CreationSeed['template']> = {}): CreationSeed {
  return {
    origin: 'marketplace-agent',
    sourceLabel: 'DorkOS Marketplace',
    template: {
      displayName: 'Reviewer',
      persona: 'I review pull requests.',
      ...overrides,
    },
  };
}

/** The offer-disclosure props, defaulted to "checked, nothing scheduled". */
interface OfferProps {
  packageSchedules?: PreviewSchedule[];
  isCheckingOffer?: boolean;
  offerCheckFailed?: boolean;
}

function renderArrival(seed: CreationSeed, offer: OfferProps = {}) {
  return render(
    <ResponsiveDialog open onOpenChange={() => {}}>
      <ResponsiveDialogContent>
        <ArrivalConfirm
          seed={seed}
          packageSchedules={offer.packageSchedules ?? []}
          isCheckingOffer={offer.isCheckingOffer ?? false}
          offerCheckFailed={offer.offerCheckFailed ?? false}
          resolvedDirectory="/home/me/.dork/agents/reviewer"
          canSubmit
          isCreating={false}
          onCreate={() => {}}
          onCustomize={() => {}}
          onNotNow={() => {}}
        />
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ArrivalConfirm — avatar face', () => {
  afterEach(cleanup);

  it('renders the seeded emoji face when the offer carries an emoji icon', () => {
    renderArrival(makeSeed({ icon: '🔍' }));

    // The emoji is the face — the same language M3's picker and AgentPreviewCard use.
    expect(screen.getByText('🔍')).toBeInTheDocument();
    // The letter initial is NOT used when an emoji is present.
    expect(screen.queryByText('R')).not.toBeInTheDocument();
  });

  it("falls back to the name's initial when the seed has no icon", () => {
    renderArrival(makeSeed({ displayName: 'Reviewer' }));

    expect(screen.getByText('R')).toBeInTheDocument();
  });

  it('falls back to the initial when the icon is not a single emoji', () => {
    // An arbitrary (non-emoji) identifier is not a valid face seed.
    renderArrival(makeSeed({ displayName: 'Reviewer', icon: 'robot-icon' }));

    expect(screen.getByText('R')).toBeInTheDocument();
    expect(screen.queryByText('robot-icon')).not.toBeInTheDocument();
  });
});

describe('ArrivalConfirm — what the package runs on its own (DOR-644)', () => {
  afterEach(cleanup);

  it('names the cadence and the effective permission mode of a packaged schedule', () => {
    renderArrival(makeSeed(), {
      // What the server sends after `clampSchedulePermissionMode` has already
      // refused the `bypassPermissions` this package's SKILL.md asked for.
      packageSchedules: [
        {
          name: 'overnight-sweep',
          cron: '0 3 * * *',
          permissionMode: 'acceptEdits',
          startsEnabled: true,
        },
      ],
    });

    const row = screen.getByTestId('arrival-package-schedules');
    expect(row).toHaveTextContent('overnight-sweep');
    expect(row).toHaveTextContent('At 03:00 AM');
    expect(row).toHaveTextContent('waits for your approval before its first run');
    // The mode in plain words — the fact that decides how much an unattended
    // job may do, and the one nothing in this flow used to show at all.
    expect(row).toHaveTextContent('can change files on its own');
  });

  it('never claims a packaged job starts switched on, because none can', () => {
    // `schedule.enabled: true` in a SKILL.md is the author's intent, not
    // permission: every package schedule reaches its row through
    // `upsertFromFile({ source: 'discovery' })`, and `resolveFileArmStatus`
    // parks EVERY first sighting at `pending_approval`. Saying "starts switched
    // on" would assert exactly the alarming thing that cannot happen — and would
    // contradict this card's own "has to be approved before it runs" copy.
    renderArrival(makeSeed(), {
      packageSchedules: [
        { name: 'eager', cron: '0 3 * * *', permissionMode: 'acceptEdits', startsEnabled: true },
      ],
    });

    expect(screen.getByTestId('arrival-package-schedules')).not.toHaveTextContent(
      'starts switched on'
    );
  });

  it('says a job runs only when asked rather than inventing a cadence', () => {
    renderArrival(makeSeed(), {
      packageSchedules: [
        { name: 'manual-audit', cron: null, permissionMode: 'plan', startsEnabled: false },
      ],
    });

    const row = screen.getByTestId('arrival-package-schedules');
    expect(row).toHaveTextContent('Runs only when you ask');
    expect(row).toHaveTextContent('arrives switched off');
    expect(row).toHaveTextContent('can only read and plan');
  });

  it('shows no schedule row at all for an offer that schedules nothing', () => {
    renderArrival(makeSeed());

    expect(screen.queryByTestId('arrival-package-schedules')).not.toBeInTheDocument();
    expect(screen.queryByTestId('arrival-offer-check-failed')).not.toBeInTheDocument();
  });

  it('holds the create button until it knows what the package runs', () => {
    renderArrival(makeSeed(), { isCheckingOffer: true });

    expect(screen.getByTestId('arrival-create')).toBeDisabled();
    expect(screen.getByTestId('arrival-checking-offer')).toBeInTheDocument();
  });

  it('says the check failed rather than rendering it as "nothing scheduled"', () => {
    renderArrival(makeSeed(), { offerCheckFailed: true });

    expect(screen.getByTestId('arrival-offer-check-failed')).toBeInTheDocument();
    // A failed check does not trap the person: nothing the package brings can
    // arm itself without a separate approval once the agent exists.
    expect(screen.getByTestId('arrival-create')).toBeEnabled();
  });

  it("leaves a Shape offer's own cadence line untouched", () => {
    renderArrival(makeSeed({ schedule: 'Every weekday at 9:00 AM' }));

    expect(screen.getByTestId('arrival-schedule')).toHaveTextContent('Every weekday at 9:00 AM');
    expect(screen.queryByTestId('arrival-package-schedules')).not.toBeInTheDocument();
  });
});

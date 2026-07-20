/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
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

function renderArrival(seed: CreationSeed) {
  return render(
    <ResponsiveDialog open onOpenChange={() => {}}>
      <ResponsiveDialogContent>
        <ArrivalConfirm
          seed={seed}
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
